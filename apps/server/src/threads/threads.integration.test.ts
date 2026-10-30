import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Effect, Exit, Option, Schema, Scope, Tracer } from 'effect'
import * as HttpEffect from 'effect/http/HttpEffect'
import * as SqlClient from 'effect/sql/SqlClient'
import { expect, it } from 'vite-plus/test'
import * as P from '@baton/protocol'
import { seedNode, withTestDatabase, type TestDatabase } from '../testing/database.ts'
import { withTraceSpan } from '@baton/telemetry'
import * as threads from './index.ts'
import { digest, sessionCSRF } from '../auth.ts'
import { httpApplication } from '../http/index.ts'
import { CredentialSigner } from '../nodes.ts'
import { activitySnapshot } from '../desktop-notifications.ts'

type Run = TestDatabase['run']
async function fixture(run: Run, thinking = false, runtimeMode?: P.RuntimeMode) {
  const report: P.RuntimeReport = {
    exec: { enabled: false, shell: '/bin/sh' },
    roots: [{ root_id: 'home', path: '/workspace' }],
    repos: [],
    agents: [
      {
        agent_type: thinking ? 'codex' : 'cursor',
        version: '1.0.35',
        status: 'available',
        models: [
          {
            id: 'default',
            name: 'Default',
            ...(thinking
              ? {
                  thinking: {
                    id: 'reasoningEffort' as const,
                    options: [
                      { id: 'medium', label: 'Medium' },
                      { id: 'high', label: 'High' },
                    ],
                  },
                }
              : {}),
          },
          ...(thinking
            ? [
                {
                  id: 'other',
                  name: 'Other',
                  thinking: {
                    id: 'reasoningEffort' as const,
                    options: [{ id: 'high', label: 'High' }],
                  },
                },
              ]
            : []),
        ],
        default_model: 'default',
        runtime_modes: P.RuntimeMode.literals.map((id) => ({ id, available: true })),
        default_runtime_mode: P.DEFAULT_RUNTIME_MODE,
        capabilities: { create: true, queue: true, steer: false, stop: true, resume: true, switch_model: thinking },
      },
    ],
  }
  const {
    employeeId: employee,
    nodeId: node,
    credentialId: credential,
    source,
  } = await seedNode(run, {
    incarnation: 'incarnation',
    connId: 'connection',
    report,
  })
  const input: P.CreateBrowserThreadInput = {
    client_thread_id: randomUUID(),
    node_id: node,
    agent_type: thinking ? 'codex' : 'cursor',
    working_directory: '/workspace/project',
    ...(runtimeMode ? { runtime_mode: runtimeMode } : {}),
    message: {
      client_message_id: randomUUID(),
      content: 'hello',
      ...(thinking ? { thinking: { id: 'reasoningEffort', value: 'high' } } : {}),
    },
  }
  const create = () => run(threads.create(employee, input))
  return { employee, node, credential, source, input, create }
}
const report = (
  id: string,
  seq: number,
  kind: P.ThreadReport['kind'],
  extra: Partial<P.ThreadReport> = {},
): P.ThreadReport => ({
  type: 'thread.report',
  thread_id: id,
  event_id: randomUUID(),
  worker_seq: seq,
  kind,
  storage_generation: 'generation',
  ...extra,
})
const query = <A extends object>(text: string, ...args: ReadonlyArray<string | number | null>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.unsafe<A>(text, args)
  })
async function open(run: Run, f: Awaited<ReturnType<typeof fixture>>) {
  const { thread } = await f.create()
  const commands = await run(threads.claimCommands())
  const command = commands.find((c) => c.body.thread_id === thread.id)!
  await run(
    threads.processReceipt(f.source, command.message_id, {
      type: 'thread.command_result',
      thread_id: thread.id,
      ok: true,
      storage_generation: 'generation',
    }),
  )
  await run(threads.processReport(f.source, report(thread.id, 1, 'thread.opened', { native_session_id: 'native' })))
  await run(
    threads.processReport(
      f.source,
      report(thread.id, 2, 'command.completed', {
        command_id: command.message_id,
        command_outcome: 'succeeded',
        reason: '',
      }),
    ),
  )
  return thread
}

it('retains the device reason when a saved mode becomes unavailable before opening', () =>
  withTestDatabase(async ({ run }) => {
    const f = await fixture(run)
    const { thread } = await f.create()
    const command = (await run(threads.claimCommands())).find((item) => item.body.thread_id === thread.id)!
    await run(
      threads.processReceipt(f.source, command.message_id, {
        type: 'thread.command_result',
        thread_id: thread.id,
        ok: false,
        code: 'runtime_mode_unavailable',
        reason: 'Sandbox unavailable',
      }),
    )
    expect(await run(threads.view({ employeeId: f.employee }, thread.id))).toMatchObject({
      status: 'stopped',
      status_reason: 'Sandbox unavailable',
    })
  }))

it('persists runtime mode across retries and dispatch, and refuses changed or unavailable selections', () =>
  withTestDatabase(async ({ run, restart }) => {
    const f = await fixture(run)
    const first = await f.create()
    expect(first.thread.runtime_mode).toBe(P.DEFAULT_RUNTIME_MODE)
    const [command] = await run(threads.claimCommands())
    expect(command?.body.runtime_mode).toBe(P.DEFAULT_RUNTIME_MODE)
    const recovered = await restart()
    await recovered(
      query(
        `UPDATE node_runtime_reports SET report=jsonb_set(report,'{agents,0,runtime_modes}', $1::jsonb) WHERE node_id=$2`,
        JSON.stringify([
          { id: 'approval-required', available: true },
          { id: 'full-access', available: false, reason: 'Mode failed' },
        ]),
        f.node,
      ),
    )
    expect((await recovered(threads.create(f.employee, f.input))).thread.runtime_mode).toBe(P.DEFAULT_RUNTIME_MODE)
    await expect(
      recovered(threads.create(f.employee, { ...f.input, runtime_mode: 'approval-required' })),
    ).rejects.toMatchObject({ status: 409 })
    await expect(
      recovered(threads.create(f.employee, { ...f.input, client_thread_id: randomUUID() })),
    ).rejects.toMatchObject({ code: 'runtime_mode_unavailable', status: 422 })
    await expect(
      recovered(threads.create(f.employee, { ...f.input, client_thread_id: randomUUID(), runtime_mode: 'auto' })),
    ).rejects.toMatchObject({ code: 'runtime_mode_unsupported', status: 422 })
    const supervised = await recovered(
      threads.create(f.employee, {
        ...f.input,
        client_thread_id: randomUUID(),
        runtime_mode: 'approval-required',
      }),
    )
    expect(supervised.thread.runtime_mode).toBe('approval-required')
    expect(
      (await recovered(threads.claimCommands())).find((item) => item.body.thread_id === supervised.thread.id)?.body
        .runtime_mode,
    ).toBe('approval-required')
  }))

