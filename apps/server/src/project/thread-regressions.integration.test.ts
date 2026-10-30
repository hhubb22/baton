import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { expect, it } from 'vite-plus/test'
import type { ThreadReport } from '@baton/protocol'
import { projectToolFixture, callProjectTool } from '../testing/project-tools.ts'
import { withTestDatabase } from '../testing/database.ts'
import * as threads from '../threads/index.ts'

it('keeps Project agent audit identity through create, messages, stop and deferred archive while preserving employee identity', async () =>
  withTestDatabase(async (db) => {
    const { context: c, nodeId, source } = await projectToolFixture(db)
    const call = (toolCallId: string, name: string, args: unknown) =>
      db.run(callProjectTool({ ...c, toolCallId }, name, args))
    const created = await call('create', 'threads.create', {
      node_id: nodeId,
      agent_type: 'cursor',
      working_directory: '/work',
      message: 'start',
    })
    const id = (created.value as { thread_id: string }).thread_id
    await call('send', 'threads.send', { thread_id: id, message: 'more' })
    await db.run(threads.addMessage(c.employeeId, id, { client_message_id: 'employee', content: 'additional' }))
    let seq = 0
    const report = (kind: ThreadReport['kind'], extra: Partial<ThreadReport> = {}): ThreadReport => ({
      type: 'thread.report',
      thread_id: id,
      event_id: randomUUID(),
      worker_seq: ++seq,
      kind,
      storage_generation: 'generation',
      ...extra,
    })
    await db.run(threads.processReport(source, report('thread.opened')))
    await call('stop', 'threads.stop', { thread_id: id })
    await call('archive', 'threads.archive', { thread_id: id })
    for (const client_message_id of [`pa:${c.conversationId}:create:0`, `pa:${c.conversationId}:send`, 'employee'])
      await db.run(threads.processReport(source, report('message.withdrawn', { client_message_id })))
    await db.run(threads.processReport(source, report('thread.stopped')))
    expect((await db.run(threads.view({ employeeId: c.employeeId }, id))).status).toBe('archived')
    const events = await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{
          kind: string
          actor: string
          actor_id: string
          client_message_id: string | null
        }>`SELECT kind,actor,actor_id,payload->>'client_message_id' AS client_message_id FROM thread_events WHERE thread_id=${id} AND kind IN ('thread.created','message.accepted','stop.requested','archive.requested','thread.archived') ORDER BY id`
      }),
    )
    expect(events.filter((e) => e.client_message_id !== 'employee')).toEqual([
      expect.objectContaining({ kind: 'thread.created', actor: 'project_agent', actor_id: c.agentId }),
      expect.objectContaining({ kind: 'message.accepted', actor: 'project_agent', actor_id: c.agentId }),
      expect.objectContaining({ kind: 'message.accepted', actor: 'project_agent', actor_id: c.agentId }),
      expect.objectContaining({ kind: 'stop.requested', actor: 'project_agent', actor_id: c.agentId }),
      expect.objectContaining({ kind: 'archive.requested', actor: 'project_agent', actor_id: c.agentId }),
      expect.objectContaining({ kind: 'thread.archived', actor: 'project_agent', actor_id: c.agentId }),
    ])
    expect(events.find((e) => e.client_message_id === 'employee')).toMatchObject({
      actor: 'employee',
      actor_id: c.employeeId,
    })
    const employee = await db.run(
      threads.create(c.employeeId, {
        client_thread_id: randomUUID(),
        node_id: nodeId,
        agent_type: 'cursor',
        working_directory: '/work',
        message: { client_message_id: 'direct', content: 'employee' },
      }),
    )
    await db.run(threads.stop(c.employeeId, employee.thread.id))
    await db.run(threads.archive(c.employeeId, employee.thread.id))
    const audit = await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{
          actor: string
          actor_id: string
        }>`SELECT actor,actor_id FROM thread_events WHERE thread_id=${employee.thread.id}`
      }),
    )
    expect(audit).toHaveLength(4)
    expect(audit.every((e) => e.actor === 'employee' && e.actor_id === c.employeeId)).toBe(true)
  }))
