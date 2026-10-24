import { createHash, randomUUID } from 'node:crypto'
import * as Sqlite from '@baton/sqlite'
import type {
  ThreadCommandResult,
  ThreadReport,
  ThreadReportResult,
  WorkerCommandReceipt,
  WorkerOpenConfig,
  WorkerRequest,
} from '@baton/protocol'
import { Effect } from 'effect'
import * as Reactivity from 'effect/reactivity/Reactivity'

export const contentHash = (value: unknown): string => {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
}
export interface NodeCommand {
  id: string
  hash: string
  request: WorkerRequest
  result?: ThreadCommandResult
  receipt?: WorkerCommandReceipt
}
export interface DiscoveredWorker {
  threadId: string
  config: WorkerOpenConfig
  ready: boolean
  launch_attempted?: boolean
  history_unavailable?: ThreadReport
}
export interface NodeReport {
  report: ThreadReport
  acked: boolean
}

/** node.db retains acknowledged reports so a center sequence gap can be replayed. */
export const makeNodeLedger = Effect.fn('Daemon.makeNodeLedger')(function* (filename: string) {
  const sql = yield* Sqlite.make({
    filename,
    busyTimeoutMs: 100,
    commitVerification: {
      writeToken: (token) => ({ sql: 'UPDATE node_commit SET commit_token = ? WHERE id = 1', params: [token] }),
      readToken: { sql: 'SELECT commit_token FROM node_commit WHERE id = 1' },
    },
  }).pipe(Effect.provide(Reactivity.layer))
  yield* sql.unsafe(
    'CREATE TABLE IF NOT EXISTS node_commit (id INTEGER PRIMARY KEY CHECK(id=1), commit_token TEXT NOT NULL)',
  )
  yield* sql.unsafe("INSERT OR IGNORE INTO node_commit VALUES (1, '')")
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        'CREATE TABLE IF NOT EXISTS node_commands (id TEXT PRIMARY KEY, hash TEXT NOT NULL, payload TEXT NOT NULL)',
      )
      yield* sql.unsafe(
        'CREATE TABLE IF NOT EXISTS node_workers (thread_id TEXT PRIMARY KEY, generation TEXT NOT NULL, payload TEXT NOT NULL)',
      )
      yield* sql.unsafe(
        'CREATE TABLE IF NOT EXISTS node_outbox (thread_id TEXT NOT NULL, seq INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE, hash TEXT NOT NULL, payload TEXT NOT NULL, acked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(thread_id,seq))',
      )
    }),
  )
  const command = (id: string) =>
    sql
      .unsafe<{ payload: string }>('SELECT payload FROM node_commands WHERE id=?', [id])
      .pipe(Effect.map((rows) => (rows[0] ? (JSON.parse(rows[0].payload) as NodeCommand) : undefined)))
  const worker = (id: string) =>
    sql
      .unsafe<{ payload: string }>('SELECT payload FROM node_workers WHERE thread_id=?', [id])
      .pipe(Effect.map((rows) => (rows[0] ? (JSON.parse(rows[0].payload) as DiscoveredWorker) : undefined)))
  const saveWorker = (value: DiscoveredWorker) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const previous = yield* worker(value.threadId)
        if (previous && contentHash(previous.config) !== contentHash(value.config))
          return yield* Effect.fail(new Error('Worker 配置或存储代次不符'))
        const saved = { ...previous, ...value }
        if (previous?.launch_attempted) saved.launch_attempted = true
        if (previous?.history_unavailable) saved.history_unavailable = previous.history_unavailable
        if (saved.history_unavailable) saved.ready = false
        yield* sql.unsafe(
          'INSERT INTO node_workers VALUES(?,?,?) ON CONFLICT(thread_id) DO UPDATE SET payload=excluded.payload',
          [value.threadId, value.config.storage_generation, JSON.stringify(saved)],
        )
      }),
    )
  const prepare = (value: NodeCommand) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const existing = yield* command(value.id)
        if (existing) {
          if (existing.hash !== value.hash) return yield* Effect.fail(new Error('command_content_mismatch'))
          return existing
        }
        if (value.request.open_config)
          yield* saveWorker({
            threadId: value.request.open_config.thread_id,
            config: value.request.open_config,
            ready: false,
          })
        yield* sql.unsafe('INSERT INTO node_commands VALUES(?,?,?)', [value.id, value.hash, JSON.stringify(value)])
        return value
      }),
    )
  const received = (id: string, result: ThreadCommandResult, receipt?: WorkerCommandReceipt) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const value = yield* command(id)
        if (!value) return yield* Effect.fail(new Error('命令尚未持久登记'))
        yield* sql.unsafe('UPDATE node_commands SET payload=? WHERE id=?', [
          JSON.stringify({ ...value, result, ...(receipt ? { receipt } : {}) }),
          id,
        ])
        if (result.ok) {
          const saved = yield* worker(result.thread_id)
          if (saved) yield* saveWorker({ ...saved, ready: true })
        }
      }),
    )
  const ingest = (report: ThreadReport) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const hash = contentHash(report)
        const rows = yield* sql.unsafe<{ hash: string }>(
          'SELECT hash FROM node_outbox WHERE (thread_id=? AND seq=?) OR event_id=?',
          [report.thread_id, report.worker_seq, report.event_id],
        )
        if (rows.length) {
          if (rows.length !== 1 || rows[0].hash !== hash) return yield* Effect.fail(new Error('Worker 报告身份冲突'))
          return
        }
        const seqs = yield* sql.unsafe<{ seq: number }>(
          'SELECT COALESCE(MAX(seq),0) AS seq FROM node_outbox WHERE thread_id=?',
          [report.thread_id],
        )
        if (report.worker_seq !== seqs[0].seq + 1) return yield* Effect.fail(new Error('Worker 报告序号存在缺口'))
        yield* sql.unsafe('INSERT INTO node_outbox(thread_id,seq,event_id,hash,payload) VALUES(?,?,?,?,?)', [
          report.thread_id,
          report.worker_seq,
          report.event_id,
          hash,
          JSON.stringify(report),
        ])
      }),
    )
  const markWorkerLaunch = (threadId: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const saved = yield* worker(threadId)
        if (!saved) return yield* Effect.fail(new Error('Worker 尚未登记'))
        if (saved.history_unavailable) return yield* Effect.fail(new Error('Worker 历史已不可恢复'))
        if (saved.launch_attempted) return false
        yield* saveWorker({ ...saved, launch_attempted: true })
        return true
      }),
    )
  const markWorkerLost = (threadId: string, reason: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const saved = yield* worker(threadId)
        if (!saved) return yield* Effect.fail(new Error('Worker 尚未登记'))
        if (saved.history_unavailable) return saved.history_unavailable
        const seqs = yield* sql.unsafe<{ seq: number }>(
          'SELECT COALESCE(MAX(seq),0) AS seq FROM node_outbox WHERE thread_id=?',
          [threadId],
        )
        const report: ThreadReport = {
          type: 'thread.report',
          thread_id: threadId,
          storage_generation: saved.config.storage_generation,
          event_id: randomUUID(),
          worker_seq: seqs[0].seq + 1,
          kind: 'thread.unknown',
          history_unavailable: true,
          reason,
        }
        yield* ingest(report)
        yield* saveWorker({ ...saved, ready: false, launch_attempted: true, history_unavailable: report })
        return report
      }),
    )
  const acknowledge = (ack: ThreadReportResult) =>
    sql.withTransaction(
      Effect.gen(function* () {
        if (ack.ok) {
          yield* sql.unsafe('UPDATE node_outbox SET acked=1 WHERE thread_id=? AND seq=? AND event_id=?', [
            ack.thread_id,
            ack.worker_seq,
            ack.event_id,
          ])
        } else if (ack.expected_worker_seq !== undefined && ack.expected_worker_seq > 0) {
          // A negative acknowledgement can only replay reports; it never removes an unacknowledged fact.
          yield* sql.unsafe('UPDATE node_outbox SET acked=0 WHERE thread_id=? AND seq>=?', [
            ack.thread_id,
            ack.expected_worker_seq,
          ])
        }
      }),
    )
  return {
    command,
    worker,
    prepare,
    received,
    ingest,
    acknowledge,
    saveWorker,
    markWorkerLaunch,
    markWorkerLost,
    workers: () =>
      sql
        .unsafe<{ payload: string }>('SELECT payload FROM node_workers ORDER BY thread_id')
        .pipe(Effect.map((rows) => rows.map((r) => JSON.parse(r.payload) as DiscoveredWorker))),
    pendingCommands: () =>
      sql
        .unsafe<{ payload: string }>(
          `SELECT c.payload FROM node_commands c
          JOIN node_workers w ON w.thread_id=json_extract(c.payload,'$.request.thread_id')
          WHERE json_extract(w.payload,'$.history_unavailable') IS NULL ORDER BY c.rowid`,
        )
        .pipe(Effect.map((rows) => rows.map((r) => JSON.parse(r.payload) as NodeCommand).filter((c) => !c.result))),
    pendingReports: () =>
      sql
        .unsafe<{ payload: string }>('SELECT payload FROM node_outbox WHERE acked=0 ORDER BY thread_id,seq LIMIT 128')
        .pipe(Effect.map((rows) => rows.map((r) => JSON.parse(r.payload) as ThreadReport))),
    pragmas: () =>
      Effect.gen(function* () {
        const journal = yield* sql.unsafe<{ journal_mode: string }>('PRAGMA journal_mode')
        const synchronous = yield* sql.unsafe<{ synchronous: number }>('PRAGMA synchronous')
        return { journal: journal[0].journal_mode, synchronous: synchronous[0].synchronous }
      }),
  }
})
export type NodeLedger = Effect.Success<ReturnType<typeof makeNodeLedger>>
