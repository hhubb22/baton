import { it } from '@effect/vitest'
import { expect } from 'vite-plus/test'
import { Deferred, Effect, Exit, Fiber, Semaphore } from 'effect'
import { TestClock } from 'effect/testing'
import { withControlBudget } from './control-budget.ts'

it.effect('waiting for a control permit leaves the full execution budget available', () =>
  Effect.gen(function* () {
    const gate = yield* Semaphore.make(1)
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const first = yield* withControlBudget(
      gate,
      { queueMs: 2000, executionMs: 1000 },
      Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(release)
      }),
    ).pipe(Effect.forkChild)
    yield* Deferred.await(started)
    const second = yield* withControlBudget(
      gate,
      { queueMs: 2000, executionMs: 1000 },
      Effect.sleep(900).pipe(Effect.as('completed')),
    ).pipe(Effect.forkChild)
    yield* TestClock.adjust(900)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(first)
    yield* TestClock.adjust(900)
    expect(yield* Fiber.join(second)).toBe('completed')
  }),
)

it.effect('queue expiry removes the waiter without starting work or leaking a permit', () =>
  Effect.gen(function* () {
    const gate = yield* Semaphore.make(1)
    yield* gate.take(1)
    let executed = false
    const waiting = yield* withControlBudget(
      gate,
      { queueMs: 100, executionMs: 1000 },
      Effect.sync(() => {
        executed = true
      }),
    ).pipe(Effect.exit, Effect.forkChild)
    yield* TestClock.adjust(100)
    expect(Exit.isFailure(yield* Fiber.join(waiting))).toBe(true)
    yield* gate.release(1)
    expect(yield* withControlBudget(gate, { queueMs: 100, executionMs: 100 }, Effect.succeed('available'))).toBe(
      'available',
    )
    expect(executed).toBe(false)
  }),
)

it.effect('execution expiry releases the control permit for later work', () =>
  Effect.gen(function* () {
    const gate = yield* Semaphore.make(1)
    const running = yield* withControlBudget(gate, { queueMs: 100, executionMs: 100 }, Effect.never).pipe(
      Effect.exit,
      Effect.forkChild,
    )
    yield* TestClock.adjust(100)
    expect(Exit.isFailure(yield* Fiber.join(running))).toBe(true)
    expect(yield* withControlBudget(gate, { queueMs: 100, executionMs: 100 }, Effect.succeed('available'))).toBe(
      'available',
    )
  }),
)
