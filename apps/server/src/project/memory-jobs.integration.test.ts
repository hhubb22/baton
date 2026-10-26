import { randomUUID } from 'node:crypto'
import { Effect, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as P from '@baton/protocol'
import { expect, it } from 'vite-plus/test'
import { seedNode, withTestDatabase } from '../testing/database.ts'
import { contextualRuntimeRequest } from '../testing/project-context.ts'
import * as projects from './projects.ts'
import { runtimeRequest } from './runtime.ts'
import { scheduleMemoryJobs } from './memory-jobs.ts'
import { listProjectMemory } from './memory/index.ts'

it('registers the final reply before finish and commits source-bound background progress independently', async () => {
  await withTestDatabase(async ({ run }) => {
    const node = await seedNode(run, {
      report: {
        roots: [],
        repos: [],
        exec: { enabled: false, shell: '/bin/sh' },
        project_runtime: {
          version: '0.1.0',
          memory_protocol: 1,
          max_concurrent_projects: 1,
          providers: [{ provider: 'openai-codex', status: 'available' }],
        },
      },
    })
    const project = await run(
      projects.createProject(node.employeeId, {
        title: 'Memory',
        goal: '',
        provider: 'openai-codex',
        model: 'fake-model',
      }),
    )
    await run(
      projects.acceptProjectMessage(node.employeeId, project.id, {
        client_message_id: randomUUID(),
        content: '测试使用 pnpm test:unit。',
      }),
    )
    await run(projects.scheduleProjectRun(project.agent.id))
    const [front] = await run(projects.claimProjectCommands('project_run_start'))
    const identity = { run_id: front!.command.run_id, lease_epoch: front!.command.lease_epoch }
    const rpc = (operation: P.ProjectRuntimeRequest['operation'], extra: Partial<P.ProjectRuntimeRequest> = {}) =>
      run(contextualRuntimeRequest(node.source, { type: 'project_runtime.request', ...identity, operation, ...extra }))
    await rpc('claim_inputs', { last_seq: 0 })
    const response = {
      last_seq: 1,
      client_event_id: 'final',
      payload: {
        format: 'pi-ai/1',
        message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '已确认测试入口。' }] },
      },
    } as const
    await rpc('append_event', response)
    await rpc('append_event', response)
    const jobs = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{
          state: string
          through_seq: number
        }>`SELECT state,through_seq::float8 AS through_seq FROM project_memory_jobs WHERE project_id=${project.id}`
      }),
    )
    expect(jobs).toEqual([{ state: 'pending', through_seq: 2 }])
    await rpc('finish')
    await rpc('stopped')
    await run(scheduleMemoryJobs())
    const [background] = await run(projects.claimProjectCommands('project_memory_start'))
    expect(background?.command.memory_kind).toBe('consolidation')
    const memory = (operation: P.ProjectRuntimeRequest['operation'], payload?: P.ProjectRuntimeRequest['payload']) =>
      run(
        runtimeRequest(node.source, {
          type: 'project_runtime.request',
          run_id: background!.command.run_id,
          lease_epoch: background!.command.lease_epoch,
          operation,
          ...(payload ? { payload } : {}),
        }),
      )
    const page = Schema.decodeUnknownSync(
      Schema.Struct({
        cursor_index: Schema.Int,
        cursor_offset: Schema.Int,
        source: Schema.Struct({
          id: Schema.String,
          source_hash: Schema.String,
          offset: Schema.Int,
          next_offset: Schema.Int,
          text: Schema.String,
          role: Schema.String,
        }),
      }),
    )(await memory('read_sources'))
    expect(page.source.role).toBe('user')
    const commit = {
      cursor_index: page.cursor_index,
      cursor_offset: page.cursor_offset,
      changes: [
        {
          action: 'add',
          expected_revision: 0,
          content: { title: '测试入口', content: page.source.text, kind: 'lesson' },
          evidence: [
            {
              source_id: page.source.id,
              source_hash: page.source.source_hash,
              start_byte: page.source.offset,
              end_byte: page.source.next_offset,
            },
          ],
        },
      ],
    }
    const receipt = await memory('commit_chunk', commit)
    expect(await memory('commit_chunk', commit)).toEqual(receipt)
    await memory('commit_chunk', { cursor_index: 1, cursor_offset: 0, changes: [] })
    await memory('finish')
    await memory('stopped')
    const entries = await run(listProjectMemory(node.employeeId, project.id))
    expect(entries.entries).toHaveLength(1)
    expect(entries.entries![0]!.content).toBe('测试使用 pnpm test:unit。')
    const [state] = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{
          state: string
          cursor_index: number
          failure_count: number
        }>`SELECT j.state,j.cursor_index,c.failure_count FROM project_memory_jobs j JOIN conversations c ON c.id=j.conversation_id WHERE j.project_id=${project.id}`
      }),
    )
    expect(state).toEqual({ state: 'completed', cursor_index: 2, failure_count: 0 })
  })
})
