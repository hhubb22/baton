import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as P from '@baton/protocol'
import { expect, it } from 'vite-plus/test'
import { seedNode, withTestDatabase, type TestDatabase } from '../testing/database.ts'
import * as threads from './index.ts'

type Run = TestDatabase['run']
const query = <A extends object = Record<string, unknown>>(text: string, ...args: string[]) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<A>(text, args))
const credential = (run: Run, id: string) =>
  run(query('SELECT expires_at::text,last_business_at::text FROM node_credentials WHERE id=$1', id))
const reset = async (run: Run, id: string) => {
  await run(
    query(
      "UPDATE node_credentials SET expires_at=clock_timestamp()+interval '1 day',last_business_at=clock_timestamp()-interval '29 days' WHERE id=$1",
      id,
    ),
  )
  return credential(run, id)
}
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

it('renews only the first successful receipt and new valid reports on the source device', () =>
  withTestDatabase(async ({ run }) => {
    const f = await fixture(run)
    const other = await seedNode(run, { employeeId: f.employeeId })
    const otherBefore = await credential(run, other.credentialId)
    const before = await reset(run, f.credentialId)
    await run(threads.processReceipt(f.source, f.command.message_id, f.receipt))
    expect(await credential(run, f.credentialId)).not.toEqual(before)
    const repeated = await reset(run, f.credentialId)
    await run(threads.processReceipt(f.source, f.command.message_id, f.receipt))
    expect(await credential(run, f.credentialId)).toEqual(repeated)
    const opened = f.report('thread.opened')
    await run(threads.processReport(f.source, opened))
    expect(await credential(run, f.credentialId)).not.toEqual(repeated)
    const duplicate = await reset(run, f.credentialId)
    await run(threads.processReport(f.source, opened))
    await expect(
      run(threads.processReport(f.source, { ...opened, event_id: randomUUID(), worker_seq: 2, kind: 'turn.started' })),
    ).rejects.toMatchObject({ code: 'thread_conflict' })
    const gap = await run(threads.processReport(f.source, { ...opened, event_id: randomUUID(), worker_seq: 10 }))
    expect(gap.ok).toBe(false)
    expect(await credential(run, f.credentialId)).toEqual(duplicate)
    expect(await credential(run, other.credentialId)).toEqual(otherBefore)
  }))

it('does not renew rejected commands or dispatch or accept work with an expired credential', () =>
  withTestDatabase(async ({ run }) => {
    const f = await fixture(run)
    const before = await reset(run, f.credentialId)
    await run(threads.processReceipt(f.source, f.command.message_id, { ...f.receipt, ok: false, code: 'unsupported' }))
    expect(await credential(run, f.credentialId)).toEqual(before)
    const g = await fixture(run)
    await run(
      query(
        "UPDATE node_credentials SET created_at=clock_timestamp()-interval '31 days',last_business_at=clock_timestamp()-interval '31 days',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        g.credentialId,
      ),
    )
    const expired = await credential(run, g.credentialId)
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
      code: 'node_idle_expired',
    })
    await expect(run(threads.processReport(g.source, g.report('thread.opened')))).rejects.toMatchObject({
      code: 'node_idle_expired',
    })
    expect(await credential(run, g.credentialId)).toEqual(expired)
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
    const before = await reset(run, f.credentialId)
    const [check] = (await run(threads.claimCommands())).filter((c) => c.body.action === 'check_activity')
    expect(check).toBeDefined()
    expect(await credential(run, f.credentialId)).toEqual(before)
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
    expect(await credential(run, f.credentialId)).toEqual(before)
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
    expect(await credential(run, f.credentialId)).not.toEqual(before)
    await run(
      threads.processReceipt(f.source, nextCheck!.message_id, {
        ...result,
        activity_check_seq: nextCheck!.body.activity_check_seq!,
      }),
    )
    const duplicate = await reset(run, f.credentialId)
    await run(threads.processReceipt(f.source, check!.message_id, result))
    expect(await credential(run, f.credentialId)).toEqual(duplicate)
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
    expect(await credential(run, f.credentialId)).toEqual(duplicate)
    await run(query("UPDATE node_presence SET conn_id='new-connection' WHERE node_id=$1", f.nodeId))
    await expect(
      run(threads.processReceipt({ ...f.source, conn_id: 'new-connection' }, check!.message_id, result)),
    ).rejects.toMatchObject({ code: 'activity_check_rejected' })
    expect(await credential(run, f.credentialId)).toEqual(duplicate)
    expect(
      await run(query("SELECT id FROM thread_events WHERE kind IN ('turn.activity_check','turn.activity_checked')")),
    ).toEqual([])
  }))

