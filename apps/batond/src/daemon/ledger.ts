import { createHash, randomUUID } from 'node:crypto'
import * as Sqlite from '@baton/sqlite'
import { checkStorageFormat, initializeStorage } from '../storage-format.ts'
import type {
  ThreadCommandResult,
  ThreadReport,
  ThreadReportResult,
  WorkerCommandReceipt,
  WorkerOpenConfig,
  WorkerRequest,
} from '@baton/protocol'
import type { ProcessRecord } from '../platform/process-types.ts'
import { Clock, Effect } from 'effect'
import * as Reactivity from 'effect/reactivity/Reactivity'
import { commitVerification, storageBaseline } from '../node-schema.ts'

export { storageBaseline }

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
export interface WorkerControl {
  history_unavailable?: ThreadReport
}
export interface DiscoveredWorker {
  threadId: string
  config: WorkerOpenConfig
  ready: boolean
  launch_attempted?: boolean
  startup_phase?: 'awaiting_open' | 'open_attempted'
  history_unavailable?: ThreadReport
}
export interface NodeReport {
  report: ThreadReport
  acked: boolean
}

interface StoredThread {
  thread_id: string
  storage_generation: string
  startup_phase: 'awaiting_open' | 'open_attempted'
  config_json: string
  meta_json: string
  control_json: string
}

const decodeThread = (row: StoredThread): DiscoveredWorker => {
  const control = JSON.parse(row.control_json) as WorkerControl & {
    ready?: boolean
    launch_attempted?: boolean
  }
  return {
    threadId: row.thread_id,
    config: JSON.parse(row.config_json) as WorkerOpenConfig,
    ready: control.ready ?? false,
    ...(control.launch_attempted ? { launch_attempted: true } : {}),
    startup_phase: row.startup_phase,
    ...(control.history_unavailable ? { history_unavailable: control.history_unavailable } : {}),
  }
}
const encodeControl = (value: DiscoveredWorker) =>
  JSON.stringify({
    ready: value.ready,
    ...(value.launch_attempted ? { launch_attempted: true } : {}),
    ...(value.history_unavailable ? { history_unavailable: value.history_unavailable } : {}),
  })