it('persists model thinking per message, rejects conflicting retries and dispatches the selection', () =>
  withTestDatabase(async ({ run }) => {
    const f = await fixture(run, true)
    const thinking = { id: 'reasoningEffort' as const, value: 'high' }
    const created = await f.create()
    expect(created.thread.next_thinking).toEqual(thinking)
    await expect(
      run(
        threads.create(f.employee, {
          ...f.input,
          message: { ...f.input.message, thinking: { ...thinking, value: 'medium' } },
        }),
      ),
    ).rejects.toMatchObject({ status: 409 })
    const thread = await open(run, f)
    const commands = await run(threads.claimCommands())
    expect(commands.find((command) => command.body.action === 'message')?.body.thinking).toEqual(thinking)
    const next = { client_message_id: randomUUID(), content: 'next', thinking }
    expect((await run(threads.addMessage(f.employee, thread.id, next))).thinking).toEqual(thinking)
    await expect(
      run(
        threads.addMessage(f.employee, thread.id, {
          ...next,
          thinking: { ...thinking, value: 'medium' },
        }),
      ),
    ).rejects.toMatchObject({ status: 409 })
    await expect(
      run(
        threads.addMessage(f.employee, thread.id, {
          client_message_id: randomUUID(),
          content: 'invalid',
          thinking: { ...thinking, value: 'unsupported' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'thinking_unavailable', status: 422 })
    const switched = await run(threads.setModel(f.employee, thread.id, { model: 'other' }))
    expect(switched.next_thinking).toBeNull()
  }))

it('returns persisted stop codes over HTTP and clears them after resume', () =>
  withTestDatabase(async ({ run, runtime }) => {
    const f = await fixture(run)
    const t = await open(run, f)
    const token = randomUUID()
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO login_sessions(id,employee_id,token_hash,csrf_hash,created_at,expires_at)
          VALUES(${randomUUID()},${f.employee},${digest(token)},${digest(sessionCSRF(token))},now(),now()+interval '1 hour')`
      }),
    )
    const scope = await Effect.runPromise(Scope.make())
    try {
      const application = await runtime.runPromise(
        httpApplication({
          allowedOrigins: ['https://baton.local'],
          signer: CredentialSigner.generate(),
          gateway: () => {
            throw new Error('Thread reads do not use the gateway')
          },
        }).pipe(Effect.provideService(Scope.Scope, scope)),
      )
      const context = await runtime.runPromise(Effect.context<SqlClient.SqlClient>())
      const handle = HttpEffect.toWebHandler(application.pipe(Effect.provideContext(context)))
      const get = async (path: string) => {
        const response = await handle(
          new Request(`https://baton.local/api/v1${path}`, {
            headers: { cookie: `baton_session=${token}`, origin: 'https://baton.local' },
          }),
        )
        expect(response.status).toBe(200)
        return response.json()
      }
      const view = async () => Schema.decodeUnknownSync(P.ThreadView)(await get(`/threads/${t.id}`))
      await run(threads.processReport(f.source, report(t.id, 3, 'thread.stopped', { reason: 'Device restarted' })))
      expect(await view()).toMatchObject({ status_reason: 'Device restarted', stop_code: 'interrupted' })
      await run(threads.stop(f.employee, t.id))
      await run(threads.processReport(f.source, report(t.id, 4, 'thread.stopped', { reason: 'Cleanup complete' })))
      expect(await view()).toMatchObject({ stop_code: 'user_stopped' })
      await run(
        threads.processReport(
          f.source,
          report(t.id, 5, 'thread.stopped', {
            reason: 'Cleanup complete',
            stop_code: 'forced_stop',
          }),
        ),
      )
      expect(await view()).toMatchObject({ stop_code: 'forced_stop' })
      await run(threads.processReport(f.source, report(t.id, 6, 'thread.resumed')))
      expect((await view()).stop_code).toBeUndefined()
      await run(
        threads.processReport(
          f.source,
          report(t.id, 7, 'thread.stopped', {
            reason: 'history_missing is quoted in this explanation',
            stop_code: 'folder_missing',
          }),
        ),
      )
      expect(await view()).toMatchObject({ stop_code: 'folder_missing' })
      await run(
        threads.processReport(
          f.source,
          report(t.id, 8, 'thread.unknown', {
            reason: 'Device ledger is unavailable',
            history_unavailable: true,
          }),
        ),
      )
      expect(await view()).toMatchObject({ stop_code: 'history_lost' })
      expect(Schema.decodeUnknownSync(P.ThreadPage)(await get('/threads')).threads).toEqual([
        expect.objectContaining({ id: t.id, stop_code: 'history_lost' }),
      ])
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  }))

it('backfills published stop reasons and report facts without changing thread data', () =>
  withTestDatabase(async ({ run }) => {
    const f = await fixture(run)
    await run(query('ALTER TABLE threads DROP COLUMN stop_code'))
    const cases: {
      reason: string
      code: P.ThreadStopCode | null
      unopened?: boolean
      confirmed?: boolean
      history?: boolean
      status?: P.Thread['status']
    }[] = [
      { reason: 'native Agent history missing', code: 'history_lost', confirmed: true },
      { reason: 'history_lost', code: 'history_lost' },
      { reason: '对话记录已丢失', code: 'history_lost' },
      { reason: 'working_directory_missing', code: 'folder_missing', unopened: true },
      { reason: '找不到工作目录', code: 'folder_missing' },
      { reason: 'Agent 没有在 1 分钟内停下，已结束进程', code: 'forced_stop', confirmed: true },
      { reason: 'forced', code: 'forced_stop' },
      { reason: '', code: 'user_stopped', confirmed: true, unopened: true },
      { reason: 'Could not launch Agent', code: 'start_failed', unopened: true },
      { reason: 'Unrecognized interruption', code: 'interrupted' },
      { reason: '', code: 'interrupted' },
      { reason: 'Ledger unavailable', code: 'history_lost', status: 'unknown', history: true },
      { reason: 'history_missing', code: null, status: 'idle' },
    ]
    const expected: { id: string; status_reason: string; stop_code: P.ThreadStopCode | null }[] = []
    for (const item of cases) {
      const { thread: t } = await run(threads.create(f.employee, { ...f.input, client_thread_id: randomUUID() }))
      await run(
        query(
          `UPDATE threads SET status=$2,status_reason=$3,
          opened_at=CASE WHEN $4::boolean THEN NULL ELSE now() END,
          stop_confirmed_at=CASE WHEN $5::boolean THEN now() ELSE NULL END WHERE id=$1`,
          t.id,
          item.status ?? 'stopped',
          item.reason,
          String(!!item.unopened),
          String(!!item.confirmed),
        ),
      )
      if (item.history)
        await run(
          query(
            `INSERT INTO thread_events(employee_id,thread_id,kind,actor,actor_id,payload)
          VALUES($1,$2,'thread.unknown','device',$3,$4::jsonb)`,
            f.employee,
            t.id,
            f.node,
            JSON.stringify({ reason: item.reason, history_unavailable: true }),
          ),
        )
      expected.push({ id: t.id, status_reason: item.reason, stop_code: item.code })
    }
    const snapshot = () =>
      run(query<{ value: object }>("SELECT to_jsonb(t)-'stop_code' AS value FROM threads t ORDER BY id"))
    const before = await snapshot()
    const migration = await readFile(
      new URL('../../../../migrations/0008_thread_stop_code.sql', import.meta.url),
      'utf8',
    )
    await run(query(`DO $stop_migration$ BEGIN ${migration} END $stop_migration$`))
    expect(await snapshot()).toEqual(before)
    const saved = await run(
      query<{ id: string; status_reason: string; stop_code: P.ThreadStopCode | null }>(
        'SELECT id,status_reason,stop_code FROM threads ORDER BY id',
      ),
    )
    expect(saved).toEqual(expected.sort((a, b) => a.id.localeCompare(b.id)))
  }))

