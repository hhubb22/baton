import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as P from '@baton/protocol'
import { expect, it } from 'vite-plus/test'
import { seedNode, withTestDatabase, type TestDatabase } from '../testing/database.ts'
import * as threads from './index.ts'

type Run = TestDatabase['run']
const query = <A extends object = Record<string, unknown>>(text: string, ...args: string[]) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<A>(text, args))
async function fixture(run: Run) {
  const node = await seedNode(run, {
    report: {
      roots: [{ root_id: 'root', path: '/workspace' }],
      repos: [],
      exec: { enabled: false, shell: '/bin/sh' },
      agents: [
        {
          agent_type: 'cursor',
          status: 'available',
          version: 'offline',
          models: [],
          default_model: '',
          runtime_modes: [{ id: 'full-access', available: true }],
          default_runtime_mode: 'full-access',
          capabilities: { create: true, queue: true, steer: false, stop: true, resume: true, switch_model: false },
        },
      ],
    },
  })
  const input: P.CreateBrowserThreadInput = {
    client_thread_id: randomUUID(),
    node_id: node.nodeId,
    agent_type: 'cursor',
    working_directory: '/workspace',
    message: { client_message_id: randomUUID(), content: 'hello' },
  }
  const { thread } = await run(threads.create(node.employeeId, input))
  const [command] = await run(threads.claimCommands())
  const receipt: P.ThreadCommandResult = {
    type: 'thread.command_result',
    thread_id: thread.id,
    ok: true,
    storage_generation: 'generation',
  }
  let seq = 0
  const report = (kind: P.ThreadReport['kind'], extra: Partial<P.ThreadReport> = {}): P.ThreadReport => ({
    type: 'thread.report',
    thread_id: thread.id,
    event_id: randomUUID(),
    storage_generation: 'generation',
    worker_seq: ++seq,
    kind,
    ...extra,
  })
  return { ...node, input, thread, command: command!, receipt, report }
}

it('accepts repeated receipts and leaves report ordering conflicts on the source device', () =>
  withTestDatabase(async ({ run }) => {
    const f = await fixture(run)
    await run(threads.processReceipt(f.source, f.command.message_id, f.receipt))
    await run(threads.processReceipt(f.source, f.command.message_id, f.receipt))
    const opened = f.report('thread.opened')
    await run(threads.processReport(f.source, opened))
    await run(threads.processReport(f.source, opened))
    await expect(
      run(threads.processReport(f.source, { ...opened, event_id: randomUUID(), worker_seq: 2, kind: 'turn.started' })),
    ).rejects.toMatchObject({ code: 'thread_conflict' })
    const gap = await run(threads.processReport(f.source, { ...opened, event_id: randomUUID(), worker_seq: 10 }))
    expect(gap.ok).toBe(false)
  }))

it('does not record rejected commands or dispatch or accept work with a revoked credential', () =>
  withTestDatabase(async ({ run }) => {
    const f = await fixture(run)
    await run(threads.processReceipt(f.source, f.command.message_id, { ...f.receipt, ok: false, code: 'unsupported' }))
    const g = await fixture(run)
    await run(query('UPDATE node_credentials SET revoked_at=clock_timestamp() WHERE id=$1', g.credentialId))
    const attempts = await run(query('SELECT attempts FROM thread_outbox WHERE thread_id=$1', g.thread.id))
    await run(
      query(
        "UPDATE thread_outbox SET next_attempt_at=clock_timestamp()-interval '1 minute' WHERE thread_id=$1",
        g.thread.id,
      ),
    )
    expect(await run(threads.claimCommands())).toEqual([])
    expect(await run(query('SELECT attempts FROM thread_outbox WHERE thread_id=$1', g.thread.id))).toEqual(attempts)
    await expect(run(threads.processReceipt(g.source, g.command.message_id, g.receipt))).rejects.toMatchObject({
      code: 'node_source_rejected',
    })
    await expect(run(threads.processReport(g.source, g.report('thread.opened')))).rejects.toMatchObject({
      code: 'node_source_rejected',
    })
  }))

it('requires a fresh connection-bound Worker status challenge for a long turn', () =>
  withTestDatabase(async ({ run }) => {
    const f = await fixture(run)
    await run(threads.processReceipt(f.source, f.command.message_id, f.receipt))
    await run(threads.processReport(f.source, f.report('thread.opened')))
    await run(
      threads.processReport(
        f.source,
        f.report('turn.started', {
          worker_turn_seq: 1,
          client_message_id: f.input.message.client_message_id,
          execution_id: 'execution',
        }),
      ),
    )
    await run(
      query("UPDATE threads SET last_reported_at=clock_timestamp()-interval '1 minute' WHERE id=$1", f.thread.id),
    )
    const [check] = (await run(threads.claimCommands())).filter((c) => c.body.action === 'check_activity')
    expect(check).toBeDefined()
    expect((await run(threads.claimCommands())).filter((c) => c.body.action === 'check_activity')).toEqual([])
    const result: P.ThreadCommandResult = {
      ...f.receipt,
      activity_check_seq: check!.body.activity_check_seq!,
      active_turn: { worker_turn_seq: 1, execution_id: 'execution' },
    }
    await expect(
      run(
        threads.processReceipt(f.source, check!.message_id, {
          ...result,
          active_turn: { worker_turn_seq: 1, execution_id: 'stale-execution' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'activity_check_rejected' })
    await run(
      query(
        `UPDATE thread_activity_probes SET checks=jsonb_set(checks,
      ARRAY[$2,'issued_at'],to_jsonb(extract(epoch FROM clock_timestamp()-interval '31 seconds')))
      WHERE thread_id=$1`,
        f.thread.id,
        String(result.activity_check_seq),
      ),
    )
    const [nextCheck] = (await run(threads.claimCommands())).filter((c) => c.body.action === 'check_activity')
    expect(nextCheck!.body.activity_check_seq).toBeGreaterThan(result.activity_check_seq!)
    await run(threads.processReceipt(f.source, check!.message_id, result))
    await run(
      threads.processReceipt(f.source, nextCheck!.message_id, {
        ...result,
        activity_check_seq: nextCheck!.body.activity_check_seq!,
      }),
    )
    await run(threads.processReceipt(f.source, check!.message_id, result))
    const expiredCommand = randomUUID()
    const [expiredCheck] = await run(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql<{ check_seq: number }>`
      WITH seq AS (SELECT nextval('thread_activity_check_seq') AS id)
      UPDATE thread_activity_probes SET checks=checks || jsonb_build_object(seq.id::text,
        ${JSON.stringify({ command_id: expiredCommand, conn_id: f.source.conn_id, worker_turn_seq: 1 })}::jsonb ||
        jsonb_build_object('issued_at',extract(epoch FROM clock_timestamp()-interval '2 minutes')))
      FROM seq WHERE thread_id=${f.thread.id} RETURNING seq.id::float8 AS check_seq`,
      ),
    )
    await expect(
      run(
        threads.processReceipt(f.source, expiredCommand, {
          ...result,
          activity_check_seq: expiredCheck!.check_seq,
        }),
      ),
    ).rejects.toMatchObject({ code: 'activity_check_rejected' })
    await run(query("UPDATE node_presence SET conn_id='new-connection' WHERE node_id=$1", f.nodeId))
    await expect(
      run(threads.processReceipt({ ...f.source, conn_id: 'new-connection' }, check!.message_id, result)),
    ).rejects.toMatchObject({ code: 'activity_check_rejected' })
    expect(
      await run(query("SELECT id FROM thread_events WHERE kind IN ('turn.activity_check','turn.activity_checked')")),
    ).toEqual([])
  }))