it('migrates live and acknowledged challenges without changing business history or message bodies', () =>
  withTestDatabase(async ({ run }) => {
    const f = await fixture(run)
    const history = await run(query('SELECT * FROM thread_events ORDER BY id'))
    const messages = await run(query('SELECT * FROM thread_messages ORDER BY id'))
    await run(query('DROP TABLE thread_activity_probes'))
    await run(query('DROP SEQUENCE thread_activity_check_seq'))
    const commands = [randomUUID(), randomUUID(), randomUUID()]
    const checks = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const rows: { check_seq: number }[] = []
        for (const command of commands) {
          const [row] = yield* sql<{
            check_seq: number
          }>`INSERT INTO thread_events(employee_id,thread_id,kind,actor,actor_id,payload)
          VALUES(${f.employeeId},${f.thread.id},'turn.activity_check','system',${f.nodeId},
            ${JSON.stringify({ command_id: command, conn_id: f.source.conn_id, worker_turn_seq: 1 })}::jsonb)
          RETURNING id::float8 AS check_seq`
          rows.push(row!)
        }
        return rows
      }),
    )
    const result: P.ThreadCommandResult = {
      ...f.receipt,
      ok: false,
      code: 'worker_unavailable',
      activity_check_seq: checks[0]!.check_seq,
    }
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO thread_events(employee_id,thread_id,kind,actor,actor_id,payload)
        VALUES(${f.employeeId},${f.thread.id},'turn.activity_checked','device',${f.nodeId},${JSON.stringify(result)}::jsonb)`
      }),
    )
    const migration = await readFile(
      new URL('../../../../migrations/0009_thread_activity_probes.sql', import.meta.url),
      'utf8',
    )
    for (const statement of migration.split(';').filter((part) => part.trim())) await run(query(statement))
    expect(await run(query('SELECT * FROM thread_events ORDER BY id'))).toEqual(history)
    expect(await run(query('SELECT * FROM thread_messages ORDER BY id'))).toEqual(messages)
    const before = await credential(run, f.credentialId)
    await run(threads.processReceipt(f.source, commands[0]!, result))
    await run(threads.processReceipt(f.source, commands[2]!, { ...result, activity_check_seq: checks[2]!.check_seq }))
    await expect(
      run(threads.processReceipt(f.source, commands[1]!, { ...result, activity_check_seq: checks[1]!.check_seq })),
    ).rejects.toMatchObject({ code: 'activity_check_rejected' })
    expect(await credential(run, f.credentialId)).toEqual(before)
    const [sequence] = await run(
      query<{ value: number }>("SELECT nextval('thread_activity_check_seq')::float8 AS value"),
    )
    expect(sequence!.value).toBeGreaterThan(checks[2]!.check_seq)
    await expect(
      run(threads.processReceipt(f.source, commands[0]!, { ...result, code: 'different' })),
    ).rejects.toMatchObject({ code: 'thread_conflict' })
    expect(await run(query('SELECT thread_id FROM thread_activity_probes'))).toEqual([{ thread_id: f.thread.id }])
    await expect(run(query('DELETE FROM thread_events'))).rejects.toBeDefined()
  }))