it('persists request trace separately from business identity and dispatches it after database runtime restart', () =>
  withTestDatabase(async ({ run, restart }) => {
    const f = await fixture(run)
    const spans: Tracer.NativeSpan[] = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      },
    })
    const create = (traceId: string) =>
      run(
        withTraceSpan(threads.create(f.employee, f.input), 'http.server', {
          traceparent: `00-${traceId}-${'b'.repeat(16)}-01`,
        }).pipe(Effect.provideService(Tracer.Tracer, tracer)),
      )
    const first = await create('a'.repeat(32))
    const retry = await create('c'.repeat(32))
    expect(retry.thread.id).toBe(first.thread.id)
    const records = await run(
      query<{ trace_context: { traceparent: string } }>(
        'SELECT trace_context FROM thread_outbox WHERE thread_id=$1 ORDER BY id',
        first.thread.id,
      ),
    )
    expect(records).toHaveLength(2)
    expect(records.every((row) => row.trace_context.traceparent.split('-')[1] === 'a'.repeat(32))).toBe(true)
    const afterRestart = await restart()
    const claimed = await afterRestart(threads.claimCommands().pipe(Effect.provideService(Tracer.Tracer, tracer)))
    expect(claimed).toHaveLength(1)
    expect(claimed[0]!.body.trace_context?.traceparent.split('-')[1]).toBe('a'.repeat(32))
    const dispatch = spans.find((span) => span.name === 'baton.command.dispatch')!
    expect(Option.getOrUndefined(dispatch.parent)?.spanId).toBe(records[0]!.trace_context.traceparent.split('-')[2])
    expect(dispatch.attributes.get('baton.retry.count')).toBe(0)
    await afterRestart(
      query('UPDATE thread_outbox SET next_attempt_at=clock_timestamp() WHERE message_id=$1', claimed[0]!.message_id),
    )
    await afterRestart(threads.claimCommands().pipe(Effect.provideService(Tracer.Tracer, tracer)))
    expect(
      spans
        .filter((span) => span.name === 'baton.command.dispatch')
        .at(-1)
        ?.attributes.get('baton.retry.count'),
    ).toBe(1)
  }))

it('persists browser execution limits and dispatches idempotent settings with their original budgets', () =>
  withTestDatabase(async ({ run, restart }) => {
    const f = await fixture(run)
    const { thread } = await run(threads.create(f.employee, { ...f.input, execution_timeout_seconds: 3600 }))
    expect(thread.execution_timeout_seconds).toBe(3600)
    await expect(
      run(threads.create(f.employee, { ...f.input, execution_timeout_seconds: 3601 })),
    ).rejects.toMatchObject({ status: 409 })
    const commands = await run(threads.claimCommands())
    const opened = commands.find((item) => item.body.action === 'open')
    expect(opened?.body.execution_timeout_seconds).toBe(3600)
    if (!opened) throw new Error('Missing open command')
    await run(threads.setSettings(f.employee, thread.id, { execution_timeout_seconds: 7200 }))
    await run(
      query('UPDATE thread_outbox SET next_attempt_at=clock_timestamp() WHERE message_id=$1', opened.message_id),
    )
    const retried = await run(threads.claimCommands())
    const { trace_context: _trace, ...original } = opened.body
    expect(retried.find((item) => item.message_id === opened.message_id)?.body).toMatchObject(original)
    await run(
      threads.processReceipt(f.source, opened.message_id, {
        type: 'thread.command_result',
        thread_id: thread.id,
        ok: true,
        storage_generation: 'generation',
      }),
    )
    await run(threads.processReport(f.source, report(thread.id, 1, 'thread.opened', { native_session_id: 'native' })))
    const limit = 2147483647
    await run(threads.setSettings(f.employee, thread.id, { execution_timeout_seconds: 7200 }))
    await run(threads.setSettings(f.employee, thread.id, { execution_timeout_seconds: 7200 }))
    await run(threads.setSettings(f.employee, thread.id, { execution_timeout_seconds: limit }))
    const rows = await run(
      query<{ count: number }>(
        "SELECT count(*)::int AS count FROM thread_outbox WHERE thread_id=$1 AND action='settings'",
        thread.id,
      ),
    )
    expect(rows[0]?.count).toBe(2)
    const recovered = await restart()
    expect((await recovered(threads.view({ employeeId: f.employee }, thread.id))).execution_timeout_seconds).toBe(limit)
    const initialMessages = await recovered(threads.claimCommands())
    const initialMessage = initialMessages.find((item) => item.body.action === 'message')
    if (!initialMessage) throw new Error('Missing initial message command')
    await recovered(
      threads.processReceipt(f.source, initialMessage.message_id, {
        type: 'thread.command_result',
        thread_id: thread.id,
        ok: true,
        storage_generation: 'generation',
      }),
    )
    const dispatched = await recovered(threads.claimCommands())
    const settings = dispatched.find((item) => item.body.action === 'settings')
    expect(settings?.body.execution_timeout_seconds).toBe(7200)
    if (!settings) throw new Error('Missing settings command')
    await recovered(
      threads.processReceipt(f.source, settings.message_id, {
        type: 'thread.command_result',
        thread_id: thread.id,
        ok: true,
        storage_generation: 'generation',
      }),
    )
    await recovered(
      threads.processReceipt(f.source, settings.message_id, {
        type: 'thread.command_result',
        thread_id: thread.id,
        ok: true,
        storage_generation: 'generation',
      }),
    )
    const next = await recovered(threads.claimCommands())
    expect(next.find((item) => item.body.action === 'settings')?.body.execution_timeout_seconds).toBe(limit)
    for (const invalid of [0, -1, 1.5, 2147483648]) {
      await expect(
        recovered(threads.setSettings(f.employee, thread.id, { execution_timeout_seconds: invalid })),
      ).rejects.toMatchObject({ code: 'invalid_request', status: 422 })
      expect(Schema.is(P.CreateBrowserThreadInput)({ ...f.input, execution_timeout_seconds: invalid })).toBe(false)
    }
  }))

