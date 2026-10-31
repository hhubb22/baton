import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Clock, Effect, Metric } from 'effect'
import { processLockIsHeld } from '../platform/lock.ts'
import { isMissing } from './identity.ts'
import type { NodeLedger } from './ledger.ts'
import type { ProjectManager } from '../project/types.ts'
import { workerPaths } from './paths.ts'

const agents = ['codex', 'cursor', 'pi', 'kiro', 'antigravity', 'droid'] as const
const reasons = ['device_offline', 'approval', 'credential_missing', 'queue', 'lease', 'backoff'] as const
const bytes = Metric.gauge('baton.ledger.bytes')
const budget = Metric.gauge('baton.ledger.budget_ratio')
const reports = Metric.gauge('baton.reports.unacked')
const reportAge = Metric.gauge('baton.reports.oldest_age_s')
const workers = Metric.gauge('baton.workers.active')
const waits = Metric.gauge('baton.wait.oldest_age_s')
const budgetBytes = 1024 * 1024 * 1024

const size = async (path: string) => {
  try {
    return (await stat(path)).size
  } catch (error) {
    if (isMissing(error)) return 0
    throw error
  }
}

export const collectNodeMetrics = Effect.fnUntraced(function* (
  directory: string,
  ledger: NodeLedger,
  projects?: ProjectManager,
  offlineAge?: () => number,
) {
  const clock = yield* Clock.Clock
  const now = clock.currentTimeMillisUnsafe()
  const backlog = yield* ledger.reportBacklog()
  const known = yield* ledger.workers()
  const observed = yield* Effect.tryPromise({
    try: async (signal) => {
      let ids: string[]
      try {
        ids = await readdir(join(directory, 'threads'))
      } catch (error) {
        if (!isMissing(error)) throw error
        ids = []
      }
      const paths = [join(directory, 'node.db'), join(directory, 'project-runtime.db')]
      for (const id of ids) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) continue
        paths.push(workerPaths(directory, id).ledger)
      }
      let total = 0
      for (const path of paths) {
        signal.throwIfAborted()
        total += (await size(path)) + (await size(`${path}-wal`))
      }
      const active: Record<string, number> = {}
      let queueAge = backlog.oldest_ms === null ? 0 : Math.max(0, (now - backlog.oldest_ms) / 1000)
      let approvalAge = 0
      for (const worker of known) {
        signal.throwIfAborted()
        const path = workerPaths(directory, worker.threadId)
        if (await processLockIsHeld(path.lock))
          active[worker.config.agent_type] = (active[worker.config.agent_type] ?? 0) + 1
        if (!(await size(path.ledger))) continue
        const db = new DatabaseSync(path.ledger, { readOnly: true })
        try {
          const queue = db
            .prepare(
              "SELECT min(json_extract(payload,'$.receivedAtMs')) AS started FROM thread_messages WHERE json_extract(payload,'$.state')='queued'",
            )
            .get()
          const approval = db
            .prepare(
              "SELECT min(json_extract(q.value,'$.startedAtMs')) AS started FROM thread_meta m, json_each(json_extract(m.payload,'$.questions')) q WHERE json_extract(q.value,'$.state') NOT IN ('resolved','cancelled')",
            )
            .get()
          if (typeof queue?.started === 'number') queueAge = Math.max(queueAge, (now - queue.started) / 1000)
          if (typeof approval?.started === 'number')
            approvalAge = Math.max(approvalAge, (now - approval.started) / 1000)
        } finally {
          db.close()
        }
      }
      return { total, active, queueAge, approvalAge }
    },
    catch: (error) => error,
  })
  const leaseAge = yield* Effect.try({ try: () => projects?.leaseWaitAge?.() ?? 0, catch: (error) => error })
  const disconnectedAge = yield* Effect.try({ try: () => offlineAge?.() ?? 0, catch: (error) => error })
  yield* Metric.update(bytes, observed.total)
  yield* Metric.update(budget, observed.total / budgetBytes)
  yield* Metric.update(reports, backlog.count)
  yield* Metric.update(reportAge, backlog.oldest_ms === null ? 0 : Math.max(0, (now - backlog.oldest_ms) / 1000))
  for (const agent of agents)
    yield* Metric.update(Metric.withAttributes(workers, { 'baton.agent': agent }), observed.active[agent] ?? 0)
  for (const reason of reasons)
    yield* Metric.update(
      Metric.withAttributes(waits, { 'baton.wait.reason': reason }),
      reason === 'queue'
        ? observed.queueAge
        : reason === 'approval'
          ? observed.approvalAge
          : reason === 'lease'
            ? leaseAge
            : reason === 'device_offline'
              ? disconnectedAge
              : 0,
    )
})

export const nodeMetricsLoop = (
  directory: string,
  ledger: NodeLedger,
  projects: ProjectManager,
  offlineAge: () => number,
) =>
  collectNodeMetrics(directory, ledger, projects, offlineAge).pipe(
    Effect.timeout('3 seconds'),
    Effect.ignore,
    Effect.andThen(Effect.sleep('30 seconds')),
    Effect.forever,
  )
