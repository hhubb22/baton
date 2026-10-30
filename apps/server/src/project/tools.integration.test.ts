import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { expect, it } from 'vite-plus/test'
import type { ThreadReport } from '@baton/protocol'
import { projectToolFixture, callProjectTool } from '../testing/project-tools.ts'
import { seedNode, withTestDatabase } from '../testing/database.ts'
import { contextualRuntimeRequest as runtimeRequest } from '../testing/project-context.ts'
import * as threads from '../threads/index.ts'
import { changeProjectMemory, writeProjectMemory } from './memory/index.ts'

const unpack = (result: { value: unknown }) => JSON.parse((result.value as { text: string }).text)

it('searches indexed historical sources with suppression, sequence bounds and Project isolation', async () =>
  withTestDatabase(async (db) => {
    const { context: c, memoryEvidence } = await projectToolFixture(db)
    const reference = memoryEvidence[0]!
    await db.run(
      runtimeRequest(c.source, {
        type: 'project_runtime.request',
        run_id: c.runId,
        lease_epoch: c.leaseEpoch,
        operation: 'append_event',
        last_seq: 1,
        client_event_id: randomUUID(),
        payload: {
          format: 'pi-ai/1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '部署前执行 runBuildCheck，保留 /src/project_memory.ts。' }],
          },
        },
      }),
    )
    const search = async (query: string, extra: Record<string, unknown> = {}) =>
      unpack(
        await db.run(
          callProjectTool({ ...c, toolCallId: randomUUID() }, 'history.search', { query, through_seq: 2, ...extra }),
        ),
      )
    expect((await search('run_build_check')).events).toMatchObject([
      { seq: 2, snippet: expect.stringContaining('runBuildCheck') },
    ])
    expect((await search('部署')).events).toHaveLength(1)
    expect((await search('run_build_check', { through_seq: 1 })).events).toEqual([])
    expect((await search('run_build_check', { after_seq: 2 })).events).toEqual([])
    const written = await db.run(
      callProjectTool({ ...c, toolCallId: randomUUID() }, 'memory.remember', {
        title: 'Database',
        content: 'Use PostgreSQL',
        evidence: memoryEvidence,
      }),
    )
    const itemId = (written.value as { item_id: string }).item_id
    const retired = await db.run(
      changeProjectMemory(c.employeeId, c.projectId, itemId, {
        operation_id: randomUUID(),
        expected_revision: 1,
        action: 'retire',
      }),
    )
    expect(await search('POSTGRE_SQL')).toMatchObject({
      events: [
        {
          seq: 1,
          source: {
            source_id: reference.source_id,
            source_hash: reference.source_hash,
            suppressed: true,
            related_items: [{ item_id: itemId, status: 'retired', effective: false }],
          },
        },
      ],
      no_match: false,
    })
    await db.run(
      changeProjectMemory(c.employeeId, c.projectId, itemId, {
        operation_id: randomUUID(),
        expected_revision: retired.revision,
        action: 'restore',
        suppression_id: retired.suppression_id!,
      }),
    )
    expect((await search('PostgreSQL')).events[0].source.suppressed).toBe(false)
    await db.run(
      writeProjectMemory(c.employeeId, c.projectId, undefined, {
        operation_id: randomUUID(),
        expected_revision: 0,
        title: 'Private edit',
        content: 'manual-only-needle',
      }),
    )
    expect((await search('manual-only-needle')).events).toEqual([])
    const other = await projectToolFixture(db, { employeeId: c.employeeId, source: c.source })
    const foreign = unpack(await db.run(callProjectTool(other.context, 'history.search', { query: 'run_build_check' })))
    expect(foreign.events).toEqual([])
    const read = unpack(
      await db.run(callProjectTool({ ...c, toolCallId: randomUUID() }, 'history.read', { through_seq: 2 })),
    )
    expect(read.events.map((event: { seq: number }) => event.seq)).toEqual([1, 2])
  }))

it('executes Project tools, bounds read results, rejects unknown arguments and prevents cross-project thread access', async () =>
  withTestDatabase(async (db) => {
    const { context: c, nodeId, memoryEvidence } = await projectToolFixture(db)
    let n = 0
    const call = (name: string, args: unknown) =>
      db.run(callProjectTool({ ...c, toolCallId: `call-${++n}` }, name, args))
    const written = await call('memory.remember', {
      title: 'Decision',
      content: 'Use PostgreSQL',
      evidence: memoryEvidence,
    })
    const entry = (written.value as { item_id: string }).item_id
    const recalled = (await call('memory.recall', { query: 'PostgreSQL' })).value as {
      entries: { item?: { id: string } }[]
    }
    expect(recalled.entries.filter((hit) => hit.item?.id === entry)).toHaveLength(1)
    expect(unpack(await call('memory.read', { item_id: entry }))).toMatchObject({
      content: 'Use PostgreSQL',
      revision: 1,
    })
    expect(unpack(await call('history.read', { through_seq: 1 }))).toMatchObject({
      events: [{ seq: 1 }],
      through_seq: 1,
    })
    expect(unpack(await call('history.search', { query: 'PostgreSQL', through_seq: 1 })).events).toHaveLength(1)
    expect(unpack(await call('devices.list', {})).devices).toHaveLength(1)
    const created = await call('threads.create', {
      node_id: nodeId,
      agent_type: 'cursor',
      runtime_mode: 'approval-required',
      working_directory: '/work/repo',
      message: 'Do work',
      execution_timeout_seconds: 42,
    })
    const id = (created.value as { thread_id: string }).thread_id
    expect(unpack(await call('threads.list', {})).threads).toHaveLength(1)
    expect(unpack(await call('threads.get', { thread_id: id }))).toMatchObject({
      project_id: c.projectId,
      created_by: 'project_agent',
      runtime_mode: 'approval-required',
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
    const other = await projectToolFixture(db)
    expect(await db.run(callProjectTool(other.context, 'threads.get', { thread_id: id }))).toMatchObject({
      isError: true,
      value: { code: 'not_found' },
    })
    expect(
      await db.run(callProjectTool({ ...other.context, toolCallId: 'read-memory' }, 'memory.read', { item_id: entry })),
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
    expect(await call('memory.read', { item_id: 'invalid' })).toMatchObject({ isError: true })
    expect(await call('history.read', { through_seq: Number.MAX_SAFE_INTEGER })).toMatchObject({ isError: true })
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