it('normalizes browser retries, isolates employees, admits saved roots and keeps DTOs', () =>
  withTestDatabase(async ({ run }) => {
    const f = await fixture(run)
    const [a, b] = await Promise.all([f.create(), f.create()])
    expect(a.thread.id).toBe(b.thread.id)
    expect([a.created, b.created].sort((left, right) => Number(left) - Number(right))).toEqual([false, true])
    expect((await run(threads.create(f.employee, { ...f.input, model: '' }))).created).toBe(false)
    await expect(
      run(threads.create(f.employee, { ...f.input, message: { ...f.input.message, content: 'changed' } })),
    ).rejects.toMatchObject({ status: 409 })
    const other = await fixture(run)
    for (const scope of [{ employeeId: other.employee }, { employeeId: f.employee, projectId: randomUUID() }]) {
      await expect(run(threads.view(scope, a.thread.id))).rejects.toMatchObject({ status: 404 })
      await expect(run(threads.readTurns(scope, a.thread.id))).rejects.toMatchObject({ status: 404 })
    }
    expect(await run(threads.readTurns({ employeeId: f.employee }, a.thread.id))).toEqual({
      thread_id: a.thread.id,
      turns: [],
      through_turn: 0,
      next_after_turn: 0,
    })
    await expect(
      run(threads.readTurns({ employeeId: f.employee }, a.thread.id, { afterTurn: 1, throughTurn: 0 })),
    ).rejects.toMatchObject({ code: 'invalid_range', status: 422 })
    await expect(run(threads.stop(other.employee, a.thread.id))).rejects.toMatchObject({ status: 404 })
    await expect(
      run(
        threads.create(f.employee, {
          ...f.input,
          client_thread_id: randomUUID(),
          working_directory: '/workspace-other',
        }),
      ),
    ).rejects.toMatchObject({ code: 'directory_not_allowed' })
    const m = await run(threads.addMessage(f.employee, a.thread.id, { client_message_id: 'second', content: 'next' }))
    expect(
      (
        await run(
          threads.addMessage(f.employee, a.thread.id, {
            client_message_id: 'second',
            content: 'next',
            mode: '',
            model: '',
          }),
        )
      ).id,
    ).toBe(m.id)
    await expect(
      run(threads.addMessage(f.employee, a.thread.id, { client_message_id: 'second', content: 'different' })),
    ).rejects.toMatchObject({ status: 409 })
    await expect(run(threads.setModel(f.employee, a.thread.id, { model: '' }))).rejects.toMatchObject({
      status: 422,
      code: 'model_switch_unsupported',
    })
    expect(Schema.is(P.ThreadView)(await run(threads.view({ employeeId: f.employee }, a.thread.id)))).toBe(true)
    expect(Schema.is(P.ThreadPage)(await run(threads.list(f.employee)))).toBe(true)
    expect(Schema.is(P.ThreadTimeline)(await run(threads.timeline(f.employee, a.thread.id)))).toBe(true)
    const counts = await run(
      query<{ threads: string; messages: string; commands: string }>(
        `SELECT (SELECT count(*) FROM threads)::text AS threads,(SELECT count(*) FROM thread_messages)::text AS messages,(SELECT count(*) FROM thread_outbox)::text AS commands`,
      ),
    )
    expect(counts[0]).toEqual({ threads: '1', messages: '2', commands: '3' })
  }))

it('admits explicit model IDs outside the catalog and keeps unsupported switching rejected', () =>
  withTestDatabase(async ({ run }) => {
    const f = await fixture(run)
    const { thread } = await run(threads.create(f.employee, { ...f.input, model: 'custom-model' }))
    expect(thread.model).toBe('custom-model')
    const commands = await run(threads.claimCommands())
    expect(commands.find((command) => command.body.action === 'open')?.body.model).toBe('custom-model')
    await expect(run(threads.setModel(f.employee, thread.id, { model: 'another-custom-model' }))).rejects.toMatchObject(
      { code: 'model_switch_unsupported' },
    )
    await run(
      query(
        `UPDATE node_runtime_reports SET report=jsonb_set(report,'{agents,0,capabilities,switch_model}','true'::jsonb) WHERE node_id=$1`,
        f.node,
      ),
    )
    expect((await run(threads.setModel(f.employee, thread.id, { model: 'another-custom-model' }))).next_model).toBe(
      'another-custom-model',
    )
  }))

it('persists bounded fair claims before send and survives coordinator restart', () =>
  withTestDatabase(async ({ run, restart }) => {
    const f = await fixture(run)
    const other = await fixture(run)
    for (let i = 0; i < 7; i++)
      await run(
        threads.create(f.employee, {
          ...f.input,
          client_thread_id: randomUUID(),
          message: { client_message_id: randomUUID(), content: 'hello' },
        }),
      )
    const b = await other.create()
    const first = await run(threads.claimCommands())
    expect(first.filter((c) => c.node_id === f.node).length).toBe(4)
    expect(first.some((c) => c.body.thread_id === b.thread.id)).toBe(true)
    for (const c of first) {
      const rows = await run(
        query<{ attempts: number; future: boolean }>(
          'SELECT attempts,next_attempt_at>clock_timestamp() AS future FROM thread_outbox WHERE message_id=$1',
          c.message_id,
        ),
      )
      expect(rows[0]).toEqual({ attempts: 1, future: true })
    }
    const resumed = await restart()
    await resumed(query('UPDATE thread_outbox SET next_attempt_at=clock_timestamp()'))
    const again = await resumed(threads.claimCommands())
    expect(again.some((c) => first.some((x) => x.message_id === c.message_id))).toBe(true)
    expect(again.every((c) => c.body.action === 'open')).toBe(true)
  }))

it('binds startup generation without opening and delivers early stop before queued input', () =>
  withTestDatabase(async ({ run }) => {
    const f = await fixture(run)
    const { thread } = await f.create()
    const [open] = await run(threads.claimCommands())
    await run(
      threads.processReceipt(f.source, open!.message_id, {
        type: 'thread.command_result',
        thread_id: thread.id,
        ok: true,
        storage_generation: 'generation',
      }),
    )
    const starting = await run(threads.view({ employeeId: f.employee }, thread.id))
    expect(starting.status).toBe('waiting_device')
    expect(starting.opened_at).toBeUndefined()
    expect(starting.storage_generation).toBe('generation')
    await run(threads.stop(f.employee, thread.id))
    const [stop] = await run(threads.claimCommands())
    expect(stop!.body.action).toBe('stop')
    expect(stop!.body.storage_generation).toBe('generation')
    await run(
      threads.processReport(f.source, report(thread.id, 1, 'thread.open_failed', { reason: 'startup stopped' })),
    )
    await run(
      threads.processReport(
        f.source,
        report(thread.id, 2, 'command.completed', {
          command_id: open!.message_id,
          command_outcome: 'cancelled',
          reason: 'startup stopped',
        }),
      ),
    )
    await run(threads.processReport(f.source, report(thread.id, 3, 'thread.stopped', { reason: 'startup stopped' })))
    await run(
      threads.processReport(
        f.source,
        report(thread.id, 4, 'command.completed', {
          command_id: stop!.message_id,
          command_outcome: 'succeeded',
          reason: '',
        }),
      ),
    )
    const stopped = await run(threads.view({ employeeId: f.employee }, thread.id))
    expect(stopped.status).toBe('stopped')
    expect(stopped.stop_confirmed_at).toBeTruthy()
    expect(stopped.stop_code).toBe('user_stopped')
    expect(stopped.pending_messages).toEqual([])
    expect((await run(threads.archive(f.employee, thread.id))).status).toBe('archived')
  }))

it('retries opening after a durable pre-Worker rejection without replaying the original input', () =>
  withTestDatabase(async ({ run, restart }) => {
    const f = await fixture(run)
    const { thread: t } = await f.create()
    const [initial] = await run(threads.claimCommands())
    if (!initial) throw new Error('Missing initial open command')
    await run(
      threads.processReceipt(f.source, initial.message_id, {
        type: 'thread.command_result',
        thread_id: t.id,
        ok: false,
        code: 'agent_unavailable',
      }),
    )
    const stopped = await run(threads.view({ employeeId: f.employee }, t.id))
    expect(stopped.retry_open_allowed).toBe(true)
    expect(stopped.stop_code).toBe('start_failed')
    expect(stopped.failed_messages?.[0]?.content).toBe(f.input.message.content)
    const resumed = await restart()
    await resumed(threads.resume(f.employee, t.id))
    await resumed(threads.resume(f.employee, t.id))
    const retrying = await resumed(threads.view({ employeeId: f.employee }, t.id))
    expect(retrying.resume_pending).toBe(true)
    expect(retrying.stop_code).toBeUndefined()
    const [retry] = await resumed(threads.claimCommands())
    if (!retry) throw new Error('Missing retry open command')
    expect(retry.body.action).toBe('open')
    expect(retry.message_id).not.toBe(initial.message_id)
    await resumed(
      threads.processReceipt(f.source, retry.message_id, {
        type: 'thread.command_result',
        thread_id: t.id,
        ok: true,
        storage_generation: 'generation',
      }),
    )
    await resumed(threads.processReport(f.source, report(t.id, 1, 'thread.opened', { native_session_id: 'native' })))
    await resumed(
      threads.processReport(
        f.source,
        report(t.id, 2, 'command.completed', {
          command_id: retry.message_id,
          command_outcome: 'succeeded',
          reason: '',
        }),
      ),
    )
    const opened = await resumed(threads.view({ employeeId: f.employee }, t.id))
    expect(opened.status).toBe('idle')
    expect(opened.resume_pending).toBe(false)
    expect(opened.failed_messages?.[0]?.content).toBe(f.input.message.content)
    expect(await resumed(threads.claimCommands())).toEqual([])
    await resumed(threads.addMessage(f.employee, t.id, { client_message_id: randomUUID(), content: 'continue' }))
    expect((await resumed(threads.claimCommands())).map((c) => c.body.action)).toEqual(['message'])
  }))

