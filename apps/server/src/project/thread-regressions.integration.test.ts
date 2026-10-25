import { randomUUID } from 'node:crypto'
import { Effect, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { expect, it } from 'vite-plus/test'
import { ProjectEvent, type ProjectRuntimeRequest, type ThreadReport } from '@baton/protocol'
import { projectToolFixture, callProjectTool, waitForProjectTool } from '../testing/project-tools.ts'
import { withTestDatabase } from '../testing/database.ts'
import * as threads from '../threads/index.ts'
import { runtimeRequest } from './runtime.ts'

it('notifies a never-dispatched shell withdrawal once when history is unavailable', () =>
  withTestDatabase(async (db) => {
    const { context, nodeId, source } = await projectToolFixture(db)
    const result = await db.run(
      callProjectTool(context, 'nodes.exec', {
        node_id: nodeId,
        working_directory: '/work',
        command: 'printf done',
        wait_seconds: 0,
      }),
    )
    const { thread_id: id } = Schema.decodeUnknownSync(Schema.Struct({ thread_id: Schema.String }))(result.value)
    await db.run(waitForProjectTool(context))
    await db.run(
      threads.processReport(source, {
        type: 'thread.report',
        thread_id: id,
        event_id: randomUUID(),
        worker_seq: 1,
        kind: 'thread.opened',
        storage_generation: 'generation',
      }),
    )
    const lost: ThreadReport = {
      type: 'thread.report',
      thread_id: id,
      event_id: randomUUID(),
      worker_seq: 2,
      kind: 'thread.unknown',
      storage_generation: 'generation',
      history_unavailable: true,
    }
    await db.run(threads.processReport(source, lost))
    await db.run(threads.processReport(source, lost))
    const state = await db.run(threads.view({ employeeId: context.employeeId }, id))
    expect(state.pending_messages).toEqual([])
    expect(state.failed_messages?.[0]).toMatchObject({
      status: 'withdrawn',
      status_reason: 'history_unavailable_before_dispatch',
    })
    const notifications = await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{
          source_type: string
          payload: Record<string, unknown>
        }>`SELECT source_type,payload FROM project_agent_input_queue WHERE agent_id=${context.agentId} AND payload->>'thread_id'=${id}`
      }),
    )
    expect(notifications).toEqual([
      expect.objectContaining({
        source_type: 'thread_message_failed',
        payload: expect.objectContaining({ reason: 'history_unavailable_before_dispatch' }),
      }),
    ])
  }))

it('notifies an unknown shell result without a Turn once after its tool wait has ended', async () =>
  withTestDatabase(async (db) => {
    const { context: c, nodeId, source } = await projectToolFixture(db)
    for (const mode of ['thread-first', 'message-first', 'history-unavailable'] as const) {
      const context = { ...c, toolCallId: mode }
      const args = { node_id: nodeId, working_directory: '/work', command: 'printf done', wait_seconds: 0 }
      const first = await db.run(callProjectTool(context, 'nodes.exec', args))
      const id = (first.value as { thread_id: string }).thread_id
      expect(await db.run(waitForProjectTool(context))).toMatchObject({
        value: { status: 'waiting_device', message: expect.stringContaining('仍在执行') },
      })
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
      const [opening] = (await db.run(threads.claimCommands())).filter((command) => command.body.thread_id === id)
      if (!opening) throw new Error('Missing open command')
      await db.run(
        threads.processReceipt(source, opening.message_id, {
          type: 'thread.command_result',
          thread_id: id,
          ok: true,
          storage_generation: 'generation',
        }),
      )
      await db.run(threads.processReport(source, report('thread.opened')))
      const dispatched = await db.run(threads.claimCommands())
      expect(dispatched.some((command) => command.body.thread_id === id && command.body.action === 'message')).toBe(
        true,
      )
      const unknown = () =>
        report('message.unknown', {
          client_message_id: `pa:${c.conversationId}:${mode}:0`,
          reason: 'input_outcome_unknown',
        })
      const threadUnknown = () => report('thread.unknown', { reason: 'input_outcome_unknown' })
      if (mode === 'history-unavailable')
        await db.run(
          threads.processReport(
            source,
            report('thread.unknown', { history_unavailable: true, reason: 'input_outcome_unknown' }),
          ),
        )
      else {
        await db.run(threads.processReport(source, mode === 'message-first' ? unknown() : threadUnknown()))
        await db.run(threads.processReport(source, mode === 'message-first' ? threadUnknown() : unknown()))
      }
      const repeated = threadUnknown()
      await db.run(threads.processReport(source, repeated))
      await db.run(threads.processReport(source, repeated))
      const inputs = () =>
        db.run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            return yield* sql<{
              source_type: string
              source_key: string
              payload: Record<string, unknown>
              wake_required: boolean
              delivered_seq: number | null
            }>`SELECT source_type,source_key,payload,wake_required,delivered_seq::float8 AS delivered_seq FROM project_agent_input_queue WHERE agent_id=${c.agentId} AND payload->>'thread_id'=${id}`
          }),
        )
      expect(await inputs()).toEqual([
        expect.objectContaining({
          source_type: 'thread_message_failed',
          wake_required: true,
          delivered_seq: null,
          payload: expect.objectContaining({
            thread_id: id,
            status: 'unknown',
            outcome: 'unknown',
            automatic_retry: false,
            reason: 'input_outcome_unknown',
          }),
        }),
      ])
      expect((await inputs())[0]!.payload).not.toHaveProperty('worker_turn_seq')
      expect((await inputs())[0]!.payload).not.toHaveProperty('command_result')
      expect(await db.run(threads.view({ employeeId: c.employeeId }, id))).toMatchObject({
        status: 'unknown',
        current_turn: null,
        pending_messages: [{ status: 'unknown' }],
      })
      expect(await db.run(callProjectTool(context, 'nodes.exec', args))).toMatchObject({ value: { thread_id: id } })
      await expect(db.run(threads.resume(c.employeeId, id))).rejects.toMatchObject({ code: 'shell_single_turn' })
      await db.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const [count] = yield* sql<{
            n: number
          }>`SELECT count(*)::integer AS n FROM threads WHERE origin_conversation_id=${c.conversationId} AND origin_tool_call_id=${mode}`
          expect(count!.n).toBe(1)
        }),
      )
      await db.run(threads.processReport(source, threadUnknown()))
      expect(await inputs()).toEqual([expect.objectContaining({ wake_required: true, delivered_seq: null })])
    }
    const context = { ...c, toolCallId: 'with-turn' }
    const first = await db.run(
      callProjectTool(context, 'nodes.exec', {
        node_id: nodeId,
        working_directory: '/work',
        command: 'printf done',
        wait_seconds: 0,
      }),
    )
    const id = (first.value as { thread_id: string }).thread_id
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
    const client_message_id = `pa:${c.conversationId}:with-turn:0`
    await db.run(threads.processReport(source, report('thread.opened')))
    await db.run(threads.processReport(source, report('turn.started', { worker_turn_seq: 1, client_message_id })))
    await db.run(
      threads.processReport(source, report('message.unknown', { client_message_id, reason: 'input_outcome_unknown' })),
    )
    await db.run(
      threads.processReport(
        source,
        report('turn.ended', { worker_turn_seq: 1, reason: 'agent_exited', queue_empty: true }),
      ),
    )
    await db.run(
      threads.processReport(
        source,
        report('thread.unknown', { history_unavailable: true, reason: 'input_outcome_unknown' }),
      ),
    )
    const notifications = await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{
          source_type: string
        }>`SELECT source_type FROM project_agent_input_queue WHERE agent_id=${c.agentId} AND payload->>'thread_id'=${id}`
      }),
    )
    expect(notifications).toEqual([{ source_type: 'turn_ended' }])
  }))

