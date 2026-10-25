import { DatabaseSync } from 'node:sqlite'
import { Schema } from 'effect'
import { ThreadReport, WorkerCommandReceipt, WorkerCommandStatus, WorkerOpenConfig } from '@baton/protocol'
import { openPrivateFile } from '../platform/private.ts'
import { processLockIsHeld } from '../platform/lock.ts'
import { contentHash, type DiscoveredWorker, type NodeLedger } from './ledger.ts'
import { workerPaths } from './paths.ts'
import type { DaemonWorkerHost } from './host.ts'
import { DaemonStorageFailure, ledgerPromise as io } from './storage.ts'

export type WorkerRecoveryResult = 'ready' | 'lost' | 'retry'
export type WorkerLedgerInspection = 'valid' | 'missing' | 'corrupt' | 'empty' | 'retry'
const phases = new Set(['empty', 'opening', 'idle', 'busy', 'stopping', 'stopped', 'unknown', 'failed'])
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const codeIs = (error: unknown, code: string) => error instanceof Error && 'code' in error && error.code === code
const nonnegativeInteger = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0

/** 只读检查已停止 Worker 的账本；权限、锁占用和 I/O 故障保留为可重试状态。 */
export async function inspectWorkerLedger(
  dataDirectory: string,
  saved: DiscoveredWorker,
): Promise<WorkerLedgerInspection> {
  const path = workerPaths(dataDirectory, saved.threadId).ledger
  try {
    const file = await openPrivateFile(path)
    await file.close()
  } catch (error) {
    return codeIs(error, 'ENOENT') ? 'missing' : 'retry'
  }
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path, { readOnly: true, allowExtension: false, timeout: 0 })
    const checks = db.prepare('PRAGMA quick_check(1)').all()
    if (checks.length !== 1 || Object.values(checks[0])[0] !== 'ok') return 'corrupt'
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
        .all()
        .map((row) => row.name),
    )
    if (tables.size === 0 || (tables.size === 1 && tables.has('worker_commit'))) return 'empty'
    for (const table of [
      'worker_commit',
      'thread_meta',
      'thread_commands',
      'thread_messages',
      'thread_processes',
      'thread_outbox',
    ]) {
      if (!tables.has(table)) return 'corrupt'
    }
    let hasActivity = false
    for (const table of ['thread_commands', 'thread_messages', 'thread_processes', 'thread_outbox']) {
      if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) hasActivity = true
    }
    const rows = db.prepare('SELECT payload FROM thread_meta WHERE id=1').all()
    if (!rows.length) return hasActivity ? 'corrupt' : 'empty'
    const meta: unknown = JSON.parse(String(rows[0].payload))
    if (
      !record(meta) ||
      !phases.has(String(meta.phase)) ||
      !nonnegativeInteger(meta.epoch) ||
      !nonnegativeInteger(meta.turn) ||
      typeof meta.opened !== 'boolean' ||
      typeof meta.resumeRequested !== 'boolean'
    )
      return 'corrupt'
    if (meta.config === undefined)
      return !hasActivity &&
        meta.phase === 'empty' &&
        meta.epoch === 0 &&
        meta.turn === 0 &&
        !meta.opened &&
        !meta.resumeRequested &&
        meta.nativeId === undefined &&
        meta.activeMessage === undefined
        ? 'empty'
        : 'corrupt'
    const config = Schema.decodeUnknownSync(WorkerOpenConfig)(meta.config)
    if (
      contentHash(config) !== contentHash(saved.config) ||
      (meta.opened && (typeof meta.nativeId !== 'string' || !meta.nativeId))
    )
      return 'corrupt'
    for (const row of db.prepare('SELECT id,payload FROM thread_commands').all()) {
      const value: unknown = JSON.parse(String(row.payload))
      if (!record(value) || typeof value.digest !== 'string') return 'corrupt'
      const receipt = Schema.decodeUnknownSync(WorkerCommandReceipt)(value.receipt)
      const status = Schema.decodeUnknownSync(WorkerCommandStatus)(value.status)
      if (
        receipt.command_id !== row.id ||
        status.command_id !== row.id ||
        receipt.thread_id !== saved.threadId ||
        receipt.storage_generation !== config.storage_generation
      )
        return 'corrupt'
    }
    for (const row of db.prepare('SELECT id,payload FROM thread_messages').all()) {
      const value: unknown = JSON.parse(String(row.payload))
      if (
        !record(value) ||
        !record(value.input) ||
        value.input.id !== row.id ||
        typeof value.digest !== 'string' ||
        !['queued', 'intent', 'sent', 'withdrawn', 'unknown'].includes(String(value.state))
      )
        return 'corrupt'
    }
    for (const row of db.prepare('SELECT seq,payload FROM thread_outbox ORDER BY seq').all()) {
      const value: unknown = JSON.parse(String(row.payload))
      if (!record(value) || typeof value.acked !== 'boolean') return 'corrupt'
      const report = Schema.decodeUnknownSync(ThreadReport)(value.report)
      if (
        report.thread_id !== saved.threadId ||
        report.storage_generation !== config.storage_generation ||
        report.worker_seq !== row.seq
      )
        return 'corrupt'
    }
    return 'valid'
  } catch (error) {
    // SQLITE_CORRUPT / SQLITE_NOTADB 是内容损坏；BUSY、LOCKED、READONLY、IOERR、CANTOPEN 均可能恢复。
    if (error instanceof Error && 'errcode' in error && typeof error.errcode === 'number') {
      return [1, 11, 26].includes(error.errcode & 0xff) ? 'corrupt' : 'retry'
    }
    if (error instanceof SyntaxError || (record(error) && error._tag === 'SchemaError')) return 'corrupt'
    return 'retry'
  } finally {
    db?.close()
  }
}