it.each(['worker-accepted', 'identity-conflict', 'message-dispatched'])(
  'rejects reopening when persistent evidence is unsafe: %s',
  (scenario) =>
    withTestDatabase(async ({ run }) => {
      const f = await fixture(run)
      const { thread: t } = await f.create()
      const [initial] = await run(threads.claimCommands())
      if (!initial) throw new Error('Missing initial open command')
      await run(
        threads.processReceipt(f.source, initial.message_id, {
          type: 'thread.command_result',
          thread_id: t.id,
          ok: false,
          code: scenario === 'identity-conflict' ? 'thread_already_exists' : 'agent_unavailable',
          ...(scenario === 'worker-accepted' ? { storage_generation: 'generation' } : {}),
        }),
      )
      if (scenario === 'message-dispatched')
        await run(query("UPDATE thread_outbox SET attempts=1 WHERE thread_id=$1 AND action='message'", t.id))
      expect((await run(threads.view({ employeeId: f.employee }, t.id))).retry_open_allowed).toBe(false)
      await expect(run(threads.resume(f.employee, t.id))).rejects.toMatchObject({ code: 'thread_not_opened' })
      expect(await run(threads.claimCommands())).toEqual([])
    }),
)

it('accepts completion before ACK, rejects conflicting source/generation and keeps resume pending until completion', () =>
  withTestDatabase(async ({ run, restart }) => {
    const f = await fixture(run, false, 'approval-required')
    const t = await open(run, f)
    await run(threads.processReport(f.source, report(t.id, 3, 'thread.stopped', { reason: 'exited' })))
    await run(threads.resume(f.employee, t.id))
    const commands = await run(threads.claimCommands())
    const message = commands.find((c) => c.body.action === 'message')!
    await run(
      threads.processReceipt(f.source, message.message_id, {
        type: 'thread.command_result',
        thread_id: t.id,
        ok: true,
      }),
    )
    const [resume] = await run(threads.claimCommands())
    expect(resume!.body.action).toBe('resume')
    expect(resume!.body.runtime_mode).toBe('approval-required')
    await run(
      threads.processReceipt(f.source, resume!.message_id, {
        type: 'thread.command_result',
        thread_id: t.id,
        ok: true,
      }),
    )
    await run(threads.resume(f.employee, t.id))
    expect((await run(threads.view({ employeeId: f.employee }, t.id))).resume_pending).toBe(true)
    expect(
      (await run(query<{ n: string }>("SELECT count(*)::text AS n FROM thread_outbox WHERE action='resume'")))[0]!.n,
    ).toBe('1')
    const resumed = await restart()
    expect((await resumed(threads.view({ employeeId: f.employee }, t.id))).runtime_mode).toBe('approval-required')
    expect((await resumed(threads.view({ employeeId: f.employee }, t.id))).resume_pending).toBe(true)
    await resumed(threads.processReport(f.source, report(t.id, 4, 'thread.resumed')))
    await resumed(
      threads.processReport(
        f.source,
        report(t.id, 5, 'command.completed', {
          command_id: resume!.message_id,
          command_outcome: 'succeeded',
          reason: '',
        }),
      ),
    )
    expect((await resumed(threads.view({ employeeId: f.employee }, t.id))).resume_pending).toBe(false)
    // 独立命令以完成报告先到，再补接收 ACK。
    await resumed(threads.stop(f.employee, t.id))
    const [stop] = await resumed(threads.claimCommands())
    await resumed(threads.processReport(f.source, report(t.id, 6, 'thread.stopped', { reason: 'stopped' })))
    const completion = report(t.id, 7, 'command.completed', {
      command_id: stop!.message_id,
      command_outcome: 'succeeded',
      reason: '',
    })
    await resumed(threads.processReport(f.source, completion))
    await expect(
      resumed(
        threads.processReceipt({ ...f.source, conn_id: 'old' }, stop!.message_id, {
          type: 'thread.command_result',
          thread_id: t.id,
          ok: true,
        }),
      ),
    ).rejects.toMatchObject({ status: 401 })
    await expect(
      resumed(
        threads.processReceipt(f.source, stop!.message_id, {
          type: 'thread.command_result',
          thread_id: t.id,
          ok: true,
          storage_generation: 'different',
        }),
      ),
    ).rejects.toMatchObject({ code: 'storage_generation_mismatch' })
    await resumed(
      threads.processReceipt(f.source, stop!.message_id, { type: 'thread.command_result', thread_id: t.id, ok: true }),
    )
    const saved = await resumed(
      query<{ completion: P.ThreadReport; acked_at: string | null }>(
        'SELECT completion,acked_at FROM thread_outbox WHERE message_id=$1',
        stop!.message_id,
      ),
    )
    expect(saved[0]!.completion).toEqual(completion)
    expect(saved[0]!.acked_at).toBeTruthy()
  }))

it('accepts opened and completion before startup ACK and rejects late generation changes', () =>
  withTestDatabase(async ({ run }) => {
    const f = await fixture(run)
    const { thread } = await f.create()
    const [command] = await run(threads.claimCommands())
    await run(threads.processReport(f.source, report(thread.id, 1, 'thread.opened', { native_session_id: 'native' })))
    const completion = report(thread.id, 2, 'command.completed', {
      command_id: command!.message_id,
      command_outcome: 'succeeded',
      reason: '',
    })
    await run(threads.processReport(f.source, completion))
    await expect(
      run(
        threads.processReceipt(f.source, command!.message_id, {
          type: 'thread.command_result',
          thread_id: thread.id,
          ok: true,
          storage_generation: 'old-generation',
        }),
      ),
    ).rejects.toMatchObject({ code: 'storage_generation_mismatch' })
    await run(
      threads.processReceipt(f.source, command!.message_id, {
        type: 'thread.command_result',
        thread_id: thread.id,
        ok: true,
        storage_generation: 'generation',
      }),
    )
    const rows = await run(
      query<{ completion: P.ThreadReport; acked_at: string | null }>(
        'SELECT completion,acked_at FROM thread_outbox WHERE message_id=$1',
        command!.message_id,
      ),
    )
    expect(rows[0]!.completion).toEqual(completion)
    expect(rows[0]!.acked_at).toBeTruthy()
    expect((await run(threads.view({ employeeId: f.employee }, thread.id))).native_session_id).toBe('native')
  }))

