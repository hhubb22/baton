import { Effect } from 'effect'
import type { ExecutionReportResult } from '@baton/protocol'
import { inspectExecutions } from '../execution/service.ts'
import { executionPaths } from '../execution/paths.ts'
import { openExecutionLedger } from '../execution/ledger.ts'

/** Only used after the upgrade barrier has confirmed that execution Workers are stopped. */
export function syncingExecutionReports(dataDirectory: string) {
  return {
    async collectReports() {
      return (await inspectExecutions(dataDirectory)).flatMap(({ state }) =>
        state.reports.filter((entry) => !entry.acked).map((entry) => entry.report),
      )
    },
    async ack(result: ExecutionReportResult) {
      if (!result.ok) return
      const path = executionPaths(dataDirectory, result.execution_id).ledger
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const ledger = yield* openExecutionLedger(path)
            const next = ledger.state.reports.map((entry) =>
              entry.report.event_id === result.event_id && entry.report.seq === result.seq
                ? { ...entry, acked: true }
                : entry,
            )
            yield* ledger.save({ ...ledger.state, reports: next })
          }),
        ),
      )
    },
  }
}
