import type { RunResult } from '@cursor/sdk'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as CursorAgentSdk from '@baton/providers/cursor'
export { readCursorAgentSdkReplayTranscript } from './cursor-fixtures.ts'

const ProviderReplayEntry = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('expect_outbound'),
    label: Schema.optional(Schema.String),
    frame: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal('emit_inbound'),
    label: Schema.optional(Schema.String),
    frame: Schema.Unknown,
    afterMs: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal('runtime_exit'),
    status: Schema.Literals(['success', 'error', 'cancelled']),
    error: Schema.optional(Schema.Unknown),
  }),
])

export const CursorAgentSdkReplayTranscript = Schema.Struct({
  provider: Schema.Literal(CursorAgentSdk.CURSOR_PROVIDER),
  protocol: Schema.Literal(CursorAgentSdk.CURSOR_AGENT_SDK_PROTOCOL),
  version: Schema.String,
  scenario: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  entries: Schema.Array(ProviderReplayEntry),
})
export type CursorAgentSdkReplayTranscript = typeof CursorAgentSdkReplayTranscript.Type
export const decodeCursorAgentSdkReplayTranscript = Schema.decodeUnknownEffect(CursorAgentSdkReplayTranscript)

export class CursorReplayTranscriptDecodeError extends Schema.TaggedError<CursorReplayTranscriptDecodeError>()(
  'CursorReplayTranscriptDecodeError',
  {
    driver: Schema.optional(Schema.String),
    protocol: Schema.optional(Schema.String),
    scenario: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode Cursor Agent SDK replay transcript for scenario ${this.scenario ?? '<unknown>'}.`
  }
}

export class CursorReplayExhaustedError extends Schema.TaggedError<CursorReplayExhaustedError>()(
  'CursorReplayExhaustedError',
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    actual: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Cursor Agent SDK replay transcript exhausted at cursor ${this.cursor} in scenario ${this.scenario}.`
  }
}

export class CursorReplayFrameMismatchError extends Schema.TaggedError<CursorReplayFrameMismatchError>()(
  'CursorReplayFrameMismatchError',
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    expected: Schema.Unknown,
    actual: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Cursor Agent SDK replay frame mismatch at cursor ${this.cursor} in scenario ${this.scenario}.`
  }
}

export class CursorReplayIncompleteError extends Schema.TaggedError<CursorReplayIncompleteError>()(
  'CursorReplayIncompleteError',
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    remaining: Schema.Number,
  },
) {
  override get message(): string {
    return `Cursor Agent SDK replay ended with ${this.remaining} unconsumed entries in scenario ${this.scenario}.`
  }
}

export class CursorReplayRuntimeError extends Schema.TaggedError<CursorReplayRuntimeError>()(
  'CursorReplayRuntimeError',
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Cursor Agent SDK replay failed at cursor ${this.cursor} in scenario ${this.scenario}.`
  }
}

export const CursorAgentSdkReplayError = Schema.Union([
  CursorReplayTranscriptDecodeError,
  CursorReplayExhaustedError,
  CursorReplayFrameMismatchError,
  CursorReplayIncompleteError,
  CursorReplayRuntimeError,
])
export type CursorAgentSdkReplayError = typeof CursorAgentSdkReplayError.Type
const isCursorAgentSdkReplayError = Schema.is(CursorAgentSdkReplayError)
const isCursorAgentSdkRunnerError = Schema.is(CursorAgentSdk.CursorAgentSdkRunnerError)

type CursorProtocolPayload = CursorAgentSdk.CursorAgentSdkProtocolLogEvent['payload']
type CursorOutgoingFrame = Extract<
  CursorAgentSdk.CursorAgentSdkProtocolLogEvent,
  { readonly direction: 'outgoing' }
>['payload']

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function normalizeContextHandoffText(value: string): string {
  if (!value.startsWith('Context handoff (')) {
    return value
  }
  const marker = '\n\nUser message:\n'
  const markerIndex = value.indexOf(marker)
  const headerEnd = value.indexOf(':\n')
  if (markerIndex === -1 || headerEnd === -1 || headerEnd >= markerIndex) {
    return value
  }
  return `${value.slice(0, headerEnd + 2)}<dynamic-summary>${value.slice(markerIndex)}`
}

function normalizeFrame(value: unknown): unknown {
  if (typeof value === 'string') {
    return normalizeContextHandoffText(value)
  }
  if (Array.isArray(value)) {
    return value.map(normalizeFrame)
  }
  if (typeof value !== 'object' || value === null) {
    return value
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeFrame(entry)]))
}

