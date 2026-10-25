import { Effect, Semaphore } from 'effect'

export interface ControlBudget {
  readonly queueMs: number
  readonly executionMs: number
}

export const defaultControlBudgets = {
  authenticate: { queueMs: 2000, executionMs: 5000 },
  validate: { queueMs: 2000, executionMs: 3000 },
  heartbeat: { queueMs: 2000, executionMs: 3000 },
  disconnect: { queueMs: 2000, executionMs: 5000 },
  sync: { queueMs: 2000, executionMs: 10_000 },
  runtime_report: { queueMs: 2000, executionMs: 10_000 },
  project_request: { queueMs: 2000, executionMs: 15_000 },
  receipt: { queueMs: 2000, executionMs: 10_000 },
  report: { queueMs: 2000, executionMs: 15_000 },
  browser: { queueMs: 2000, executionMs: 3000 },
  read: { queueMs: 2000, executionMs: 5000 },
  dispatch: { queueMs: 2000, executionMs: 10_000 },
  schedule: { queueMs: 2000, executionMs: 10_000 },
  maintenance: { queueMs: 2000, executionMs: 5000 },
} satisfies Record<string, ControlBudget>

export type ControlOperation = keyof typeof defaultControlBudgets
export type ControlBudgets = Record<ControlOperation, ControlBudget>

export const withControlBudget = <A, E, R>(
  gate: Semaphore.Semaphore,
  budget: ControlBudget,
  task: Effect.Effect<A, E, R>,
) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.acquireUseRelease(
      restore(gate.take(1).pipe(Effect.timeout(budget.queueMs))),
      () => restore(task.pipe(Effect.timeout(budget.executionMs))),
      () => gate.release(1),
    ),
  )