it('paginates complete ascending timeline pages and binds cursors to the employee and Thread', () =>
  withTestDatabase(async ({ run }) => {
    const f = await fixture(run)
    const { thread } = await f.create()
    for (let i = 0; i < 4; i++)
      await run(threads.addMessage(f.employee, thread.id, { client_message_id: 'm' + i, content: 'message ' + i }))
    const ids: number[] = []
    let cursor: string | undefined
    do {
      const page = await run(threads.timeline(f.employee, thread.id, { limit: '2', ...(cursor ? { cursor } : {}) }))
      ids.push(...page.events!.map((e) => e.id))
      cursor = page.next_cursor
    } while (cursor)
    const rows = await run(
      query<{ id: bigint }>('SELECT id FROM thread_events WHERE thread_id=$1 ORDER BY id ASC', thread.id),
    )
    expect(ids).toEqual(rows.map((r) => Number(r.id)))
    expect(new Set(ids).size).toBe(ids.length)
    const page = await run(threads.timeline(f.employee, thread.id, { limit: '2' }))
    const other = await run(threads.create(f.employee, { ...f.input, client_thread_id: randomUUID() }))
    await expect(
      run(threads.timeline(f.employee, other.thread.id, { cursor: page.next_cursor! })),
    ).rejects.toMatchObject({ code: 'invalid_cursor' })
    const malformed = Buffer.from(
      JSON.stringify({ scope: JSON.stringify([f.employee, thread.id]), at: 'invalid', id: 'oops' }),
    ).toString('base64url')
    await expect(run(threads.timeline(f.employee, thread.id, { cursor: malformed }))).rejects.toMatchObject({
      status: 422,
    })
  }))

it('accepts native resume after a turn ends with queued input on the same connection', () =>
  withTestDatabase(async ({ run }) => {
    const f = await fixture(run)
    const t = await open(run, f)
    const send = (seq: number, kind: P.ThreadReport['kind'], extra: Partial<P.ThreadReport> = {}) =>
      run(threads.processReport(f.source, report(t.id, seq, kind, extra)))
    await send(3, 'turn.started', { worker_turn_seq: 1, client_message_id: f.input.message.client_message_id })
    await send(4, 'message.sent', { worker_turn_seq: 1, client_message_id: f.input.message.client_message_id })
    const queued = { client_message_id: randomUUID(), content: 'queued' }
    await run(threads.addMessage(f.employee, t.id, queued))
    await send(5, 'turn.ended', { worker_turn_seq: 1, reason: 'completed', queue_empty: false })
    expect(await run(threads.view({ employeeId: f.employee }, t.id))).toMatchObject({
      status: 'running',
      current_turn: null,
    })
    expect(await send(6, 'thread.resumed', { native_session_id: 'native' })).toMatchObject({ ok: true })
    expect(await run(threads.view({ employeeId: f.employee }, t.id))).toMatchObject({
      status: 'idle',
      storage_generation: 'generation',
      native_session_id: 'native',
    })
    expect(
      await send(7, 'turn.started', { worker_turn_seq: 2, client_message_id: queued.client_message_id }),
    ).toMatchObject({ ok: true })
    expect(await run(threads.view({ employeeId: f.employee }, t.id))).toMatchObject({
      status: 'running',
      current_turn: { worker_turn_seq: 2 },
    })
  }))

it('preserves the first-message title and delivered messages in the existing Web timeline consumer', () =>
  withTestDatabase(async ({ run }) => {
    const f = await fixture(run)
    const t = await open(run, f)
    await run(
      threads.processReport(
        f.source,
        report(t.id, 3, 'turn.started', { worker_turn_seq: 1, client_message_id: f.input.message.client_message_id }),
      ),
    )
    await run(
      threads.processReport(
        f.source,
        report(t.id, 4, 'message.sent', { worker_turn_seq: 1, client_message_id: f.input.message.client_message_id }),
      ),
    )
    await run(threads.processReport(f.source, report(t.id, 5, 'reply', { worker_turn_seq: 1, content: 'First reply' })))
    await run(
      threads.processReport(
        f.source,
        report(t.id, 6, 'turn.ended', { worker_turn_seq: 1, reason: 'completed', queue_empty: true }),
      ),
    )
    await run(
      threads.addMessage(f.employee, t.id, { client_message_id: 'second-message', content: 'Newest user message' }),
    )
    await run(
      threads.processReport(
        f.source,
        report(t.id, 7, 'turn.started', { worker_turn_seq: 2, client_message_id: 'second-message' }),
      ),
    )
    await run(
      threads.processReport(
        f.source,
        report(t.id, 8, 'message.sent', { worker_turn_seq: 2, client_message_id: 'second-message' }),
      ),
    )
    await run(
      threads.processReport(f.source, report(t.id, 9, 'reply', { worker_turn_seq: 2, content: 'Second reply' })),
    )
    await run(
      threads.processReport(
        f.source,
        report(t.id, 10, 'turn.ended', { worker_turn_seq: 2, reason: 'completed', queue_empty: true }),
      ),
    )
    const webModule = new URL('../../../../web/src/data/http/threads.ts', import.meta.url).href
    const { createThreadAPI } = await import(webModule)
    const api = createThreadAPI({
      request: async (path: string) => {
        const url = new URL(path, 'https://baton.test')
        if (url.pathname === `/threads/${t.id}`) return run(threads.view({ employeeId: f.employee }, t.id))
        if (url.pathname === `/threads/${t.id}/timeline`) {
          const cursor = url.searchParams.get('cursor')
          return run(threads.timeline(f.employee, t.id, { limit: '2', ...(cursor ? { cursor } : {}) }))
        }
        throw new Error(`Unexpected Web request: ${path}`)
      },
      emit: () => {},
      devices: async () => [],
      operation: () => {
        throw new Error('Unexpected operation')
      },
    })
    const messages: Array<{ body: string; delivery: string }> = await api.listMessages(t.id)
    expect(messages).toMatchObject([
      { body: 'hello', delivery: 'delivered' },
      { body: 'First reply', delivery: 'delivered' },
      { body: 'Newest user message', delivery: 'delivered' },
      { body: 'Second reply', delivery: 'delivered' },
    ])
    expect((await api.getThread(t.id)).title).toBe('hello')
  }))

