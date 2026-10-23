import type { AgentOptions, SendOptions } from '@cursor/sdk'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Deferred from 'effect/Deferred'
import * as Schema from 'effect/Schema'
import { vi } from 'vitest'
import {
  makeCursorAgentSdkRunner,
  ThreadId,
  ProviderSessionId,
  type CursorAgentSdkSession,
  type CursorAgentSdkRun,
  type CursorAgentSdkProtocolLogEvent,
} from '@baton/providers/cursor'
import { layer } from '@baton/providers/cursor/sdk'
import { makeCursorAgentSdkReplayRunner } from './cursor.ts'
import { readCursorAgentSdkReplayTranscript } from './cursor-fixtures.ts'

let replay: ReturnType<typeof makeCursorAgentSdkReplayRunner>
const identity = {
  threadId: ThreadId.make('replay-thread'),
  providerSessionId: ProviderSessionId.make('replay-session'),
}

// Only the native SDK is replaced; the production runner handles callbacks and lifecycle.
vi.mock('@baton/providers/cursor/sdk-loader', () => {
  const open = async (operation: 'create' | 'resume', options: AgentOptions, agentId?: string) => {
    const session = await Effect.runPromise(
      replay.open({ operation, options, ...identity, ...(agentId === undefined ? {} : { agentId }) }),
    )
    return {
      agentId: session.agentId,
      send: async (message: string, input: SendOptions = {}) => {
        const { onDelta, ...options } = input
        const run = await Effect.runPromise(
          session.send({
            message,
            options,
            onDelta: (update) =>
              Effect.promise(async () => {
                await onDelta?.({ update })
              }),
          }),
        )
        return {
          id: run.runId,
          agentId: run.agentId,
          wait: () => Effect.runPromise(run.wait),
          cancel: () => Effect.runPromise(run.cancel),
        }
      },
      close: () => Effect.runSync(session.close),
    }
  }
  return {
    Agent: {
      create: (options: AgentOptions) => open('create', options),
      resume: (id: string, options: AgentOptions) => open('resume', options, id),
      messages: { list: (id: string, options: { cwd: string }) => Effect.runPromise(replay.listMessages(id, options)) },
    },
    createAgentPlatform: async () => ({ prewarmLocalWorkspace: async () => async () => {} }),
    SqliteLocalAgentStore: {},
  }
})

const Outbound = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('agent.open'),
    operation: Schema.Literals(['create', 'resume']),
    agentId: Schema.optional(Schema.String),
    options: Schema.Struct({
      model: Schema.Struct({ id: Schema.String }),
      hasName: Schema.Boolean,
      mode: Schema.Literal('agent'),
      local: Schema.Struct({
        hasCwd: Schema.Boolean,
        autoReview: Schema.Boolean,
        settingSources: Schema.Array(Schema.Literals(['project', 'user', 'team', 'mdm', 'plugins'])),
        sandboxEnabled: Schema.Boolean,
        enableAgentRetries: Schema.Boolean,
      }),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal('run.start'),
    message: Schema.String,
    options: Schema.Struct({ model: Schema.Struct({ id: Schema.String }), mode: Schema.Literal('agent') }),
  }),
  Schema.Struct({ type: Schema.Literal('run.cancel'), runId: Schema.String }),
  Schema.Struct({ type: Schema.Literal('agent.close'), agentId: Schema.String }),
])

it.effect.each([
  'simple',
  'multi_turn',
  'provider_thread_resume',
  'turn_interrupt_mid_tool',
  'tool_call_read_only',
  'subagent',
])('replays original %s SDK deltas through the production runner', (name) =>
  Effect.gen(function* () {
    const transcript = yield* readCursorAgentSdkReplayTranscript(
      new URL(`../test/fixtures/${name}.ndjson`, import.meta.url),
    )
    replay = makeCursorAgentSdkReplayRunner(transcript)
    const observed: Array<CursorAgentSdkProtocolLogEvent> = []
    const runner = yield* makeCursorAgentSdkRunner(
      () => (event) =>
        Effect.sync(() => {
          observed.push(event)
        }),
    )
    let session: CursorAgentSdkSession | undefined
    let run: CursorAgentSdkRun | undefined
    let waiting: Fiber.Fiber<unknown, unknown> | undefined
    const toolStarted = yield* Deferred.make<void>()
    const joinRun = () =>
      Effect.gen(function* () {
        if (!waiting) return
        const result = yield* Fiber.join(waiting).pipe(Effect.result)
        if (result._tag === 'Failure')
          assert.isTrue(
            transcript.entries.some((entry) => entry.type === 'runtime_exit' && entry.status === 'cancelled'),
          )
        waiting = undefined
      })
    for (const entry of transcript.entries) {
      if (entry.type !== 'expect_outbound') continue
      const frame = yield* Schema.decodeUnknownEffect(Outbound)(entry.frame)
      switch (frame.type) {
        case 'agent.open':
          session = yield* runner.open({
            ...identity,
            operation: frame.operation,
            ...(frame.agentId === undefined ? {} : { agentId: frame.agentId }),
            options: {
              model: frame.options.model,
              name: 'fixture',
              mode: frame.options.mode,
              local: {
                cwd: '/offline-replay',
                autoReview: frame.options.local.autoReview,
                settingSources: [...frame.options.local.settingSources],
                sandboxOptions: { enabled: frame.options.local.sandboxEnabled },
                enableAgentRetries: frame.options.local.enableAgentRetries,
              },
            },
          })
          break
        case 'run.start':
          yield* joinRun()
          if (!session) throw new Error('Missing replay session')
          run = yield* session.send({
            message: frame.message,
            options: frame.options,
            onDelta: (update) =>
              update.type === 'tool-call-started'
                ? Deferred.succeed(toolStarted, undefined).pipe(Effect.asVoid)
                : Effect.void,
          })
          waiting = yield* run.wait.pipe(Effect.forkChild({ startImmediately: true }))
          break
        case 'run.cancel':
          if (!run || run.runId !== frame.runId) throw new Error('Missing replay run')
          yield* Deferred.await(toolStarted)
          yield* run.cancel
          break
        case 'agent.close':
          yield* joinRun()
          if (!session || session.agentId !== frame.agentId) throw new Error('Missing replay session')
          yield* session.close
          break
      }
    }
    yield* replay.assertComplete
    assert.deepStrictEqual(
      observed.map((event) => ({ direction: event.direction, frame: event.payload })),
      transcript.entries.flatMap((entry) =>
        entry.type === 'runtime_exit'
          ? []
          : [{ direction: entry.type === 'expect_outbound' ? 'outgoing' : 'incoming', frame: entry.frame }],
      ),
    )
  }).pipe(Effect.provide(layer)),
)
