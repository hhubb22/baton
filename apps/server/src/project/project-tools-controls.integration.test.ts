import { randomUUID } from 'node:crypto'
import { Effect, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { expect, it } from 'vite-plus/test'
import { projectToolFixture, callProjectTool } from '../testing/project-tools.ts'
import { withTestDatabase } from '../testing/database.ts'
import * as threads from '../threads.ts'

const threadResult = Schema.decodeUnknownSync(Schema.Struct({ thread_id: Schema.String }))
const auditEvents = (threadId: string, kind: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<{
      actor: string
      actor_id: string
    }>`SELECT actor,actor_id FROM thread_events WHERE thread_id=${threadId} AND kind=${kind} ORDER BY id`
  })

it('withdraws only unsent messages in this Project and deduplicates concurrent requests', async () =>
  withTestDatabase(async (db) => {
    const { context: c, nodeId } = await projectToolFixture(db)
    const created = await db.run(
      callProjectTool(c, 'threads.create', {
        node_id: nodeId,
        agent_type: 'cursor',
        working_directory: '/work/repo',
        message: 'Do work',
      }),
    )
    const id = threadResult(created.value).thread_id
    const message = (await db.run(threads.view(c.employeeId, id))).pending_messages?.at(0)
    if (!message) throw new Error('Expected pending message')
    const args = { thread_id: id, message_id: message.id }
    const withdraw = (toolCallId: string) => db.run(callProjectTool({ ...c, toolCallId }, 'threads.withdraw', args))
    const commands = () =>
      db.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql`SELECT payload FROM thread_outbox WHERE thread_id=${id} AND action='withdraw'`
        }),
      )
    const sameEmployee = await projectToolFixture(db, c)
    const otherEmployee = await projectToolFixture(db)
    for (const context of [sameEmployee.context, otherEmployee.context])
      expect(await db.run(callProjectTool(context, 'threads.withdraw', args))).toMatchObject({
        isError: true,
        value: { code: 'not_found' },
      })
    expect(await commands()).toHaveLength(0)
    await withdraw('withdraw-1')
    for (const result of await Promise.all([withdraw('withdraw-1'), withdraw('withdraw-2')]))
      expect(result).toMatchObject({ value: { thread_id: id, message_id: message.id, read_tool: 'threads.get' } })
    expect(await commands()).toEqual([{ payload: { client_message_id: message.client_message_id } }])
    const projectActor = { actor: 'project_agent', actor_id: c.agentId }
    expect(await db.run(auditEvents(id, 'withdraw.requested'))).toEqual([projectActor, projectActor])
    await db.run(threads.withdraw(c.employeeId, id, message.id))
    expect(await db.run(auditEvents(id, 'withdraw.requested'))).toEqual([
      projectActor,
      projectActor,
      { actor: 'employee', actor_id: c.employeeId },
    ])

    for (const status of ['queued', 'withdrawn', 'sent', 'unknown']) {
      await db.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`UPDATE thread_messages SET status=${status} WHERE id=${message.id}`
        }),
      )
      const result = await withdraw(`withdraw-${status}`)
      if (status === 'sent' || status === 'unknown')
        expect(result).toMatchObject({ isError: true, value: { code: 'message_already_sent' } })
      else expect(result.isError).not.toBe(true)
      expect(await commands()).toHaveLength(1)
    }
    expect(
      await db.run(
        callProjectTool({ ...c, toolCallId: 'missing-message' }, 'threads.withdraw', {
          thread_id: id,
          message_id: randomUUID(),
        }),
      ),
    ).toMatchObject({ isError: true, value: { code: 'not_found' } })
  }))