function sameFrame(left: unknown, right: unknown): boolean {
  return stableStringify(normalizeFrame(left)) === stableStringify(normalizeFrame(right))
}

function makeSignal(): {
  readonly promise: Promise<void>
  readonly resolve: () => void
} {
  let resolve = () => {}
  const promise = new Promise<void>((onResolve) => {
    resolve = onResolve
  })
  return { promise, resolve }
}

function replayRunnerError(
  transcript: CursorAgentSdkReplayTranscript,
  cause: unknown,
  method: string,
): CursorAgentSdk.CursorAgentSdkRunnerError {
  if (isCursorAgentSdkRunnerError(cause)) {
    return cause
  }
  return new CursorAgentSdk.CursorAgentSdkRunnerError({
    method,
    cause: isCursorAgentSdkReplayError(cause)
      ? cause
      : new CursorReplayRuntimeError({
          scenario: transcript.scenario,
          cursor: 0,
          cause,
        }),
  })
}

export function makeCursorAgentSdkReplayRunner(
  transcript: CursorAgentSdkReplayTranscript,
): CursorAgentSdk.CursorAgentSdkRunner['Service'] {
  let cursor = 0
  let failure: CursorAgentSdkReplayError | null = null
  let cursorAdvanced = makeSignal()

  const recordFailure = <Error extends CursorAgentSdkReplayError>(error: Error): Error => {
    failure = error
    cursorAdvanced.resolve()
    return error
  }

  const fail = (error: CursorAgentSdkReplayError): never => {
    throw recordFailure(error)
  }

  const advance = () => {
    cursor += 1
    const signal = cursorAdvanced
    cursorAdvanced = makeSignal()
    signal.resolve()
  }

  const assertOutbound = (actual: CursorOutgoingFrame) => {
    if (failure !== null) {
      throw failure
    }
    const entry = transcript.entries[cursor]
    if (entry === undefined) {
      return fail(
        new CursorReplayExhaustedError({
          scenario: transcript.scenario,
          cursor,
          actual,
        }),
      )
    }
    if (entry.type !== 'expect_outbound' || !sameFrame(entry.frame, actual)) {
      return fail(
        new CursorReplayFrameMismatchError({
          scenario: transcript.scenario,
          cursor,
          expected: entry.type === 'expect_outbound' ? entry.frame : entry,
          actual,
        }),
      )
    }
    advance()
  }

  const consumeInbound = <Type extends CursorProtocolPayload['type']>(
    type: Type,
  ): Extract<CursorProtocolPayload, { readonly type: Type }> => {
    const entry = transcript.entries[cursor]
    if (
      entry === undefined ||
      entry.type !== 'emit_inbound' ||
      typeof entry.frame !== 'object' ||
      entry.frame === null ||
      Reflect.get(entry.frame, 'type') !== type
    ) {
      return fail(
        new CursorReplayFrameMismatchError({
          scenario: transcript.scenario,
          cursor,
          expected: { type },
          actual: entry,
        }),
      )
    }
    const frame = entry.frame as Extract<CursorProtocolPayload, { readonly type: Type }>
    advance()
    return frame
  }

  const waitForRun = <Error>(
    runId: string,
    sendInput: CursorAgentSdk.CursorAgentSdkSendInput<Error>,
  ): Effect.Effect<RunResult, CursorAgentSdkReplayError> =>
    Effect.gen(function* () {
      while (true) {
        if (failure !== null) {
          return yield* failure
        }
        const entry = transcript.entries[cursor]
        if (entry === undefined) {
          return yield* recordFailure(
            new CursorReplayExhaustedError({
              scenario: transcript.scenario,
              cursor,
              actual: { type: 'run.completed', runId },
            }),
          )
        }
        if (entry.type === 'expect_outbound') {
          const expectedCancel = {
            type: 'run.cancel',
            runId,
          }
          if (!sameFrame(entry.frame, expectedCancel)) {
            return yield* recordFailure(
              new CursorReplayFrameMismatchError({
                scenario: transcript.scenario,
                cursor,
                expected: expectedCancel,
                actual: entry.frame,
              }),
            )
          }
          const signal = cursorAdvanced
          yield* Effect.promise(() => signal.promise)
          continue
        }
        if (entry.type === 'runtime_exit') {
          advance()
          if (entry.status === 'success') {
            continue
          }
          return yield* recordFailure(
            new CursorReplayRuntimeError({
              scenario: transcript.scenario,
              cursor: cursor - 1,
              cause: entry.error ?? entry.status,
            }),
          )
        }
        if (
          typeof entry.frame !== 'object' ||
          entry.frame === null ||
          typeof Reflect.get(entry.frame, 'type') !== 'string'
        ) {
          return yield* recordFailure(
            new CursorReplayFrameMismatchError({
              scenario: transcript.scenario,
              cursor,
              expected: { type: 'interaction.update | run.completed' },
              actual: entry.frame,
            }),
          )
        }
        const frame = entry.frame as CursorProtocolPayload
        if (frame.type === 'interaction.update') {
          if (frame.runId !== runId) {
            return yield* recordFailure(
              new CursorReplayFrameMismatchError({
                scenario: transcript.scenario,
                cursor,
                expected: { runId },
                actual: frame,
              }),
            )
          }
          advance()
          yield* (sendInput.onDelta?.(frame.update) ?? Effect.void).pipe(
            Effect.mapError((cause) =>
              recordFailure(
                new CursorReplayRuntimeError({
                  scenario: transcript.scenario,
                  cursor: cursor - 1,
                  cause,
                }),
              ),
            ),
          )
          yield* Effect.yieldNow
          continue
        }
        if (frame.type === 'run.completed') {
          if (frame.result.id !== runId) {
            return yield* recordFailure(
              new CursorReplayFrameMismatchError({
                scenario: transcript.scenario,
                cursor,
                expected: { runId },
                actual: frame.result,
              }),
            )
          }
          advance()
          return frame.result
        }
        return yield* recordFailure(
          new CursorReplayFrameMismatchError({
            scenario: transcript.scenario,
            cursor,
            expected: { type: 'interaction.update | run.completed' },
            actual: frame,
          }),
        )
      }
    })

  return {
    listMessages: (nativeId) =>
      Effect.try({
        try: () => {
          assertOutbound({ type: 'agent.messages.list', agentId: nativeId })
          const frame = consumeInbound('agent.messages')
          if (frame.agentId !== nativeId) throw new Error('History identity mismatch')
          return frame.messages
        },
        catch: (cause) => replayRunnerError(transcript, cause, 'replay.agent.messages.list'),
      }),
    open: (input: CursorAgentSdk.CursorAgentSdkOpenInput) =>
      Effect.try({
        try: () => {
          assertOutbound({
            type: 'agent.open',
            operation: input.operation,
            ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
            options: CursorAgentSdk.loggedCursorAgentOptions(input.options),
          })
          const opened = consumeInbound('agent.opened')
          const session: CursorAgentSdk.CursorAgentSdkSession = {
            agentId: opened.agentId,
            send: (sendInput) =>
              Effect.try({
                try: () => {
                  assertOutbound({
                    type: 'run.start',
                    message: sendInput.message,
                    options: CursorAgentSdk.loggedCursorSendOptions(sendInput.options),
                  })
                  const started = consumeInbound('run.started')
                  const run: CursorAgentSdk.CursorAgentSdkRun = {
                    runId: started.runId,
                    agentId: started.agentId,
                    wait: waitForRun(started.runId, sendInput).pipe(
                      Effect.mapError((cause) => replayRunnerError(transcript, cause, 'replay.run.wait')),
                    ),
                    cancel: Effect.try({
                      try: () =>
                        assertOutbound({
                          type: 'run.cancel',
                          runId: started.runId,
                        }),
                      catch: (cause) => replayRunnerError(transcript, cause, 'replay.run.cancel'),
                    }),
                  }
                  return run
                },
                catch: (cause) => replayRunnerError(transcript, cause, 'replay.session.send'),
              }),
            listMessages: Effect.try({
              try: () => {
                assertOutbound({
                  type: 'agent.messages.list',
                  agentId: opened.agentId,
                })
                return consumeInbound('agent.messages').messages
              },
              catch: (cause) => replayRunnerError(transcript, cause, 'replay.agent.messages.list'),
            }),
            close: Effect.try({
              try: () =>
                assertOutbound({
                  type: 'agent.close',
                  agentId: opened.agentId,
                }),
              catch: (cause) => replayRunnerError(transcript, cause, 'replay.agent.close'),
            }),
          }
          return session
        },
        catch: (cause) => replayRunnerError(transcript, cause, 'replay.agent.open'),
      }),
    assertComplete: Effect.try({
      try: () => {
        if (failure !== null) {
          throw failure
        }
        if (cursor !== transcript.entries.length) {
          throw new CursorReplayIncompleteError({
            scenario: transcript.scenario,
            cursor,
            remaining: transcript.entries.length - cursor,
          })
        }
      },
      catch: (cause) => replayRunnerError(transcript, cause, 'replay.assertComplete'),
    }),
  }
}
