import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { Effect } from 'effect'
import { expect, it } from 'vite-plus/test'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { acquireProcessLock } from '../platform/lock.ts'
import { openWorkerLedger, readLedger } from '../worker/ledger.ts'
import { initializeWorkerDirectory } from './host.ts'
import { isUpdateIdle } from './update-idle.ts'
import { saveUpgradeState, upgradeBlockers, upgradePaused } from './upgrade.ts'

it('allows idle Workers and waits for work that starts before preparation', async () => {
  const directory = await makePrivateTempDirectory('baton-update-idle-')
  const threadId = randomUUID()
  const paths = await initializeWorkerDirectory(directory, threadId)
  const lock = await acquireProcessLock(paths.lock)
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ledger = yield* openWorkerLedger({ dbPath: paths.ledger, dataDirectory: directory })
          const base = {
            ...ledger.initial,
            config: {
              thread_id: threadId,
              node_id: randomUUID(),
              storage_generation: randomUUID(),
              agent_type: 'cursor' as const,
              runtime_mode: 'full-access' as const,
              working_directory: directory,
              execution_timeout_seconds: 60,
              adapter_config: {},
            },
            phase: 'idle' as const,
            opened: true,
            nativeId: 'native',
          }
          yield* ledger.save(base)
          readLedger(paths.ledger)
          expect(yield* Effect.promise(() => upgradeBlockers(directory))).toEqual({
            blockers: [{ kind: 'thread', id: threadId, reason: 'worker_alive' }],
            pending_reports: 0,
          })
          expect(yield* Effect.promise(() => isUpdateIdle(directory))).toBe(true)
          const id = randomUUID()
          yield* ledger.save({
            ...base,
            phase: 'busy',
            activeMessage: id,
            messages: {
              [id]: {
                digest: 'd',
                state: 'sent',
                input: { id, text: 'work', epoch: 0, operationId: randomUUID(), mode: 'queue' },
              },
            },
          })
          yield* Effect.promise(() =>
            saveUpgradeState(directory, {
              operation_id: randomUUID(),
              source_version: 'v1.0.0',
              target_version: 'v1.0.1',
              phase: 'draining',
            }),
          )
          expect(yield* Effect.promise(() => upgradePaused(directory))).toBe(true)
          const blockers = yield* Effect.promise(() => upgradeBlockers(directory))
          expect(blockers.blockers).toContainEqual(expect.objectContaining({ kind: 'thread', id: threadId }))
          expect(yield* Effect.promise(() => isUpdateIdle(directory))).toBe(false)
        }),
      ),
    )
  } finally {
    await lock()
    await rm(directory, { recursive: true, force: true })
  }
})
