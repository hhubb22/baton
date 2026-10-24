import { DatabaseSync } from 'node:sqlite'
import { Schema } from 'effect'
import { ThreadReport, WorkerCommandReceipt, WorkerCommandStatus, WorkerOpenConfig } from '@baton/protocol'
import { openPrivateFile } from '../platform/private.ts'
import { processLockIsHeld } from '../platform/lock.ts'
import { contentHash, type DiscoveredWorker, type NodeLedger } from './ledger.ts'
import { workerPaths } from './paths.ts'
import type { DaemonWorkerHost } from './threads.ts'
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
    const rows = db.prepare('SELECT payload FROM thread_meta WHERE id=1').all()
    if (!rows.length) return 'empty'
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
    if (meta.config === undefined) return 'empty'
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
  // 只在本进程亲自完成首次启动后允许尚未收到 open 的空 Worker；重启后不恢复这个许可。
  const freshLaunches = new Set<string>()
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
        if (
          reply.storage_generation === saved!.config.storage_generation &&
          (!reply.session_id || reply.session_id === threadId)
        ) {
          freshLaunches.delete(threadId)
          if (!saved!.launch_attempted) await io(ledger.markWorkerLaunch(threadId))
          if (!saved!.ready) await io(ledger.saveWorker({ ...saved!, ready: true, launch_attempted: true }))
          return true
        }
        return !reply.storage_generation && freshLaunches.has(threadId)
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
      freshLaunches.delete(threadId)
      return 'lost'
    }
    if (condition === 'corrupt') return lost('本地 Worker 账本损坏或结构不匹配，原会话历史不可恢复')
    if (condition === 'empty') return lost('本地 Worker 账本缺少原会话记录，禁止重新创建会话')
    if (condition === 'missing' && saved.launch_attempted) return lost('本地 Worker 账本缺失，原会话历史不可恢复')
    const firstLaunch = await io(ledger.markWorkerLaunch(threadId))
    if (condition === 'missing' && !firstLaunch) return lost('上次 Worker 启动后的本地账本缺失，无法确认原会话是否创建')
    saved = (await io(ledger.worker(threadId)))!
    if (saved.history_unavailable || signal?.aborted) return saved.history_unavailable ? 'lost' : 'retry'
    if (firstLaunch && condition === 'missing') freshLaunches.add(threadId)
    try {
      await host.ensureWorker(threadId)
    } catch {
      return 'retry'
    }
    if (signal?.aborted) return 'retry'
    if (await status()) return 'ready'
    // 首次启动后的 IPC 暂不可用不构成历史丢失证据，下一轮重新检查进程锁和实体账本。
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
