import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { expect, it } from 'vite-plus/test'
import type { ThreadReport } from '@baton/protocol'
import { projectToolFixture, callProjectTool, waitForProjectTool } from '../testing/project-tools.ts'
import { seedNode, withTestDatabase } from '../testing/database.ts'
import { runtimeRequest } from './runtime.ts'
import * as threads from '../threads/index.ts'

const unpack = (result: { value: unknown }) => JSON.parse((result.value as { text: string }).text)

it('executes all 18 tools, bounds read results, rejects unknown arguments and prevents cross-project thread access', async () =>
  withTestDatabase(async (db) => {
    const { context: c, nodeId } = await projectToolFixture(db)
    let n = 0
    const call = (name: string, args: unknown) =>
      db.run(callProjectTool({ ...c, toolCallId: `call-${++n}` }, name, args))
    const written = await call('memory.write', { title: 'Decision', content: 'Use PostgreSQL', expected_revision: 0 })
    const entry = (written.value as { entry_id: string }).entry_id
    expect(unpack(await call('memory.search', { query: 'postgres' })).entries).toHaveLength(1)
    expect(unpack(await call('memory.read', { entry_id: entry }))).toMatchObject({
      content: 'Use PostgreSQL',
      revision: 1,
    })
    expect(unpack(await call('history.read', { through_seq: 1 }))).toMatchObject({
      events: [{ seq: 1 }],
      through_seq: 1,
    })
    expect(unpack(await call('history.search', { query: 'assistant', through_seq: 1 })).events).toHaveLength(1)
    expect(unpack(await call('devices.list', {})).devices).toHaveLength(1)
    const created = await call('threads.create', {
      node_id: nodeId,
      agent_type: 'cursor',
      working_directory: '/work/repo',
      message: 'Do work',
      execution_timeout_seconds: 42,
    })
    const id = (created.value as { thread_id: string }).thread_id
    expect(unpack(await call('threads.list', {})).threads).toHaveLength(1)
    expect(unpack(await call('threads.get', { thread_id: id }))).toMatchObject({
      project_id: c.projectId,
      created_by: 'project_agent',
      execution_timeout_seconds: 42,
      pending_messages: [{ sender: 'project_agent' }],
    })
    expect(await call('threads.send', { thread_id: id, message: 'More' })).toMatchObject({
      value: { status: 'accepted' },
    })
    expect(await call('threads.send', { thread_id: id, message: 'Interrupt', mode: 'steer' })).toMatchObject({
      isError: true,
      value: { code: 'steer_unsupported' },
    })
    expect(unpack(await call('threads.read', { thread_id: id }))).toMatchObject({ turns: [], through_turn: 0 })
    expect(await call('threads.stop', { thread_id: id })).not.toHaveProperty('isError', true)
    expect(await call('threads.archive', { thread_id: id })).not.toHaveProperty('isError', true)
    const ask = await call('inbox.ask', {
      title: 'Continue?',
      content: 'Details',
      options: [],
      allow_text: true,
      thread_id: id,
    })
    const requestId = (ask.value as { request_id: string }).request_id
    expect(unpack(await call('inbox.list', {})).requests).toHaveLength(1)
    expect(unpack(await call('inbox.get', { request_id: requestId }))).toMatchObject({
      title: 'Continue?',
      state: 'open',
    })
    expect(await call('inbox.withdraw', { request_id: requestId, reason: 'Resolved elsewhere' })).toMatchObject({
      value: { state: 'withdrawn' },
    })
    expect(
      await call('nodes.exec', {
        node_id: nodeId,
        working_directory: '/work/repo',
        command: 'printf hello',
        wait_seconds: 0,
      }),
    ).toMatchObject({ pending: true, value: { pending: true, wait_remaining_ms: 0 } })
    const running = await db.run(waitForProjectTool({ ...c, toolCallId: `call-${n}` }))
    expect(running).toMatchObject({ value: { status: 'waiting_device', message: expect.stringContaining('仍在执行') } })
    expect(running.pending).toBeUndefined()
    expect(await call('nodes.exec', { node_id: nodeId, working_directory: '/outside', command: 'pwd' })).toMatchObject({
      isError: true,
      value: { code: 'directory_not_allowed' },
    })
    const other = await projectToolFixture(db)
    expect(await db.run(callProjectTool(other.context, 'threads.get', { thread_id: id }))).toMatchObject({
      isError: true,
      value: { code: 'not_found' },
    })
    expect(
      await db.run(
        callProjectTool({ ...other.context, toolCallId: 'read-memory' }, 'memory.read', { entry_id: entry }),
      ),
    ).toMatchObject({
      isError: true,
    })
    expect(
      await db.run(
        callProjectTool({ ...other.context, toolCallId: 'read-inbox' }, 'inbox.get', { request_id: requestId }),
      ),
    ).toMatchObject({
      isError: true,
    })
    expect(
      unpack(await db.run(callProjectTool({ ...other.context, toolCallId: 'list-devices' }, 'devices.list', {})))
        .devices,
    ).toHaveLength(1)
    const sameEmployee = await projectToolFixture(db, c)
    for (const name of ['threads.get', 'threads.read', 'threads.stop', 'threads.archive'])
      expect(
        await db.run(callProjectTool({ ...sameEmployee.context, toolCallId: name }, name, { thread_id: id })),
      ).toMatchObject({ isError: true, value: { code: 'not_found' } })
    expect(
      await call('threads.create', {
        node_id: nodeId,
        agent_type: 'shell',
        working_directory: '/work/repo',
        message: 'bad',
      }),
    ).toMatchObject({ isError: true })
    expect(await call('devices.list', { employeeId: randomUUID() })).toMatchObject({ isError: true })
    expect(await call('unknown', {})).toMatchObject({ isError: true })
    expect(await call('memory.read', { entry_id: 'invalid' })).toMatchObject({ isError: true })
    expect(await call('history.read', { through_seq: Number.MAX_SAFE_INTEGER })).toMatchObject({ isError: true })
    await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE node_runtime_reports SET report=jsonb_set(report,'{exec,enabled}','false'::jsonb) WHERE employee_id=${c.employeeId} AND node_id=${nodeId}`
      }),
    )
    expect(await call('nodes.exec', { node_id: nodeId, working_directory: '/work', command: 'pwd' })).toMatchObject({
      isError: true,
      value: { code: 'exec_disabled' },
    })
  }))

it('preserves exec wait deadlines across retries and consumes terminal inputs only with the saved tool result', async () =>
  withTestDatabase(async (db) => {
    const { context: c, nodeId, source } = await projectToolFixture(db)
    const args = { node_id: nodeId, working_directory: '/work', command: 'printf done', wait_seconds: 600 }
    const first = await db.run(callProjectTool(c, 'nodes.exec', args))
    const id = (first.value as { thread_id: string }).thread_id
    expect(await db.run(callProjectTool(c, 'nodes.exec', args))).toMatchObject({
      pending: true,
      value: { thread_id: id },
    })
    expect(await db.run(waitForProjectTool(c))).toMatchObject({ pending: true })
    const commands = await db.run(threads.claimCommands())
    expect(commands[0]!.body).toMatchObject({
      action: 'open',
      agent_type: 'shell',
      project_id: c.projectId,
      origin_conversation_id: c.conversationId,
      origin_tool_call_id: c.toolCallId,
      execution_timeout_seconds: 7200,
    })
    const report = (seq: number, kind: ThreadReport['kind'], extra: Partial<ThreadReport> = {}): ThreadReport => ({
      type: 'thread.report',
      thread_id: id,
      event_id: randomUUID(),
      worker_seq: seq,
      kind,
      storage_generation: 'generation',
      ...extra,
    })
    await db.run(threads.processReport(source, report(1, 'thread.opened')))
    await db.run(
      threads.processReport(
        source,
        report(2, 'turn.started', {
          worker_turn_seq: 1,
          client_message_id: `pa:${c.conversationId}:${c.toolCallId}:0`,
        }),
      ),
    )
    await db.run(
      threads.processReport(
        source,
        report(3, 'message.sent', {
          worker_turn_seq: 1,
          client_message_id: `pa:${c.conversationId}:${c.toolCallId}:0`,
        }),
      ),
    )
    await db.run(
      threads.processReport(
        source,
        report(4, 'reply', { worker_turn_seq: 1, content: 'done', metadata: { exit_code: 0 } }),
      ),
    )
    const ended = report(5, 'turn.ended', { worker_turn_seq: 1, reason: 'completed', queue_empty: true })
    await db.run(threads.processReport(source, ended))
    await db.run(threads.processReport(source, ended))
    const queue = () =>
      db.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql<{
            source_type: string
            delivered_seq: number | null
            wake_required: boolean
          }>`SELECT source_type,delivered_seq::float8 AS delivered_seq,wake_required FROM project_agent_input_queue WHERE agent_id=${c.agentId}`
        }),
      )
    expect(await queue()).toEqual([{ source_type: 'turn_ended', delivered_seq: null, wake_required: true }])
    const result = await db.run(waitForProjectTool(c))
    expect(result).toMatchObject({
      seq: 3,
      value: { status: 'stopped', command_result: { output: 'done', exit_code: 0 } },
    })
    expect(await queue()).toEqual([{ source_type: 'turn_ended', delivered_seq: result.seq, wake_required: false }])
    expect(
      await db.run(
        runtimeRequest(source, {
          type: 'project_runtime.request',
          run_id: c.runId,
          lease_epoch: c.leaseEpoch,
          operation: 'read_events',
          after_seq: 2,
        }),
      ),
    ).toMatchObject({
      events: [{ seq: 3, kind: 'tool_result', tool_call_id: c.toolCallId, payload: { consumed_thread_id: id } }],
    })
    expect(await db.run(waitForProjectTool(c))).toEqual(result)
    expect(await db.run(callProjectTool(c, 'nodes.exec', args))).toEqual(result)
    await expect(
      db.run(threads.addMessage(c.employeeId, id, { client_message_id: 'second', content: 'again' })),
    ).rejects.toMatchObject({ code: 'shell_single_turn' })
    await expect(db.run(threads.resume(c.employeeId, id))).rejects.toMatchObject({ code: 'shell_single_turn' })
    await expect(
      db.run(
        threads.processReport(
          source,
          report(6, 'turn.started', {
            worker_turn_seq: 2,
            client_message_id: `pa:${c.conversationId}:${c.toolCallId}:0`,
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'shell_single_turn' })
  }))

it('delivers Project turn replies in order, keeps employee turns private, and emits early message failures once', async () =>
  withTestDatabase(async (db) => {
    const { context: c, nodeId, source } = await projectToolFixture(db)
    const create = await db.run(
      callProjectTool(c, 'threads.create', {
        node_id: nodeId,
        agent_type: 'cursor',
        working_directory: '/work',
        message: 'Start',
      }),
    )
    const id = (create.value as { thread_id: string }).thread_id
    const report = (seq: number, kind: ThreadReport['kind'], extra: Partial<ThreadReport> = {}): ThreadReport => ({
      type: 'thread.report',
      thread_id: id,
      event_id: randomUUID(),
      worker_seq: seq,
      kind,
      storage_generation: 'generation',
      ...extra,
    })
    await db.run(threads.processReport(source, report(1, 'thread.opened')))
    await db.run(
      threads.processReport(
        source,
        report(2, 'turn.started', {
          worker_turn_seq: 1,
          client_message_id: `pa:${c.conversationId}:${c.toolCallId}:0`,
        }),
      ),
    )
    await db.run(
      threads.addMessage(c.employeeId, id, { client_message_id: 'employee-in-project-turn', content: 'Additional' }),
    )
    await db.run(threads.processReport(source, report(3, 'reply', { worker_turn_seq: 1, content: 'Reply' })))
    await db.run(
      threads.processReport(
        source,
        report(4, 'turn.ended', { worker_turn_seq: 1, reason: 'completed', queue_empty: true }),
      ),
    )
    await db.run(
      threads.processReport(
        source,
        report(5, 'turn.started', { worker_turn_seq: 2, client_message_id: 'employee-in-project-turn' }),
      ),
    )
    await db.run(threads.processReport(source, report(6, 'reply', { worker_turn_seq: 2, content: 'Employee reply' })))
    await db.run(
      threads.processReport(
        source,
        report(7, 'turn.ended', { worker_turn_seq: 2, reason: 'completed', queue_empty: true }),
      ),
    )
    const failed = { ...c, toolCallId: 'fail-message' }
    await db.run(callProjectTool(failed, 'threads.send', { thread_id: id, message: 'Next' }))
    const withdrawn = report(8, 'message.withdrawn', {
      client_message_id: `pa:${c.conversationId}:fail-message`,
      reason: 'model_unavailable',
    })
    await db.run(threads.processReport(source, withdrawn))
    await db.run(threads.processReport(source, withdrawn))
    const inputs = await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{
          source_type: string
          wake_required: boolean
        }>`SELECT source_type,wake_required FROM project_agent_input_queue WHERE agent_id=${c.agentId} ORDER BY id`
      }),
    )
    expect(inputs).toEqual([
      { source_type: 'thread_reply', wake_required: false },
      { source_type: 'turn_ended', wake_required: true },
      { source_type: 'thread_message_failed', wake_required: true },
    ])
  }))

it('reads the same center thread records from the web timeline and history tools while the device is offline', async () =>
  withTestDatabase(async (db) => {
    const { context: c, nodeId, source } = await projectToolFixture(db)
    const created = await db.run(
      callProjectTool(c, 'threads.create', {
        node_id: nodeId,
        agent_type: 'cursor',
        working_directory: '/work',
        message: 'Start',
      }),
    )
    const id = (created.value as { thread_id: string }).thread_id
    const commands = await db.run(threads.claimCommands())
    const open = commands.find((command) => command.body.thread_id === id && command.body.action === 'open')
    expect(open).toBeTruthy()
    await db.run(
      threads.processReceipt(source, open!.message_id, {
        type: 'thread.command_result',
        thread_id: id,
        ok: true,
        storage_generation: 'generation',
      }),
    )
    const report = (seq: number, kind: ThreadReport['kind'], extra: Partial<ThreadReport> = {}): ThreadReport => ({
      type: 'thread.report',
      thread_id: id,
      event_id: randomUUID(),
      worker_seq: seq,
      kind,
      storage_generation: 'generation',
      ...extra,
    })
    const firstMessage = `pa:${c.conversationId}:${c.toolCallId}:0`
    await db.run(threads.processReport(source, report(1, 'thread.opened', { native_session_id: 'continued-outside' })))
    await db.run(
      threads.processReport(source, report(2, 'turn.started', { worker_turn_seq: 1, client_message_id: firstMessage })),
    )
    await db.run(
      threads.processReport(source, report(3, 'message.sent', { worker_turn_seq: 1, client_message_id: firstMessage })),
    )
    await db.run(threads.processReport(source, report(4, 'reply', { worker_turn_seq: 1, content: 'alpha' })))
    await db.run(
      threads.processReport(
        source,
        report(5, 'turn.ended', { worker_turn_seq: 1, reason: 'completed', queue_empty: true }),
      ),
    )
    const send = { ...c, toolCallId: 'send-2' }
    await db.run(callProjectTool(send, 'threads.send', { thread_id: id, message: 'More' }))
    const secondMessage = `pa:${c.conversationId}:send-2`
    await db.run(
      threads.processReport(
        source,
        report(6, 'turn.started', { worker_turn_seq: 2, client_message_id: secondMessage }),
      ),
    )
    await db.run(
      threads.processReport(
        source,
        report(7, 'message.sent', { worker_turn_seq: 2, client_message_id: secondMessage }),
      ),
    )
    await db.run(threads.processReport(source, report(8, 'reply', { worker_turn_seq: 2, content: 'beta' })))
    await db.run(
      threads.processReport(
        source,
        report(9, 'turn.ended', { worker_turn_seq: 2, reason: 'completed', queue_empty: true }),
      ),
    )
    await db.run(
      runtimeRequest(source, {
        type: 'project_runtime.request',
        run_id: c.runId,
        lease_epoch: c.leaseEpoch,
        operation: 'append_event',
        last_seq: 5,
        client_event_id: 'history-marker',
        payload: { format: 'pi-ai/1', message: { role: 'assistant', content: [{ type: 'text', text: 'page-three' }] } },
      }),
    )
    const { nodeId: runtimeNodeId, source: runtimeSource } = await seedNode(db.run, { employeeId: c.employeeId })
    const reader = { ...c, source: runtimeSource }
    await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE agent_runs SET node_id=${runtimeNodeId} WHERE id=${c.runId}`
        yield* sql`UPDATE node_presence SET online=false, synced=false WHERE node_id=${nodeId}`
      }),
    )
    expect((await db.run(threads.view({ employeeId: c.employeeId }, id))).node_online).toBe(false)

    const paths: string[] = []
    const { createThreadAPI } = await import(new URL('../../../../web/src/data/http/threads.ts', import.meta.url).href)
    const api = createThreadAPI({
      request: async (path: string) => {
        paths.push(path)
        const url = new URL(path, 'https://baton.test')
        if (url.pathname === `/threads/${id}`) return db.run(threads.view({ employeeId: c.employeeId }, id))
        if (url.pathname === `/threads/${id}/timeline`) {
          const cursor = url.searchParams.get('cursor') ?? undefined
          return db.run(threads.timeline(c.employeeId, id, { limit: '2', ...(cursor ? { cursor } : {}) }))
        }
        throw new Error(`Unexpected Web request: ${path}`)
      },
      emit: () => {},
      devices: async () => [],
      operation: () => {
        throw new Error('Unexpected operation')
      },
    })
    const messages: Array<{ body: string; delivery: string }> = await api.listMessages(id)
    const saved = ['Start', 'alpha', 'More', 'beta']
    expect(messages.map((item) => item.body)).toEqual(saved)
    expect(messages.every((item) => item.delivery === 'delivered')).toBe(true)
    expect(paths.some((path) => path.includes('cursor='))).toBe(true)

    const turnsOf = (value: {
      turns: Array<{ messages: Array<{ content: string }>; replies: Array<{ content: string }> }>
    }) =>
      value.turns.flatMap((turn) => [
        ...turn.messages.map((item) => item.content),
        ...turn.replies.map((item) => item.content),
      ])
    const read = async (args: Record<string, unknown>) =>
      unpack(
        await db.run(
          callProjectTool({ ...reader, toolCallId: randomUUID() }, 'threads.read', { thread_id: id, ...args }),
        ),
      )
    expect(turnsOf(await read({}))).toEqual(saved)
    expect(turnsOf(await read({ through_turn: 1 }))).toEqual(['Start', 'alpha'])
    expect(turnsOf(await read({ after_turn: 1 }))).toEqual(['More', 'beta'])

    const history = async (args: Record<string, unknown> = {}) =>
      unpack(
        await db.run(
          callProjectTool({ ...reader, toolCallId: randomUUID() }, 'history.read', { through_seq: 6, ...args }),
        ),
      )
    expect((await history()).events.map((event: { seq: number }) => event.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect((await history({ after_seq: 1, through_seq: 2 })).events.map((event: { seq: number }) => event.seq)).toEqual(
      [2],
    )
    expect(
      await db.run(
        callProjectTool({ ...reader, toolCallId: 'invalid-history' }, 'history.read', {
          through_seq: Number.MAX_SAFE_INTEGER,
        }),
      ),
    ).toMatchObject({
      isError: true,
      value: { code: 'invalid_range' },
    })
    const found = unpack(
      await db.run(
        callProjectTool({ ...reader, toolCallId: 'search-history' }, 'history.search', {
          query: 'page-three',
          through_seq: 6,
        }),
      ),
    )
    expect(found.events).toEqual([expect.objectContaining({ seq: 6 })])

    const other = await projectToolFixture(db)
    await expect(db.run(threads.timeline(other.context.employeeId, id))).rejects.toMatchObject({ code: 'not_found' })
    await expect(db.run(threads.view({ employeeId: other.context.employeeId }, id))).rejects.toMatchObject({
      code: 'not_found',
    })
    expect(await db.run(callProjectTool(other.context, 'threads.read', { thread_id: id }))).toMatchObject({
      isError: true,
      value: { code: 'not_found' },
    })
    expect(
      JSON.stringify(
        unpack(await db.run(callProjectTool({ ...other.context, toolCallId: 'foreign-history' }, 'history.read', {}))),
      ),
    ).not.toContain('alpha')
    const foreign = createThreadAPI({
      request: async (path: string) => {
        const url = new URL(path, 'https://baton.test')
        if (url.pathname === `/threads/${id}`) return db.run(threads.view({ employeeId: other.context.employeeId }, id))
        if (url.pathname === `/threads/${id}/timeline`)
          return db.run(threads.timeline(other.context.employeeId, id, { limit: '2' }))
        throw new Error(path)
      },
      emit: () => {},
      devices: async () => [],
      operation: () => {
        throw new Error('Unexpected operation')
      },
    })
    await expect(foreign.listMessages(id)).rejects.toMatchObject({ code: 'not_found' })
  }))
