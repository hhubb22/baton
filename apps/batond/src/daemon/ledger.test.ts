import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Effect } from 'effect'
import { expect, it } from 'vite-plus/test'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { makeNodeLedger } from './ledger.ts'

it('queries only pending reports while retaining confirmed history', async () => {
  const directory = await makePrivateTempDirectory('baton-pending-')
  const filename = join(directory, 'node.db')
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ledger = yield* makeNodeLedger(filename)
          const db = new DatabaseSync(filename)
          try {
            db.prepare(
              "INSERT INTO threads(thread_id,storage_generation,startup_phase,config_json,meta_json,control_json) VALUES('thread','generation','open_attempted','{}','{}','{}')",
            ).run()
            const insert = db.prepare(
              'INSERT INTO thread_outbox(thread_id,seq,event_id,hash,payload,created_ms,acked) VALUES(?,?,?,?,?,?,?)',
            )
            const report = (seq: number) => ({
              type: 'thread.report',
              thread_id: 'thread',
              storage_generation: 'generation',
              worker_seq: seq,
              event_id: randomUUID(),
              kind: 'thread.opened',
            })
            db.exec('BEGIN')
            for (let seq = 1; seq <= 1000; seq++) {
              const item = report(seq)
              insert.run('thread', seq, item.event_id, '', JSON.stringify(item), seq, seq < 999 ? 1 : 0)
            }
            db.exec('COMMIT')
            expect((yield* ledger.pendingReports()).map((item) => item.worker_seq)).toEqual([999, 1000])
            expect(yield* ledger.reportBacklog()).toEqual({ count: 2, oldest_ms: 999 })
            expect(db.prepare('SELECT count(*) AS count FROM thread_outbox WHERE acked=1').get()!.count).toBe(998)
            const plan = db
              .prepare(
                'EXPLAIN QUERY PLAN SELECT payload FROM thread_outbox WHERE acked=0 ORDER BY thread_id,seq LIMIT 128',
              )
              .all()
            expect(plan.some((row) => String(row.detail).includes('thread_outbox_pending'))).toBe(true)
          } finally {
            db.close()
          }
        }),
      ),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
