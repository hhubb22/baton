import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Deferred, Effect, Fiber } from 'effect'
import { expect, it } from '@effect/vitest'
import { listenWorker, requestWorker } from './ipc.ts'

it.effect('authenticates before dispatch and distinguishes Worker readiness from Agent readiness', () =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), 'baton-ipc-'))),
    (directory) =>
      Effect.scoped(
        Effect.gen(function* () {
          const endpoint =
            process.platform === 'win32' ? `\\\\.\\pipe\\baton-test-${process.pid}` : join(directory, 'worker.sock')
          const token = 'a'.repeat(64)
          let calls = 0
          yield* listenWorker({
            endpoint,
            token,
            handle: () =>
              Effect.sync(() => {
                calls++
                return { type: 'result', ok: true, worker_ready: true, agent_ready: false }
              }),
          })
          const request = { type: 'status', ok: false } as const
          const denied = yield* Effect.promise(() =>
            requestWorker({ endpoint, token: 'b'.repeat(64), request }).then(
              () => false,
              () => true,
            ),
          )
          expect(denied).toBe(true)
          expect(calls).toBe(0)
          const result = yield* Effect.promise(() => requestWorker({ endpoint, token, request }))
          expect(result).toMatchObject({ ok: true, worker_ready: true, agent_ready: false })
          expect(calls).toBe(1)
        }),
      ),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  ),
)

it.effect('disconnects do not interrupt a dispatch already passed to the Worker', () =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), 'baton-ipc-'))),
    (directory) =>
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>()
          const complete = yield* Deferred.make<void>()
          const finished = yield* Deferred.make<void>()
          const endpoint =
            process.platform === 'win32'
              ? `\\\\.\\pipe\\baton-disconnect-${process.pid}`
              : join(directory, 'worker.sock')
          const token = 'a'.repeat(64)
          yield* listenWorker({
            endpoint,
            token,
            handle: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(complete)
                yield* Deferred.succeed(finished, undefined)
                return { type: 'result', ok: true }
              }),
          })
          const caller = yield* Effect.promise(() =>
            requestWorker({ endpoint, token, request: { type: 'status', ok: false }, timeoutMs: 50 }).catch(
              () => undefined,
            ),
          ).pipe(Effect.forkScoped)
          yield* Deferred.await(entered)
          yield* Fiber.join(caller)
          yield* Deferred.succeed(complete, undefined)
          yield* Deferred.await(finished)
        }),
      ),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  ),
)
