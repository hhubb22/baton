import { randomUUID } from 'node:crypto'
import { Effect, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as P from '@baton/protocol'
import { expect, it } from 'vite-plus/test'
import { withTestDatabase } from '../testing/database.ts'
import { projectToolFixture } from '../testing/project-tools.ts'
import { contextualRuntimeRequest } from '../testing/project-context.ts'
import { runtimeRequest } from './runtime.ts'

it('notifies the committed Project and Thread for runtime tools, including pending Execution creation', async () =>
  withTestDatabase(async (db) => {
    const { context: c, nodeId } = await projectToolFixture(db)
    const events: P.BrowserEvent[] = []
    const call = async (name: string, args: typeof Schema.Json.Type) => {
      const toolId = randomUUID()
      const lastSeq = await db.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const [row] = yield* sql<{
            seq: number
          }>`SELECT (next_seq-1)::float8 AS seq FROM conversations WHERE id=${c.conversationId}`
          return row!.seq
        }),
      )
      const base = { type: 'project_runtime.request' as const, run_id: c.runId, lease_epoch: c.leaseEpoch }
      const assistant = Schema.decodeUnknownSync(P.ProjectEvent)(
        await db.run(
          contextualRuntimeRequest(c.source, {
            ...base,
            operation: 'append_event',
            last_seq: lastSeq,
            client_event_id: toolId,
            payload: {
              format: 'pi-ai/1',
              message: { role: 'assistant', content: [{ type: 'toolCall', id: toolId, name, arguments: args }] },
            },
          }),
        ),
      )
      events.length = 0
      return db.run(
        runtimeRequest(
          c.source,
          {
            ...base,
            operation: 'call_tool',
            last_seq: assistant.seq,
            tool_call_id: toolId,
            tool_name: name,
            arguments: args,
          },
          (event) => events.push(event),
        ),
      )
    }
    const projectEvent = { type: 'project.changed', project_id: c.projectId, change: 'detail' }
    await call('threads.create', {
      node_id: nodeId,
      agent_type: 'cursor',
      working_directory: '/work',
      message: 'Inspect',
    })
    const [threadEvent] = events
    expect(threadEvent).toMatchObject({ type: 'thread.changed', change: 'detail' })
    if (threadEvent?.type !== 'thread.changed') throw new Error('missing Thread notification')
    const threadId = threadEvent.thread_id
    expect(events).toEqual([threadEvent, projectEvent])
    const saved = await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql`SELECT id FROM threads WHERE id=${threadId} AND project_id=${c.projectId}`
      }),
    )
    expect(saved).toHaveLength(1)
    await call('threads.send', { thread_id: threadId, message: 'Continue' })
    expect(events).toEqual([threadEvent, projectEvent])
    await call('threads.send', { thread_id: randomUUID(), message: 'Unauthorized' })
    expect(events).toEqual([projectEvent])
    const pending = await call('nodes.exec', { node_id: nodeId, working_directory: '/work', command: 'pwd' })
    expect(pending).toMatchObject({ pending: true, execution_id: expect.any(String) })
    expect(events).toEqual([projectEvent])
    events.length = 0
    await expect(
      db.run(
        runtimeRequest(
          c.source,
          {
            type: 'project_runtime.request',
            run_id: c.runId,
            lease_epoch: c.leaseEpoch + 1,
            operation: 'started',
          },
          (event) => events.push(event),
        ),
      ),
    ).rejects.toThrow()
    expect(events).toEqual([])
  }))
