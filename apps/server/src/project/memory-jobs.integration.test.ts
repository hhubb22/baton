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
import { changeProjectMemory, listProjectMemory, writeProjectMemory } from './memory/index.ts'

it('keeps an embedding claim on another device when the chat source is device-bound', async () => {
  await withTestDatabase(async ({ run }) => {
    const report: P.RuntimeReport = {
      roots: [],
      repos: [],
      exec: { enabled: false, shell: '/bin/sh' },
      project_runtime: { version: '0.1.0', memory_protocol: 1, providers: [] },
    }
    const owner = await seedNode(run, { report, online: false })
    const other = await seedNode(run, { employeeId: owner.employeeId, report })
    const project = await run(
      projects.createProject(owner.employeeId, {
        title: 'Embedding',
        provider: `api-${randomUUID()}`,
        model: 'chat',
        source_node_id: owner.nodeId,
        memory_embedding: { base_url: 'http://localhost:4321/v1', model: 'embedding' },
      }),
    )
    const id = randomUUID()
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO project_memory_jobs(id,employee_id,project_id,conversation_id,kind,input_seq,through_seq) VALUES(${id},${owner.employeeId},${project.id},${project.conversation.id},'embedding',0,0)`
      }),
    )
    await run(scheduleMemoryJobs())
    const [first] = await run(projects.claimProjectCommands('project_memory_start'))
    expect(first?.node_id).toBe(other.nodeId)
    await run(scheduleMemoryJobs())
    const state = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{
          state: string
          attempt_id: string
        }>`SELECT state,attempt_id FROM project_memory_jobs WHERE id=${id}`
      }),
    )
    expect(state[0]).toMatchObject({ state: 'claimed', attempt_id: first!.command.run_id })
  })
})

it('registers the final reply before finish, backs off attempts without progress and commits proposals independently', async () => {
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
    // 停用发生在用户消息之后，后台不能凭这条旧消息把停用的断言写回。
    const retired = await run(
      writeProjectMemory(node.employeeId, project.id, undefined, {
        operation_id: randomUUID(),
        expected_revision: 0,
        title: '旧入口',
        content: '测试使用 npm test。',
      }),
    )
    await run(
      changeProjectMemory(node.employeeId, project.id, retired.id, {
        operation_id: randomUUID(),
        expected_revision: 1,
        action: 'retire',
      }),
    )
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
    const sqlRun = <A, E>(query: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
      run(Effect.flatMap(SqlClient.SqlClient, query))
    const claim = async () => {
      await run(scheduleMemoryJobs())
      const [background] = await run(projects.claimProjectCommands('project_memory_start'))
      expect(background?.command.memory_kind).toBe('consolidation')
      return (operation: P.ProjectRuntimeRequest['operation'], payload?: P.ProjectRuntimeRequest['payload']) =>
        run(
          runtimeRequest(node.source, {
            type: 'project_runtime.request',
            run_id: background!.command.run_id,
            lease_epoch: background!.command.lease_epoch,
            operation,
            ...(payload ? { payload } : {}),
          }),
        )
    }
    const idle = await claim()
    await idle('finish')
    await idle('stopped')
    const [waiting] = await sqlRun(
      (sql) =>
        sql<{
          attempts: number
          last_error: string
          due: boolean
        }>`SELECT attempts,last_error,next_attempt_at<=clock_timestamp() AS due FROM project_memory_jobs WHERE project_id=${project.id}`,
    )
    expect(waiting).toEqual({ attempts: 1, last_error: 'no_progress', due: false })
    await sqlRun(
      (sql) => sql`UPDATE project_memory_jobs SET next_attempt_at=clock_timestamp() WHERE project_id=${project.id}`,
    )
    const memory = await claim()
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
        context: Schema.Array(Schema.Struct({ id: Schema.String, source_hash: Schema.String, text: Schema.String })),
      }),
    )(await memory('read_sources'))
    expect(page.source.role).toBe('user')
    expect(page.context.map((c) => c.text)).toEqual(['已确认测试入口。'])
    const reply = page.context[0]!
    const lookup = Schema.decodeUnknownSync(
      Schema.Struct({ suppressed: Schema.Array(Schema.Struct({ item_id: Schema.String, kind: Schema.String })) }),
    )(await memory('lookup_items', { query: '入口', max_results: 8, max_bytes: 32 * 1024 }))
    expect(lookup.suppressed).toEqual([{ item_id: retired.id, kind: 'retired' }])
    const evidence = {
      source_id: page.source.id,
      source_hash: page.source.source_hash,
      start_byte: page.source.offset,
      end_byte: page.source.next_offset,
    }
    const commit = {
      cursor_index: page.cursor_index,
      cursor_offset: page.cursor_offset,
      changes: [
        {
          action: 'add',
          expected_revision: 0,
          content: { title: '测试入口', content: page.source.text, kind: 'lesson' },
          evidence: [
            evidence,
            {
              source_id: reply.id,
              source_hash: reply.source_hash,
              start_byte: 0,
              end_byte: Buffer.byteLength(reply.text),
            },
          ],
        },
        {
          action: 'add',
          expected_revision: 0,
          content: { title: '旧入口', content: '测试使用 npm test。' },
          evidence: [evidence],
        },
        { action: 'add', expected_revision: 0, content: { title: '无证据', content: '只引用回复。' }, evidence: [] },
      ],
    }
    const receipt = await memory('commit_chunk', commit)
    expect(receipt).toMatchObject({
      cursor_index: 1,
      outcomes: [
        { index: 0, revision: 1 },
        { index: 1, rejected: 'source_suppressed' },
        { index: 2, rejected: 'invalid_evidence' },
      ],
    })
    expect(await memory('commit_chunk', commit)).toEqual(receipt)
    await memory('commit_chunk', { cursor_index: 1, cursor_offset: 0, changes: [] })
    await memory('finish')
    await memory('stopped')
    const entries = await run(listProjectMemory(node.employeeId, project.id))
    const learned = entries.entries!.filter((e) => e.status === 'active')
    expect(learned.map((e) => [e.content, e.evidence.length])).toEqual([['测试使用 pnpm test:unit。', 2]])
    const [author] = await sqlRun(
      (sql) => sql<{ author: string }>`SELECT author FROM project_memory_revisions WHERE item_id=${learned[0]!.id}`,
    )
    expect(author).toEqual({ author: 'background' })
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
