import type { NodeLedger } from './ledger.ts'
import type { DaemonWorkerHost } from './host.ts'
import { DaemonStorageFailure, ledgerPromise as io } from './storage.ts'

export type WorkerRecoveryResult = 'ready' | 'lost' | 'retry' | 'runtime_mode_conflict'

/**
 * Thread state is inside node.db, so recovery starts the in-process fiber for
 * threads with durable activity and asks the state machine to reconcile it.
 */
export function makeWorkerRecovery(options: {
  readonly ledger: NodeLedger
  readonly host: DaemonWorkerHost
  readonly nodeId?: string
  readonly dataDirectory?: string
  readonly inspect?: (saved: import('./ledger.ts').DiscoveredWorker) => Promise<unknown>
}) {
  const { ledger, host } = options
  const inFlight = new Map<string, Promise<WorkerRecoveryResult>>()

  async function ensureOne(threadId: string, signal?: AbortSignal): Promise<WorkerRecoveryResult> {
    if (signal?.aborted) return 'retry'
    const saved = await io(ledger.worker(threadId))
    if (!saved || (options.nodeId && saved.config.node_id !== options.nodeId)) return 'retry'
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
        if (error instanceof DaemonStorageFailure) throw error
        return 'retry'
      }
    }
    const initial = await status()
    if (initial !== 'retry') return initial
    if (signal?.aborted) return 'retry'
    try {
      await host.ensureWorker(threadId)
    } catch {
      return 'retry'
    }
    if (signal?.aborted) return 'retry'
    return status()
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
      for (const threadId of await io(ledger.activeThreadIds())) {
        if (signal?.aborted) return
        await ensure(threadId, signal)
      }
    },
  }
}
