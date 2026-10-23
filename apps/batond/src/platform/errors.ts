import * as Effect from 'effect/Effect'

export class PlatformError extends Error {
  readonly _tag = 'PlatformError'
  readonly operation: string
  constructor(operation: string, cause: unknown) {
    super(`${operation}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    this.operation = operation
    this.name = 'PlatformError'
  }
}

export const platformEffect = <A>(operation: string, run: () => Promise<A>): Effect.Effect<A, PlatformError> =>
  Effect.tryPromise({ try: run, catch: (cause) => new PlatformError(operation, cause) })

export const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code
