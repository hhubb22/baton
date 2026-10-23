import type { AgentMessage, AgentOptions, InteractionUpdate } from '@cursor/sdk'
import * as Effect from 'effect/Effect'
import {
  makeCursorAgentSdkRunner,
  CursorAgentSdkRunnerError,
  type CursorAgentSdkProtocolLogger,
  type CursorAgentSdkOpenInput,
  type CursorAgentSdkSendInput,
} from './server/CursorAgentSdk.ts'

export * from './server/CursorAgentSdk.ts'
export { CursorSdk, layerWithSdk } from './server/CursorSdk.ts'
export { inspectCursorSdk } from './server/sdk-inspection.ts'
export { ThreadId, ProviderSessionId } from '../upstream/contracts.ts'
export { ProviderEventLoggers, NoOpProviderEventLoggers } from '../upstream/ProviderEventLoggers.ts'
export type {
  AgentMessage,
  AgentOptions,
  InteractionUpdate,
  RunResult,
  SendOptions,
  SDKUserMessage,
  LocalAgentStore,
} from '@cursor/sdk'

export const makeBatonCursorAgentSdkRunner = (
  loggerFor: (input: CursorAgentSdkOpenInput) => CursorAgentSdkProtocolLogger | undefined = () => undefined,
) =>
  Effect.gen(function* () {
    const runner = yield* makeCursorAgentSdkRunner(loggerFor)
    return {
      ...runner,
      open: (input: CursorAgentSdkOpenInput) => {
        if (!input.options.apiKey?.trim()) {
          return Effect.fail(
            new CursorAgentSdkRunnerError({
              method: 'agent.open',
              cause: new Error('An explicit Cursor API key is required'),
            }),
          )
        }
        if (!input.options.local || input.options.cloud) {
          return Effect.fail(
            new CursorAgentSdkRunnerError({
              method: 'agent.open',
              cause: new Error('Cursor requires a local runtime'),
            }),
          )
        }
        const options: AgentOptions = {
          ...input.options,
          local: {
            ...input.options.local,
            autoReview: true,
            enableAgentRetries: false,
            sandboxOptions: { ...input.options.local.sandboxOptions, enabled: true },
          },
        }
        return runner.open({ ...input, options }).pipe(
          Effect.flatMap((session) =>
            Effect.gen(function* () {
              const close = yield* Effect.cached(session.close)
              return {
                ...session,
                close,
                send: <Error>(sendInput: CursorAgentSdkSendInput<Error>) =>
                  session.send(sendInput).pipe(
                    Effect.flatMap((run) =>
                      Effect.gen(function* () {
                        const wait = yield* Effect.cached(run.wait)
                        const cancel = yield* Effect.cached(run.cancel)
                        return { ...run, wait, cancel }
                      }),
                    ),
                  ),
              }
            }),
          ),
        )
      },
    }
  })

function unknownRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value)) : undefined
}
function nestedString(value: unknown, path: ReadonlyArray<string>): string | undefined {
  let current: unknown = value
  for (const key of path) current = unknownRecord(current)?.[key]
  return typeof current === 'string' ? current : undefined
}

// Extracted from t3code provider-cursor/server/adapter.ts.
export function textFromAgentMessage(message: AgentMessage): string {
  const value = message.message
  if (typeof value === 'string') return value
  const direct =
    nestedString(value, ['text']) ??
    nestedString(value, ['message', 'text']) ??
    nestedString(value, ['userMessage', 'text']) ??
    nestedString(value, ['assistantMessage', 'text'])
  if (direct !== undefined) return direct
  const content = unknownRecord(value)?.content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((part) => {
      const text = unknownRecord(part)?.text
      return typeof text === 'string' ? [text] : []
    })
    .join('')
}

export function textFromInteractionUpdate(update: InteractionUpdate): string | undefined {
  return update.type === 'text-delta' ? update.text : undefined
}
