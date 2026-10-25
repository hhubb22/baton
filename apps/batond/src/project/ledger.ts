import { Effect } from 'effect'
import * as Sqlite from '@baton/sqlite'
import * as Reactivity from 'effect/reactivity/Reactivity'
import type { ProjectRunCommand } from '@baton/protocol'
import type { ProcessRecord } from '../platform/process.ts'

export interface RunRow {
  run_id: string
  lease_epoch: number
  state: string
  reason: string
  cleanup_complete: number
  cleanup_acked: number
  cleanup_next_at: number
  cleanup_attempts: number
}
export const makeProjectLedger = Effect.fn('Project.makeProjectLedger')(function* (filename: string) {
  const sql = yield* Sqlite.make({
    filename,
    busyTimeoutMs: 100,
    commitVerification: {
      writeToken: (token) => ({ sql: 'UPDATE project_commit SET commit_token=? WHERE id=1', params: [token] }),
      readToken: { sql: 'SELECT commit_token FROM project_commit WHERE id=1' },
    },
  }).pipe(Effect.provide(Reactivity.layer))
  yield* sql.unsafe(
    'CREATE TABLE IF NOT EXISTS project_commit(id INTEGER PRIMARY KEY CHECK(id=1),commit_token TEXT NOT NULL)',
  )
  yield* sql.unsafe("INSERT OR IGNORE INTO project_commit VALUES(1,'')")
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS project_runtime_runs(
      run_id TEXT PRIMARY KEY,lease_epoch INTEGER NOT NULL,state TEXT NOT NULL,reason TEXT NOT NULL DEFAULT '',
      cleanup_complete INTEGER NOT NULL DEFAULT 0,cleanup_acked INTEGER NOT NULL DEFAULT 0,
      cleanup_next_at INTEGER NOT NULL DEFAULT 0,cleanup_attempts INTEGER NOT NULL DEFAULT 0)`)
      yield* sql.unsafe('CREATE TABLE IF NOT EXISTS project_processes(role TEXT PRIMARY KEY,payload TEXT NOT NULL)')
      yield* sql.unsafe(
        'CREATE INDEX IF NOT EXISTS project_cleanup_due ON project_runtime_runs(cleanup_next_at,run_id) WHERE cleanup_complete=1 AND cleanup_acked=0',
      )
    }),
  )
  const get = (id: string) =>
    sql<RunRow>`SELECT * FROM project_runtime_runs WHERE run_id=${id}`.pipe(Effect.map((r) => r[0]))
  const insert = (c: ProjectRunCommand, stopped = false) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const old = yield* get(c.run_id)
        if (old) return { inserted: false, row: old }
        yield* sql`INSERT INTO project_runtime_runs(run_id,lease_epoch,state,reason,cleanup_complete)
      VALUES(${c.run_id},${c.lease_epoch},${stopped ? 'exited' : 'starting'},${stopped ? 'stopped_before_start' : ''},${stopped ? 1 : 0})`
        return { inserted: true, row: (yield* get(c.run_id))! }
      }),
    )
  const state = (id: string, value: string, reason: string) =>
    sql.withTransaction(sql`UPDATE project_runtime_runs SET state=${value},reason=${reason} WHERE run_id=${id}`)
  const complete = (id: string) =>
    sql.withTransaction(sql`UPDATE project_runtime_runs SET cleanup_complete=1,
    state=CASE WHEN state='failed' THEN state ELSE 'exited' END,
    reason=CASE WHEN reason='' THEN 'runtime_exited' ELSE reason END WHERE run_id=${id}`)
  const claim = (now: number) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<RunRow>`SELECT * FROM project_runtime_runs WHERE cleanup_complete=1 AND cleanup_acked=0
      AND cleanup_next_at<=${now} ORDER BY cleanup_next_at,run_id LIMIT 1`
        const row = rows[0]
        if (!row) return
        const next = now + 5000 + Math.min(30000, 1000 * 2 ** Math.min(row.cleanup_attempts, 5))
        yield* sql`UPDATE project_runtime_runs SET cleanup_next_at=${next},cleanup_attempts=cleanup_attempts+1 WHERE run_id=${row.run_id}`
        return row
      }),
    )
  const ack = (id: string, epoch: number) =>
    sql.withTransaction(
      sql`UPDATE project_runtime_runs SET cleanup_acked=1 WHERE run_id=${id} AND lease_epoch=${epoch} AND cleanup_complete=1`,
    )
  const records = {
    add: (record: ProcessRecord) =>
      Effect.runPromise(
        sql
          .withTransaction(
            sql`INSERT INTO project_processes VALUES(${record.role},${JSON.stringify(record)}) ON CONFLICT(role) DO UPDATE SET payload=excluded.payload`,
          )
          .pipe(Effect.asVoid),
      ),
    remove: (record: ProcessRecord) =>
      Effect.runPromise(
        sql
          .withTransaction(
            sql`DELETE FROM project_processes WHERE role=${record.role} AND payload=${JSON.stringify(record)}`,
          )
          .pipe(Effect.asVoid),
      ),
  }
  return {
    get,
    occupied: () =>
      sql<{ count: number }>`SELECT count(*) AS count FROM project_runtime_runs WHERE cleanup_complete=0`.pipe(
        Effect.map((rows) => rows[0]?.count ?? 0),
      ),
    insert,
    state,
    complete,
    claim,
    ack,
    records,
    processes: () =>
      sql<{ payload: string }>`SELECT payload FROM project_processes`.pipe(
        Effect.map((rows) => rows.map((r) => JSON.parse(r.payload) as ProcessRecord)),
      ),
  }
})
export type ProjectLedger = Effect.Success<ReturnType<typeof makeProjectLedger>>