it.each(['unknown', 'still_running'] as const)(
  'handles a late unknown notification after wait_tool saved %s',
  async (status) =>
    withTestDatabase(async (db) => {
      const { context: c, nodeId, source } = await projectToolFixture(db)
      const rpc = (operation: ProjectRuntimeRequest['operation'], extra: Partial<ProjectRuntimeRequest> = {}) =>
        db.run(
          runtimeRequest(source, {
            type: 'project_runtime.request',
            run_id: c.runId,
            lease_epoch: c.leaseEpoch,
            operation,
            ...extra,
          }),
        )
      const args = { node_id: nodeId, working_directory: '/work', command: 'printf done', wait_seconds: 600 }
      await rpc('append_event', {
        last_seq: 1,
        client_event_id: 'exec-call',
        payload: {
          format: 'pi-ai/1',
          message: {
            role: 'assistant',
            content: [{ type: 'toolCall', id: c.toolCallId, name: 'nodes.exec', arguments: args }],
          },
        },
      })
      const pending = (await rpc('call_tool', {
        last_seq: 2,
        tool_call_id: c.toolCallId,
        tool_name: 'nodes.exec',
        arguments: args,
      })) as { thread_id: string }
      const id = pending.thread_id
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
      if (status === 'unknown')
        await db.run(threads.processReport(source, report('thread.unknown', { reason: 'input_outcome_unknown' })))
      const result = Schema.decodeUnknownSync(ProjectEvent)(
        await rpc('wait_tool', {
          last_seq: 2,
          tool_call_id: c.toolCallId,
          payload: { finish_wait: status !== 'unknown' },
        }),
      )
      expect(result.seq).toBe(3)
      if (status === 'unknown')
        expect(result.payload).toMatchObject({ consumed_thread_id: id, message: { isError: true } })
      else {
        expect(result.payload).not.toHaveProperty('consumed_thread_id')
        await db.run(threads.processReport(source, report('thread.unknown', { reason: 'input_outcome_unknown' })))
      }
      const queue = () =>
        db.run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            return yield* sql<{
              delivered_seq: number | null
              wake_required: boolean
            }>`SELECT delivered_seq::float8 AS delivered_seq,wake_required FROM project_agent_input_queue WHERE agent_id=${c.agentId}`
          }),
        )
      expect(await queue()).toEqual([])
      const unknown = report('message.unknown', {
        client_message_id: `pa:${c.conversationId}:${c.toolCallId}:0`,
        reason: 'input_outcome_unknown',
      })
      await db.run(threads.processReport(source, unknown))
      await db.run(threads.processReport(source, unknown))
      await db.run(threads.processReport(source, report('thread.unknown', { reason: 'input_outcome_unknown' })))
      expect(await queue()).toEqual([
        { delivered_seq: status === 'unknown' ? 3 : null, wake_required: status !== 'unknown' },
      ])
      expect(await rpc('claim_inputs', { last_seq: 3 })).toMatchObject({ input_count: status === 'unknown' ? 0 : 1 })
      expect((await db.run(threads.view({ employeeId: c.employeeId }, id))).current_turn).toBeNull()
    }),
)

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
