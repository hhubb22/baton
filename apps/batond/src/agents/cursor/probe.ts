import { Effect } from 'effect'
import { connectCursorHost, type CursorProcessOptions } from './transport.ts'

/** Read-only authentication/catalog probe; never creates or resumes an SDK Agent. */
export const probeCursor = (options: CursorProcessOptions) =>
  Effect.scoped(
    Effect.gen(function* () {
      const controller = new AbortController()
      const host = yield* connectCursorHost(options, controller.signal)
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          controller.abort()
          yield* host.disconnect
          yield* host.reap.pipe(Effect.ignore)
        }),
      )
      return yield* host.probe
    }),
  )
