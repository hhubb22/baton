import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect } from 'effect'
import { expect, it } from 'vite-plus/test'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { openExecutionLedger } from './ledger.ts'

it('persists execution intent, stop tombstone and report acknowledgements across reopen', async () => {
  const root = await makePrivateTempDirectory('baton-execution-ledger-')
  const path = join(root, 'execution.db')
  const executionId = randomUUID()
  const generation = randomUUID()
  const stop = {
    type: 'execution.command' as const,
    execution_id: executionId,
    action: 'stop' as const,
    storage_generation: generation,
  }
  const report = {
    type: 'execution.report' as const,
    execution_id: executionId,
    storage_generation: generation,
    event_id: randomUUID(),
    seq: 1,
    status: 'cancelled' as const,
  }
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ledger = yield* openExecutionLedger(path)
          yield* ledger.save({ intent: false, stopped: stop, reports: [{ report, acked: false }] })
        }),
      ),
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ledger = yield* openExecutionLedger(path)
          expect(ledger.state.stopped).toEqual(stop)
          expect(ledger.state.reports).toEqual([{ report, acked: false }])
          yield* ledger.save({ ...ledger.state, intent: true, reports: [{ report, acked: true }] })
        }),
      ),
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ledger = yield* openExecutionLedger(path)
          expect(ledger.state.intent).toBe(true)
          expect(ledger.state.reports[0]?.acked).toBe(true)
        }),
      ),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
