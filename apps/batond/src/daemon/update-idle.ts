import { processLockIsHeld } from '../platform/lock.ts'
import { readLedger } from '../worker/ledger.ts'
import { workerPaths } from './paths.ts'
import { upgradeBlockers } from './upgrade.ts'

/** Idle Workers may be drained by prepare; active and uncertain work must finish first. */
export async function isUpdateIdle(directory: string): Promise<boolean> {
  const result = await upgradeBlockers(directory)
  if (result.pending_reports) return false
  const idleThreads = new Set<string>()
  for (const blocker of result.blockers) {
    if (blocker.kind !== 'thread' || blocker.reason !== 'worker_alive') continue
    const paths = workerPaths(directory, blocker.id)
    if (await processLockIsHeld(paths.launchLock)) continue
    if (!(await processLockIsHeld(paths.lock))) continue
    try {
      const state = readLedger(paths.ledger).initial
      if (
        state.phase === 'idle' &&
        !state.activeMessage &&
        !Object.values(state.messages).some(
          (message) => ['queued', 'intent', 'sent'].includes(message.state) && !message.ended,
        )
      )
        idleThreads.add(blocker.id)
    } catch {
      /* An unreadable ledger cannot prove idleness. */
    }
  }
  return result.blockers.every(
    (blocker) =>
      (blocker.kind === 'thread' && blocker.reason === 'worker_alive' && idleThreads.has(blocker.id)) ||
      (blocker.kind === 'process' && [...idleThreads].some((id) => blocker.reason.startsWith(`${id}:`))),
  )
}