export function makeWorkerRecovery(options: {
  readonly dataDirectory: string
  readonly ledger: NodeLedger
  readonly host: DaemonWorkerHost
  readonly inspect?: (saved: DiscoveredWorker) => Promise<WorkerLedgerInspection>
}) {
  const { ledger, host, dataDirectory } = options
  const inFlight = new Map<string, Promise<WorkerRecoveryResult>>()
  const inspect = options.inspect ?? ((saved: DiscoveredWorker) => inspectWorkerLedger(dataDirectory, saved))

  async function ensureOne(threadId: string, signal?: AbortSignal): Promise<WorkerRecoveryResult> {
    if (signal?.aborted) return 'retry'
    let saved = await io(ledger.worker(threadId))
    if (!saved) return 'retry'
    if (saved.history_unavailable) return 'lost'
    const status = async (): Promise<boolean> => {
      try {
        const reply = await host.request(threadId, { type: 'status', ok: false }, { timeoutMs: 250 })
        if (!reply.ok || reply.worker_ready !== true) return false
        const current = await io(ledger.worker(threadId))
        if (!current || current.history_unavailable) return false
        if (
          reply.storage_generation === current.config.storage_generation &&
          (!reply.session_id || reply.session_id === threadId)
        ) {
          if (current.startup_phase !== 'open_attempted') await io(ledger.markWorkerOpenAttempt(threadId))
          if (!current.launch_attempted) await io(ledger.markWorkerLaunch(threadId))
          if (!current.ready) await io(ledger.saveWorker({ ...current, ready: true, launch_attempted: true }))
          return true
        }
        return !reply.storage_generation && !reply.session_id && current.startup_phase === 'awaiting_open'
      } catch (error) {
        // 节点账本写入失败必须由调用方停止执行。
        if (error instanceof DaemonStorageFailure) throw error
        return false
      }
    }
    if (await status()) return 'ready'
    if (signal?.aborted) return 'retry'
    const paths = workerPaths(dataDirectory, threadId)
    try {
      if ((await processLockIsHeld(paths.lock)) || (await processLockIsHeld(paths.launchLock))) return 'retry'
    } catch {
      return 'retry'
    }
    const condition = await inspect(saved)
    if (condition === 'retry' || signal?.aborted) return 'retry'
    const lost = async (reason: string): Promise<WorkerRecoveryResult> => {
      await io(ledger.markWorkerLost(threadId, reason))
      return 'lost'
    }
    saved = await io(ledger.worker(threadId))
    if (!saved || signal?.aborted) return 'retry'
    if (saved.history_unavailable) return 'lost'
    const awaitingOpen = saved.startup_phase === 'awaiting_open'
    if (condition === 'corrupt') return lost('本地 Worker 账本损坏或结构不匹配，原会话历史不可恢复')
    if (condition === 'empty' && !awaitingOpen) return lost('本地 Worker 账本缺少原会话记录，禁止重新创建会话')
    if (condition === 'missing' && !awaitingOpen) return lost('本地 Worker 账本缺失，原会话历史不可恢复')
    if (condition === 'valid' && saved.startup_phase !== 'open_attempted')
      await io(ledger.markWorkerOpenAttempt(threadId))
    await io(ledger.markWorkerLaunch(threadId))
    if (signal?.aborted) return 'retry'
    try {
      await host.ensureWorker(threadId)
    } catch {
      return 'retry'
    }
    if (signal?.aborted) return 'retry'
    if (await status()) return 'ready'
    // IPC 暂不可用时，下一轮继续核对进程锁、启动阶段和实体账本。
    return 'retry'
  }

  const ensure = (threadId: string, signal?: AbortSignal): Promise<WorkerRecoveryResult> => {
    const current = inFlight.get(threadId)
    if (current) return current
    const pending = ensureOne(threadId, signal).finally(() => inFlight.delete(threadId))
    inFlight.set(threadId, pending)
    return pending
  }
  return {
    ensure,
    async recoverAll(signal?: AbortSignal): Promise<void> {
      for (const saved of await io(ledger.workers())) {
        if (signal?.aborted) return
        if (!saved.history_unavailable) await ensure(saved.threadId, signal)
      }
    },
  }
}