it('resumes through the existing execution checks without duplicating commands or replaying messages', async () =>
  withTestDatabase(async (db) => {
    const { context: c, nodeId } = await projectToolFixture(db)
    const created = await db.run(
      callProjectTool(c, 'threads.create', {
        node_id: nodeId,
        agent_type: 'cursor',
        working_directory: '/work/repo',
        message: 'Do work',
      }),
    )
    const id = threadResult(created.value).thread_id
    const args = { thread_id: id }
    const resume = (toolCallId: string) => db.run(callProjectTool({ ...c, toolCallId }, 'threads.resume', args))
    const outbox = () =>
      db.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql<{ action: string }>`SELECT action FROM thread_outbox WHERE thread_id=${id} ORDER BY id`
        }),
      )
    const before = await outbox()
    expect(await resume('not-opened')).toMatchObject({ isError: true, value: { code: 'thread_not_opened' } })
    await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE threads SET opened_at=clock_timestamp(),storage_generation='generation',status='running' WHERE id=${id}`
      }),
    )
    expect(await resume('running')).toMatchObject({ isError: true, value: { code: 'thread_conflict' } })
    await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE threads SET status='stopped',stop_requested_at=clock_timestamp() WHERE id=${id}`
      }),
    )
    expect(await resume('stop-pending')).toMatchObject({ isError: true, value: { code: 'stop_pending' } })
    await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE threads SET stop_confirmed_at=clock_timestamp() WHERE id=${id}`
        yield* sql`UPDATE node_runtime_reports SET report=jsonb_set(report,'{agents,0,capabilities,resume}','false'::jsonb) WHERE node_id=${nodeId}`
      }),
    )
    expect(await resume('unsupported')).toMatchObject({ isError: true, value: { code: 'resume_unsupported' } })
    await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE node_runtime_reports SET report=jsonb_set(report,'{agents,0,capabilities,resume}','true'::jsonb) WHERE node_id=${nodeId}`
      }),
    )
    const sameEmployee = await projectToolFixture(db, c)
    const otherEmployee = await projectToolFixture(db)
    for (const context of [sameEmployee.context, otherEmployee.context])
      expect(await db.run(callProjectTool(context, 'threads.resume', args))).toMatchObject({
        isError: true,
        value: { code: 'not_found' },
      })
    expect(await outbox()).toEqual(before)
    await resume('resume-1')
    for (const result of await Promise.all([resume('resume-1'), resume('resume-2'), resume('resume-1')]))
      expect(result).toMatchObject({ value: { thread_id: id, status: 'stopped', read_tool: 'threads.get' } })
    expect(await outbox()).toEqual([...before, { action: 'resume' }])
    expect(await db.run(auditEvents(id, 'resume.requested'))).toEqual([{ actor: 'project_agent', actor_id: c.agentId }])
    expect((await db.run(threads.view(c.employeeId, id))).resume_pending).toBe(true)
    await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE threads SET archive_requested_at=clock_timestamp() WHERE id=${id}`
      }),
    )
    expect(await resume('archiving')).toMatchObject({ isError: true, value: { code: 'thread_archived' } })
    expect(await outbox()).toEqual([...before, { action: 'resume' }])
  }))

it.each(['employee', 'project_agent'])('records %s when resume retries opening a rejected Thread', (actor) =>
  withTestDatabase(async (db) => {
    const { context: c, nodeId, source } = await projectToolFixture(db)
    const created = await db.run(
      callProjectTool(c, 'threads.create', {
        node_id: nodeId,
        agent_type: 'cursor',
        working_directory: '/work/repo',
        message: 'Do work',
      }),
    )
    const id = threadResult(created.value).thread_id
    const [opening] = await db.run(threads.claimCommands())
    if (!opening) throw new Error('Expected open command')
    await db.run(
      threads.processReceipt(source, opening.message_id, {
        type: 'thread.command_result',
        thread_id: id,
        ok: false,
        code: 'agent_unavailable',
      }),
    )
    expect((await db.run(threads.view(c.employeeId, id))).retry_open_allowed).toBe(true)
    for (let attempt = 0; attempt < 2; attempt++) {
      if (actor === 'project_agent')
        expect(
          await db.run(callProjectTool({ ...c, toolCallId: `retry-${attempt}` }, 'threads.resume', { thread_id: id })),
        ).not.toHaveProperty('isError', true)
      else await db.run(threads.resume(c.employeeId, id))
    }
    expect(await db.run(auditEvents(id, 'open.retry_requested'))).toEqual([
      { actor, actor_id: actor === 'project_agent' ? c.agentId : c.employeeId },
    ])
  }),
)
