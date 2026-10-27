import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as P from '@baton/protocol'
import { expect, it } from 'vite-plus/test'
import { seedNode, withTestDatabase, type TestDatabase } from '../testing/database.ts'
import * as threads from './index.ts'

type Run = TestDatabase['run']
const query = (text: string, ...args: string[]) => Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(text, args))
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
    await run(threads.processReceipt(f.source, check!.message_id, result))
    expect(await credential(run, f.credentialId)).not.toEqual(before)
    const duplicate = await reset(run, f.credentialId)
    await run(threads.processReceipt(f.source, check!.message_id, result))
    expect(await credential(run, f.credentialId)).toEqual(duplicate)
    const expiredCommand = randomUUID()
    const [expiredCheck] = await run(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql<{ check_seq: number }>`
      INSERT INTO thread_events(employee_id,thread_id,kind,actor,actor_id,payload,created_at)
      VALUES(${f.employeeId},${f.thread.id},'turn.activity_check','system',${f.nodeId},
        ${JSON.stringify({ command_id: expiredCommand, conn_id: f.source.conn_id, worker_turn_seq: 1 })}::jsonb,
        clock_timestamp()-interval '2 minutes') RETURNING id::float8 AS check_seq`,
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
  }))