it('commits ordered turns and replies once, rolls back invalid reports, and requires stop confirmation for archive', () =>
  withTestDatabase(async ({ run }) => {
    const f = await fixture(run)
    const t = await open(run, f)
    const turn = report(t.id, 3, 'turn.started', {
      worker_turn_seq: 1,
      client_message_id: f.input.message.client_message_id,
    })
    await run(threads.processReport(f.source, turn))
    await run(
      threads.processReport(
        f.source,
        report(t.id, 4, 'message.sent', { worker_turn_seq: 1, client_message_id: f.input.message.client_message_id }),
      ),
    )
    const reply = report(t.id, 5, 'reply', { worker_turn_seq: 1, content: 'answer' })
    const gap = await run(threads.processReport(f.source, { ...reply, worker_seq: 7 }))
    expect(gap).toMatchObject({ ok: false, expected_worker_seq: 5 })
    await expect(run(threads.processReport(f.source, { ...reply, worker_turn_seq: 99 }))).rejects.toMatchObject({
      status: 409,
    })
    expect((await run(threads.view({ employeeId: f.employee }, t.id))).last_worker_seq).toBe(4)
    const ack = await run(threads.processReport(f.source, reply))
    expect(await run(threads.processReport(f.source, reply))).toEqual(ack)
    expect(
      await run(
        threads.processReport(f.source, {
          ...reply,
          trace_context: { traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01` },
        }),
      ),
    ).toEqual(ack)
    await expect(run(threads.processReport(f.source, { ...reply, content: 'conflict' }))).rejects.toMatchObject({
      status: 409,
    })
    expect((await run(query<{ n: string }>('SELECT count(*)::text AS n FROM thread_replies')))[0]!.n).toBe('1')
    const timeline = await run(threads.timeline(f.employee, t.id))
    expect(timeline.events?.find((event) => event.kind === 'reply')?.payload).toMatchObject({ attachments: [] })
    const history = await run(threads.readTurns({ employeeId: f.employee }, t.id))
    expect(history.turns[0]?.replies[0]?.attachments).toEqual([])
    expect((await run(threads.archive(f.employee, t.id))).status).toBe('running')
    await run(
      threads.processReport(
        f.source,
        report(t.id, 6, 'turn.ended', { worker_turn_seq: 1, reason: 'stopped', queue_empty: true }),
      ),
    )
    const effects = await run(
      query<{ n: string }>("SELECT count(*)::text AS n FROM thread_events WHERE kind='thread.archived'"),
    )
    expect(effects[0]!.n).toBe('1')
    await run(threads.processReport(f.source, report(t.id, 7, 'thread.stopped', { reason: 'cleanup complete' })))
    expect((await run(threads.view({ employeeId: f.employee }, t.id))).status).toBe('archived')
  }))

it('reports a stop the device rejected and sends a new stop on retry', () =>
  withTestDatabase(async ({ run }) => {
    const f = await fixture(run)
    const t = await open(run, f)
    for (const command of await run(threads.claimCommands()))
      await run(
        threads.processReceipt(f.source, command.message_id, {
          type: 'thread.command_result',
          thread_id: t.id,
          ok: true,
          storage_generation: 'generation',
        }),
      )
    await run(
      threads.processReport(
        f.source,
        report(t.id, 3, 'turn.started', { worker_turn_seq: 1, client_message_id: f.input.message.client_message_id }),
      ),
    )
    const requested = await run(threads.stop(f.employee, t.id))
    expect(requested.stop_failure).toBeNull()
    const stop = (await run(threads.claimCommands())).find((c) => c.body.action === 'stop')!
    await run(
      threads.processReceipt(f.source, stop.message_id, {
        type: 'thread.command_result',
        thread_id: t.id,
        ok: false,
        code: 'stop_unavailable',
      }),
    )
    const failed = await run(threads.view({ employeeId: f.employee }, t.id))
    expect(failed).toMatchObject({ status: 'running', stop_failure: 'stop_unavailable' })
    expect(failed.stop_confirmed_at).toBeFalsy()
    const listed = await run(threads.list(f.employee))
    expect(listed.threads?.find((item) => item.id === t.id)?.stop_failure).toBe('stop_unavailable')

    expect((await run(threads.stop(f.employee, t.id))).stop_failure).toBeNull()
    const retry = (await run(threads.claimCommands())).filter((c) => c.body.action === 'stop')
    expect(retry).toHaveLength(1)
    expect(retry[0]!.message_id).not.toBe(stop.message_id)
  }))

it('classifies missing history by durable dispatch facts and rejects replaced connections', () =>
  withTestDatabase(async ({ run, restart }) => {
    const f = await fixture(run)
    const t = await open(run, f)
    await run(threads.claimCommands())
    const unsent = await run(
      threads.addMessage(f.employee, t.id, { client_message_id: randomUUID(), content: 'never dispatched' }),
    )
    await run(threads.processReport(f.source, report(t.id, 3, 'thread.stopped', { reason: 'exited' })))
    await run(threads.resume(f.employee, t.id))
    expect((await run(threads.view({ employeeId: f.employee }, t.id))).resume_pending).toBe(true)
    await run(threads.stop(f.employee, t.id))
    await run(
      threads.processReport(
        f.source,
        report(t.id, 4, 'thread.stopped', { reason: 'history missing', history_unavailable: true }),
      ),
    )
    const lost = await run(threads.view({ employeeId: f.employee }, t.id))
    expect(lost.resume_pending).toBe(false)
    expect(lost.status).toBe('unknown')
    expect(lost.stop_code).toBe('history_lost')
    expect(lost.stop_requested_at).toBeTruthy()
    expect(lost.stop_confirmed_at).toBeFalsy()
    const pending = await run(
      query<{ n: string }>('SELECT count(*)::text AS n FROM thread_outbox WHERE completed_at IS NULL'),
    )
    expect(pending[0]!.n).toBe('0')
    const messages = await run(
      query<{ status: string; client_message_id: string }>('SELECT status,client_message_id FROM thread_messages'),
    )
    expect(messages.find((m) => m.client_message_id === f.input.message.client_message_id)?.status).toBe('unknown')
    expect(messages.find((m) => m.client_message_id === unsent.client_message_id)?.status).toBe('withdrawn')
    const outcomes = await run(
      query<{ attempts: number; outcome: string }>(
        "SELECT attempts,completion->>'command_outcome' AS outcome FROM thread_outbox WHERE action<>'open'",
      ),
    )
    expect(outcomes.every((o) => o.outcome === (o.attempts === 0 ? 'cancelled' : 'unknown'))).toBe(true)
    const resumed = await restart()
    const restored = await resumed(threads.view({ employeeId: f.employee }, t.id))
    expect(restored.pending_messages?.map((m) => m.client_message_id)).toEqual([f.input.message.client_message_id])
    expect(restored.failed_messages?.map((m) => m.client_message_id)).toContain(unsent.client_message_id)
    expect(await resumed(threads.claimCommands())).toEqual([])
    await resumed(threads.withdraw(f.employee, t.id, unsent.id))
    await run(query("UPDATE node_presence SET conn_id='replacement'"))
    await expect(run(threads.processReport(f.source, report(t.id, 5, 'thread.stopped')))).rejects.toMatchObject({
      status: 401,
    })
    expect((await run(threads.view({ employeeId: f.employee }, t.id))).last_worker_seq).toBe(4)
  }))

it.each([true, false])('archives unknown history only after stop confirmation (archive first: %s)', (archiveFirst) =>
  withTestDatabase(async ({ run }) => {
    const f = await fixture(run)
    const t = await open(run, f)
    await run(threads.claimCommands())
    await run(
      threads.processReport(
        f.source,
        report(t.id, 3, 'message.unknown', {
          client_message_id: f.input.message.client_message_id,
          reason: 'Native acceptance is uncertain',
        }),
      ),
    )
    if (archiveFirst) expect((await run(threads.archive(f.employee, t.id))).status).toBe('unknown')
    else await run(threads.stop(f.employee, t.id))
    await run(threads.processReport(f.source, report(t.id, 4, 'thread.unknown', { history_unavailable: true })))
    const uncertain = await run(threads.view({ employeeId: f.employee }, t.id))
    expect(uncertain.status).toBe('unknown')
    expect(uncertain.stop_confirmed_at).toBeFalsy()
    await run(threads.processReport(f.source, report(t.id, 5, 'thread.stopped', { reason: 'Process tree reclaimed' })))
    if (!archiveFirst) await run(threads.archive(f.employee, t.id))
    const archived = await run(threads.view({ employeeId: f.employee }, t.id))
    expect(archived.status).toBe('archived')
    expect(archived.stop_confirmed_at).toBeTruthy()
    expect(archived.pending_messages?.[0]).toMatchObject({ status: 'unknown', content: f.input.message.content })
    expect(await run(threads.claimCommands())).toEqual([])
  }),
)

it.each(['resume', 'message'])('expires an earlier stop confirmation before dispatching %s', (next) =>
  withTestDatabase(async ({ run }) => {
    const f = await fixture(run)
    const t = await open(run, f)
    await run(threads.claimCommands())
    await run(threads.processReport(f.source, report(t.id, 3, 'thread.unknown', { history_unavailable: true })))
    await run(threads.stop(f.employee, t.id))
    const [stop] = await run(threads.claimCommands())
    if (!stop) throw new Error('Missing stop command')
    await run(threads.processReport(f.source, report(t.id, 4, 'thread.stopped')))
    await run(
      threads.processReport(
        f.source,
        report(t.id, 5, 'command.completed', {
          command_id: stop.message_id,
          command_outcome: 'succeeded',
          reason: '',
        }),
      ),
    )
    expect((await run(threads.view({ employeeId: f.employee }, t.id))).stop_confirmed_at).toBeTruthy()
    if (next === 'resume') await run(threads.resume(f.employee, t.id))
    else await run(threads.addMessage(f.employee, t.id, { client_message_id: randomUUID(), content: 'new input' }))
    const dispatched = await run(threads.claimCommands())
    expect(dispatched.map((c) => c.body.action)).toEqual([next])
    expect((await run(threads.view({ employeeId: f.employee }, t.id))).stop_confirmed_at).toBeUndefined()
    await run(threads.processReport(f.source, report(t.id, 6, 'thread.unknown', { history_unavailable: true })))
    expect((await run(threads.archive(f.employee, t.id))).status).toBe('unknown')
    await run(threads.processReport(f.source, report(t.id, 7, 'thread.stopped')))
    expect((await run(threads.view({ employeeId: f.employee }, t.id))).status).toBe('archived')
  }),
)

async function holdLock(run: Run, table: 'threads' | 'thread_outbox', id: string) {
  let acquired!: () => void
  let release!: () => void
  const ready = new Promise<void>((resolve) => {
    acquired = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const held = run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql.unsafe(
            `SELECT id FROM ${table} WHERE ${table === 'threads' ? 'id' : 'message_id'}=$1 FOR UPDATE`,
            [id],
          )
          yield* Effect.sync(acquired)
          yield* Effect.promise(() => gate)
        }),
      )
    }),
  )
  await ready
  return async () => {
    release()
    await held
  }
}

it('skips locked outbox and Thread rows without starving another device', () =>
  withTestDatabase(async ({ run }) => {
    const a = await fixture(run)
    const b = await fixture(run)
    const c = await fixture(run)
    const ta = await a.create()
    await b.create()
    const tc = await c.create()
    const rows = await run(
      query<{ message_id: string }>(
        "SELECT message_id FROM thread_outbox WHERE thread_id=$1 AND action='open'",
        ta.thread.id,
      ),
    )
    const releaseOutbox = await holdLock(run, 'thread_outbox', rows[0]!.message_id)
    const releaseThread = await holdLock(run, 'threads', tc.thread.id)
    try {
      const commands = await run(threads.claimCommands())
      expect(commands.map((c) => c.node_id)).toEqual([b.node])
    } finally {
      await releaseThread()
      await releaseOutbox()
    }
  }))

it('rechecks credential expiry after waiting for the Thread lock and commits no partial report', () =>
  withTestDatabase(async ({ run }) => {
    const f = await fixture(run)
    const t = await open(run, f)
    await run(
      query(
        "UPDATE node_credentials SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE id=$1",
        f.credential,
      ),
    )
    const release = await holdLock(run, 'threads', t.id)
    let pid = 0
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const saving = run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`
            yield* Effect.sync(() => {
              pid = rows[0]!.pid
              started()
            })
            return yield* threads.processReport(f.source, report(t.id, 3, 'thread.stopped', { reason: 'finished' }))
          }),
        )
      }),
    ).then(
      (value) => ({ value, error: undefined }),
      (error) => ({ value: undefined, error }),
    )
    try {
      await ready
      let waiting = false
      for (let i = 0; i < 100; i++) {
        const rows = await run(
          query<{ waiting: boolean }>(
            "SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",
            pid,
          ),
        )
        if (rows[0]?.waiting) {
          waiting = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(waiting).toBe(true)
      await run(
        query(
          'SELECT pg_sleep(GREATEST(0,extract(epoch FROM expires_at-clock_timestamp()))+0.02) FROM node_credentials WHERE id=$1',
          f.credential,
        ),
      )
    } finally {
      await release()
    }
    expect((await saving).error).toMatchObject({ status: 401 })
    const view = await run(threads.view({ employeeId: f.employee }, t.id))
    expect(view.status).toBe('idle')
    expect(view.last_worker_seq).toBe(2)
    expect(
      (await run(query<{ n: string }>("SELECT count(*)::text AS n FROM thread_events WHERE kind='thread.stopped'")))[0]!
        .n,
    ).toBe('0')
  }))

it('rejects revoked or expired source before committing business reports', () =>
  withTestDatabase(async ({ run }) => {
    const f = await fixture(run)
    const t = await open(run, f)
    await run(
      query(
        "UPDATE node_credentials SET expires_at=clock_timestamp()-interval '1 second',created_at=clock_timestamp()-interval '1 day' WHERE id=$1",
        f.credential,
      ),
    )
    await expect(run(threads.processReport(f.source, report(t.id, 3, 'thread.stopped')))).rejects.toMatchObject({
      status: 401,
    })
    expect((await run(threads.view({ employeeId: f.employee }, t.id))).last_worker_seq).toBe(2)
    await run(
      query(
        "UPDATE node_credentials SET expires_at=clock_timestamp()+interval '1 day',revoked_at=clock_timestamp() WHERE id=$1",
        f.credential,
      ),
    )
    await expect(run(threads.processReport(f.source, report(t.id, 3, 'thread.stopped')))).rejects.toMatchObject({
      status: 401,
    })
  }))

it('paginates conversations separately from shell executions and preserves execution details', () =>
  withTestDatabase(async ({ run }) => {
    const f = await fixture(run)
    const first = (await f.create()).thread
    const second = (
      await run(
        threads.create(f.employee, {
          ...f.input,
          client_thread_id: randomUUID(),
          message: { ...f.input.message, client_message_id: randomUUID() },
        }),
      )
    ).thread
    const shell = (
      await run(
        threads.create(f.employee, {
          ...f.input,
          client_thread_id: randomUUID(),
          message: { ...f.input.message, client_message_id: randomUUID() },
        }),
      )
    ).thread.id
    await run(
      query(
        "UPDATE threads SET agent_type='shell',status='running',last_activity_at=clock_timestamp()+interval '1 minute' WHERE id=$1",
        shell,
      ),
    )
    const page1 = await run(threads.list(f.employee, { limit: '1' }))
    expect(page1.threads).toHaveLength(1)
    expect(page1.next_cursor).toBeDefined()
    const page2 = await run(threads.list(f.employee, { limit: '1', cursor: page1.next_cursor! }))
    expect(new Set([...page1.threads!, ...page2.threads!].map((t) => t.id))).toEqual(new Set([first.id, second.id]))
    expect(page2.next_cursor).toBeUndefined()
    expect((await run(threads.list(f.employee, { kind: 'execution' }))).threads!.map((t) => t.id)).toEqual([shell])
    expect((await run(threads.view({ employeeId: f.employee }, shell))).id).toBe(shell)
    expect((await run(activitySnapshot(f.employee))).running_count).toBe(0)
  }))