/** node.db 保留已确认报告，用于补齐中心的序号缺口。 */
export const makeNodeLedger = Effect.fn('Daemon.makeNodeLedger')(function* (
  filename: string,
  nodeId?: string,
  excludedThreadIds: ReadonlySet<string> = new Set(),
) {
  const clock = yield* Clock.Clock
  yield* Effect.try({
    try: () => checkStorageFormat(filename, 'node', storageBaseline),
    catch: (error) => error as Error,
  })
  const sql = yield* Sqlite.make({
    filename,
    busyTimeoutMs: 5000,
    commitVerification,
  }).pipe(Effect.provide(Reactivity.layer))
  yield* initializeStorage(sql, 'node', storageBaseline)
  const excluded = (threadId: string) => excludedThreadIds.has(threadId)
  const belongs = (value: DiscoveredWorker) => !excluded(value.threadId) && (!nodeId || value.config.node_id === nodeId)
  const rawWorker = (threadId: string) =>
    sql
      .unsafe<StoredThread>('SELECT * FROM threads WHERE thread_id=?', [threadId])
      .pipe(Effect.map((rows) => (rows[0] ? decodeThread(rows[0]) : undefined)))
  const worker = (threadId: string) =>
    rawWorker(threadId).pipe(Effect.map((value) => (value && belongs(value) ? value : undefined)))
  const command = (id: string) =>
    sql
      .unsafe<{
        hash: string
        request_json: string
        receipt_json: string | null
        result_json: string | null
      }>(
        `SELECT c.hash,c.request_json,c.receipt_json,c.result_json FROM thread_commands c
         JOIN threads t ON t.thread_id=c.thread_id
         WHERE c.command_id=?${nodeId ? " AND json_extract(t.config_json,'$.node_id')=?" : ''}`,
        nodeId ? [id, nodeId] : [id],
      )
      .pipe(
        Effect.map((rows) =>
          rows[0]?.request_json
            ? ({
                id,
                hash: rows[0].hash,
                request: JSON.parse(rows[0].request_json) as WorkerRequest,
                ...(rows[0].receipt_json ? { receipt: JSON.parse(rows[0].receipt_json) as WorkerCommandReceipt } : {}),
                ...(rows[0].result_json ? { result: JSON.parse(rows[0].result_json) as ThreadCommandResult } : {}),
              } satisfies NodeCommand)
            : undefined,
        ),
      )
  const saveWorker = (value: DiscoveredWorker) =>
    sql.withTransaction(
      Effect.gen(function* () {
        if (!belongs(value)) return yield* Effect.fail(new Error('binding_mismatch'))
        const previous = yield* rawWorker(value.threadId)
        if (previous && contentHash(previous.config) !== contentHash(value.config))
          return yield* Effect.fail(new Error('Thread 配置或存储代次不符'))
        const saved = { ...previous, ...value }
        if (previous?.launch_attempted) saved.launch_attempted = true
        if (previous?.startup_phase === 'open_attempted') saved.startup_phase = 'open_attempted'
        if (previous?.history_unavailable) saved.history_unavailable = previous.history_unavailable
        if (saved.history_unavailable) saved.ready = false
        yield* sql.unsafe(
          `INSERT INTO threads(thread_id,storage_generation,startup_phase,config_json,meta_json,control_json)
           VALUES(?,?,?,?,'{}',?)
           ON CONFLICT(thread_id) DO UPDATE SET control_json=excluded.control_json`,
          [
            value.threadId,
            value.config.storage_generation,
            saved.startup_phase ?? 'awaiting_open',
            JSON.stringify(value.config),
            encodeControl(saved),
          ],
        )
      }),
    )
  const prepare = (value: NodeCommand) =>
    sql.withTransaction(
      Effect.gen(function* () {
        if (value.request.thread_id && excludedThreadIds.has(value.request.thread_id))
          return yield* Effect.fail(new Error('binding_mismatch'))
        if (nodeId && !value.request.open_config && !(yield* worker(value.request.thread_id!))) {
          return yield* Effect.fail(new Error('binding_mismatch'))
        }
        const existing = yield* command(value.id)
        if (existing) {
          if (existing.hash !== value.hash) return yield* Effect.fail(new Error('command_content_mismatch'))
          return existing
        }
        if (value.request.open_config) {
          const previous = yield* worker(value.request.open_config.thread_id)
          if (!previous)
            yield* sql.unsafe(
              `INSERT INTO threads(thread_id,storage_generation,startup_phase,config_json,meta_json,control_json)
               VALUES(?,?,'awaiting_open',?,'{}','{}')`,
              [
                value.request.open_config.thread_id,
                value.request.open_config.storage_generation,
                JSON.stringify(value.request.open_config),
              ],
            )
        }
        yield* sql.unsafe(`INSERT INTO thread_commands(command_id,thread_id,hash,request_json) VALUES(?,?,?,?)`, [
          value.id,
          value.request.thread_id!,
          value.hash,
          JSON.stringify(value.request),
        ])
        return value
      }),
    )
  const received = (id: string, result: ThreadCommandResult, receipt?: WorkerCommandReceipt) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const value = yield* command(id)
        if (!value) return yield* Effect.fail(new Error('命令尚未持久登记'))
        yield* sql.unsafe('UPDATE thread_commands SET result_json=?, receipt_json=? WHERE command_id=?', [
          JSON.stringify(result),
          receipt ? JSON.stringify(receipt) : null,
          id,
        ])
        if (result.ok) {
          const saved = yield* worker(result.thread_id)
          if (saved) yield* saveWorker({ ...saved, ready: true, startup_phase: 'open_attempted' })
        }
      }),
    )
  const ingest = (report: ThreadReport) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const saved = yield* worker(report.thread_id)
        if (nodeId && (!saved || saved.config.storage_generation !== report.storage_generation))
          return yield* Effect.fail(new Error('binding_mismatch'))
        if (saved && saved.startup_phase !== 'open_attempted')
          yield* saveWorker({ ...saved, startup_phase: 'open_attempted' })
        const hash = contentHash(report)
        const rows = yield* sql.unsafe<{ hash: string }>(
          'SELECT hash FROM thread_outbox WHERE (thread_id=? AND seq=?) OR event_id=?',
          [report.thread_id, report.worker_seq, report.event_id],
        )
        if (rows.length) {
          if (rows.length !== 1 || rows[0].hash !== hash) return yield* Effect.fail(new Error('Worker 报告身份冲突'))
          return
        }
        const seqs = yield* sql.unsafe<{ seq: number }>(
          'SELECT COALESCE(MAX(seq),0) AS seq FROM thread_outbox WHERE thread_id=?',
          [report.thread_id],
        )
        if (report.worker_seq !== seqs[0].seq + 1) return yield* Effect.fail(new Error('Worker 报告序号存在缺口'))
        yield* sql.unsafe(
          'INSERT INTO thread_outbox(thread_id,seq,event_id,hash,payload,created_ms) VALUES(?,?,?,?,?,?)',
          [
            report.thread_id,
            report.worker_seq,
            report.event_id,
            hash,
            JSON.stringify(report),
            clock.currentTimeMillisUnsafe(),
          ],
        )
      }),
    )
  const markWorkerLaunch = (threadId: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const saved = yield* worker(threadId)
        if (!saved) return yield* Effect.fail(new Error('Thread 尚未登记'))
        if (saved.history_unavailable) return yield* Effect.fail(new Error('Thread 历史已不可恢复'))
        if (saved.launch_attempted) return false
        yield* saveWorker({ ...saved, launch_attempted: true })
        return true
      }),
    )
  const markWorkerOpenAttempt = (threadId: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const saved = yield* worker(threadId)
        if (saved?.history_unavailable) return yield* Effect.fail(new Error('Thread 历史已不可恢复'))
        if (saved?.startup_phase !== 'open_attempted') {
          yield* sql.unsafe("UPDATE threads SET startup_phase='open_attempted' WHERE thread_id=?", [threadId])
          if (saved) yield* saveWorker({ ...saved, startup_phase: 'open_attempted' })
        }
      }),
    )
  const markWorkerLost = (threadId: string, reason: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const saved = yield* worker(threadId)
        if (!saved) return yield* Effect.fail(new Error('Thread 尚未登记'))
        if (saved.history_unavailable) return saved.history_unavailable
        const seqs = yield* sql.unsafe<{ seq: number }>(
          'SELECT COALESCE(MAX(seq),0) AS seq FROM thread_outbox WHERE thread_id=?',
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
        if (nodeId && !(yield* worker(ack.thread_id))) return
        if (ack.ok) {
          yield* sql.unsafe('UPDATE thread_outbox SET acked=1 WHERE thread_id=? AND seq=? AND event_id=?', [
            ack.thread_id,
            ack.worker_seq,
            ack.event_id,
          ])
        } else if (ack.expected_worker_seq !== undefined && ack.expected_worker_seq > 0) {
          // A negative acknowledgement can only replay reports; it never removes an unacknowledged fact.
          yield* sql.unsafe('UPDATE thread_outbox SET acked=0 WHERE thread_id=? AND seq>=?', [
            ack.thread_id,
            ack.expected_worker_seq,
          ])
        }
      }),
    )
  const recordProcess = (ownerKind: string, ownerId: string, record: ProcessRecord) =>
    sql.withTransaction(
      sql.unsafe(
        `INSERT INTO node_processes(owner_kind,owner_id,pid,creation_time,role) VALUES(?,?,?,?,?)
         ON CONFLICT(owner_kind,owner_id,pid) DO UPDATE SET creation_time=excluded.creation_time,role=excluded.role`,
        [ownerKind, ownerId, record.pid, record.creationTime, record.role],
      ),
    )
  const removeProcess = (ownerKind: string, ownerId: string, record: ProcessRecord) =>
    sql.withTransaction(
      sql.unsafe(
        'DELETE FROM node_processes WHERE owner_kind=? AND owner_id=? AND pid=? AND creation_time=? AND role=?',
        [ownerKind, ownerId, record.pid, record.creationTime, record.role],
      ),
    )
  const processes = (ownerKind: string, ownerId: string) =>
    sql
      .unsafe<{ pid: number; creation_time: string; role: string }>(
        'SELECT pid,creation_time,role FROM node_processes WHERE owner_kind=? AND owner_id=? ORDER BY pid',
        [ownerKind, ownerId],
      )
      .pipe(
        Effect.map(
          (rows) =>
            rows.map((row) => ({
              pid: row.pid,
              creationTime: row.creation_time,
              role: row.role,
            })) as ProcessRecord[],
        ),
      )
  return {
    command,
    worker,
    excluded,
    prepare,
    received,
    ingest,
    acknowledge,
    saveWorker,
    markWorkerLaunch,
    markWorkerOpenAttempt,
    markWorkerLost,
    recordProcess,
    removeProcess,
    processes,
    workers: () =>
      sql
        .unsafe<StoredThread>('SELECT * FROM threads ORDER BY thread_id')
        .pipe(Effect.map((rows) => rows.map(decodeThread).filter(belongs))),
    activeThreadIds: () =>
      sql
        .unsafe<{ thread_id: string }>(
          `SELECT DISTINCT t.thread_id FROM threads t
           WHERE EXISTS(SELECT 1 FROM node_processes p WHERE p.owner_kind='thread' AND p.owner_id=t.thread_id)
              OR EXISTS(SELECT 1 FROM thread_messages m WHERE m.thread_id=t.thread_id
                        AND json_extract(m.payload,'$.state') IN ('queued','intent'))
              OR EXISTS(SELECT 1 FROM thread_commands c WHERE c.thread_id=t.thread_id AND c.result_json IS NULL)
              OR json_extract(t.meta_json,'$.phase') IN ('opening','busy','stopping','unknown')
              OR (json_extract(t.meta_json,'$.activeMessage') IS NOT NULL
                  AND json_extract(t.meta_json,'$.activeMessage') != 'null')`,
        )
        .pipe(Effect.map((rows) => rows.map((row) => row.thread_id))),
    pendingCommands: () =>
      sql
        .unsafe<{ command_id: string; request_json: string }>(
          `SELECT c.command_id,c.request_json FROM thread_commands c
          JOIN threads t ON t.thread_id=c.thread_id
          WHERE c.result_json IS NULL AND c.request_json IS NOT NULL
            AND json_extract(t.control_json,'$.history_unavailable') IS NULL
          ORDER BY c.rowid`,
        )
        .pipe(
          Effect.map((rows) =>
            rows
              .map((row) => {
                const request = JSON.parse(row.request_json) as WorkerRequest
                return {
                  id: row.command_id,
                  hash: contentHash(request),
                  request,
                } satisfies NodeCommand
              })
              .filter((command) => !excludedThreadIds.has(command.request.thread_id!)),
          ),
        ),
    pendingReports: () =>
      sql
        .unsafe<{ payload: string }>(
          `SELECT o.payload FROM thread_outbox o JOIN threads t ON t.thread_id=o.thread_id
           WHERE o.acked=0${nodeId ? " AND json_extract(t.config_json,'$.node_id')=?" : ''}
           ORDER BY o.thread_id,o.seq LIMIT 128`,
          nodeId ? [nodeId] : [],
        )
        .pipe(
          Effect.map((rows) =>
            rows
              .map((row) => JSON.parse(row.payload) as ThreadReport)
              .filter((report) => !excludedThreadIds.has(report.thread_id)),
          ),
        ),
    reportBacklog: () =>
      sql
        .unsafe<{ count: number; oldest_ms: number | null }>(
          `SELECT count(*) AS count, min(o.created_ms) AS oldest_ms FROM thread_outbox o
           JOIN threads t ON t.thread_id=o.thread_id
           WHERE o.acked=0${nodeId ? " AND json_extract(t.config_json,'$.node_id')=?" : ''}`,
          nodeId ? [nodeId] : [],
        )
        .pipe(Effect.map((rows) => rows[0]!)),
    pragmas: () =>
      Effect.gen(function* () {
        const journal = yield* sql.unsafe<{ journal_mode: string }>('PRAGMA journal_mode')
        const synchronous = yield* sql.unsafe<{ synchronous: number }>('PRAGMA synchronous')
        return { journal: journal[0].journal_mode, synchronous: synchronous[0].synchronous }
      }),
  }
})
export type NodeLedger = Effect.Success<ReturnType<typeof makeNodeLedger>>
