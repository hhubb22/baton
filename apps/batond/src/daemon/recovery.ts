import { inspectWorkerLedger, type WorkerLedgerInspection } from '../worker/ledger.ts'
import { upgradePaused } from './upgrade.ts'
import { processLockIsHeld } from '../platform/lock.ts'
import { type DiscoveredWorker, type NodeLedger } from './ledger.ts'
import { workerPaths } from './paths.ts'
import type { DaemonWorkerHost } from './host.ts'
import { DaemonStorageFailure, ledgerPromise as io } from './storage.ts'

export type WorkerRecoveryResult = 'ready' | 'lost' | 'retry' | 'runtime_mode_conflict'

export function makeWorkerRecovery(options: {
  readonly dataDirectory: string
  readonly ledger: NodeLedger
  readonly host: DaemonWorkerHost
  readonly inspect?: (saved: DiscoveredWorker) => Promise<WorkerLedgerInspection>
}) {
  const { ledger, host, dataDirectory } = options
  const inFlight = new Map<string, Promise<WorkerRecoveryResult>>()
  const inspect =
    options.inspect ??
    ((saved: DiscoveredWorker) => inspectWorkerLedger(workerPaths(dataDirectory, saved.threadId).ledger, saved.config))

  async function ensureOne(threadId: string, signal?: AbortSignal): Promise<WorkerRecoveryResult> {
    if (signal?.aborted || (await upgradePaused(dataDirectory))) return 'retry'
    let saved = await io(ledger.worker(threadId))
    if (!saved) return 'retry'
    if (saved.history_unavailable) return 'lost'
    const status = async (): Promise<'ready' | 'retry' | 'runtime_mode_conflict'> => {
      try {
        const reply = await host.request(threadId, { type: 'status', ok: false }, { timeoutMs: 250 })
        if (!reply.ok || reply.worker_ready !== true) return 'retry'
        const current = await io(ledger.worker(threadId))
        if (!current || current.history_unavailable) return 'retry'
        if (
          reply.storage_generation === current.config.storage_generation &&
          reply.session_id === threadId &&
          reply.runtime_mode !== current.config.runtime_mode
        )
          return 'runtime_mode_conflict'
        if (
          reply.storage_generation === current.config.storage_generation &&
          reply.runtime_mode === current.config.runtime_mode &&
          (!reply.session_id || reply.session_id === threadId)
        ) {
          if (current.startup_phase !== 'open_attempted') await io(ledger.markWorkerOpenAttempt(threadId))
          if (!current.launch_attempted) await io(ledger.markWorkerLaunch(threadId))
          if (!current.ready) await io(ledger.saveWorker({ ...current, ready: true, launch_attempted: true }))
          return 'ready'
        }
        return !reply.storage_generation && !reply.session_id && current.startup_phase === 'awaiting_open'
          ? 'ready'
          : 'retry'
      } catch (error) {
        // 节点账本写入失败必须由调用方停止执行。
        if (error instanceof DaemonStorageFailure) throw error
        return 'retry'
      }
    }
    const initialStatus = await status()
    if (initialStatus !== 'retry') return initialStatus
    if (signal?.aborted) return 'retry'
    const paths = workerPaths(dataDirectory, threadId)
    try {
      if ((await processLockIsHeld(paths.lock)) || (await processLockIsHeld(paths.launchLock))) return 'retry'
    } catch {
      return 'retry'
    }
    const condition = await inspect(saved)
    if (condition === 'runtime_mode_conflict') return condition
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
    const startedStatus = await status()
    if (startedStatus !== 'retry') return startedStatus
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
