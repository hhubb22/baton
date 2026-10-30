import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect, Exit, Metric } from 'effect'
import { expect, it, vi } from 'vite-plus/test'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { makeNodeLedger } from './ledger.ts'
import { collectNodeMetrics } from './telemetry.ts'
import { workerPaths } from './paths.ts'
import { acquireProcessLock } from '../platform/lock.ts'

it('reports durable backlog age and clears gauges after acknowledgement', async () => {
  const directory = await makePrivateTempDirectory('baton-metrics-')
  const time = vi.spyOn(Date, 'now').mockReturnValue(1000)
  try {
    const values = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ledger = yield* makeNodeLedger(join(directory, 'node.db'))
          const report = {
            type: 'thread.report' as const,
            thread_id: randomUUID(),
            event_id: randomUUID(),
            worker_seq: 1,
            kind: 'thread.opened' as const,
          }
          yield* ledger.ingest(report)
          time.mockReturnValue(11_000)
          yield* collectNodeMetrics(directory, ledger)
          const count = Metric.gauge('baton.reports.unacked')
          const size = Metric.gauge('baton.ledger.bytes')
          const ratio = Metric.gauge('baton.ledger.budget_ratio')
          const before = {
            count: (yield* Metric.value(count)).value,
            size: (yield* Metric.value(size)).value,
            ratio: (yield* Metric.value(ratio)).value,
            age: (yield* Metric.value(Metric.gauge('baton.reports.oldest_age_s'))).value,
          }
          yield* ledger.acknowledge({ ...report, type: 'thread.report_result', ok: true })
          yield* collectNodeMetrics(directory, ledger)
          const after = (yield* Metric.value(count)).value
          const age = (yield* Metric.value(Metric.gauge('baton.reports.oldest_age_s'))).value
          return { before, after, age }
        }),
      ).pipe(Effect.provideService(Metric.MetricRegistry, new Map())),
    )
    expect(values.before.count).toBe(1)
    expect(values.before.age).toBe(10)
    expect(values.before.size).toBeGreaterThan(0)
    expect(values.before.ratio).toBe(values.before.size / (1024 * 1024 * 1024))
    expect(values.after).toBe(0)
    expect(values.age).toBe(0)
  } finally {
    time.mockRestore()
    await rm(directory, { recursive: true, force: true })
  }
})

it('counts live Worker locks and WAL bytes, skips failed scans and recovers', async () => {
  const directory = await makePrivateTempDirectory('baton-metrics-lock-')
  const id = randomUUID()
  const path = workerPaths(directory, id)
  await mkdir(path.threadDirectory, { recursive: true })
  await writeFile(`${path.ledger}-wal`, Buffer.alloc(4096))
  const release = await acquireProcessLock(path.lock)
  const bad = join(directory, 'bad')
  await mkdir(bad)
  await writeFile(join(bad, 'threads'), 'not a directory')
  try {
    const values = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ledger = yield* makeNodeLedger(join(directory, 'node.db'))
          yield* ledger.saveWorker({
            threadId: id,
            ready: true,
            config: {
              thread_id: id,
              node_id: randomUUID(),
              storage_generation: randomUUID(),
              agent_type: 'cursor',
              runtime_mode: 'full-access',
              working_directory: directory,
              execution_timeout_seconds: 60,
              adapter_config: {},
            },
          })
          const active = Metric.withAttributes(Metric.gauge('baton.workers.active'), { 'baton.agent': 'cursor' })
          yield* collectNodeMetrics(directory, ledger)
          const before = (yield* Metric.value(active)).value
          const bytes = (yield* Metric.value(Metric.gauge('baton.ledger.bytes'))).value
          const failed = yield* Effect.exit(collectNodeMetrics(bad, ledger))
          const afterFailure = (yield* Metric.value(active)).value
          yield* Effect.promise(release)
          yield* collectNodeMetrics(directory, ledger)
          return {
            before,
            bytes,
            failed: Exit.isFailure(failed),
            afterFailure,
            after: (yield* Metric.value(active)).value,
          }
        }),
      ).pipe(Effect.provideService(Metric.MetricRegistry, new Map())),
    )
    expect(values.before).toBe(1)
    expect(values.bytes).toBeGreaterThanOrEqual(4096)
    expect(values.failed).toBe(true)
    expect(values.afterFailure).toBe(1)
    expect(values.after).toBe(0)
  } finally {
    await release()
    await rm(directory, { recursive: true, force: true })
  }
})
