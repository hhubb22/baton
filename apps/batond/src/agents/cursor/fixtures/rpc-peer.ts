import { Effect } from 'effect'
import { RpcServer, RpcSerialization } from 'effect/rpc'
import { NodeStdio } from '@effect/platform-node'
import { runWatchdogCommand } from '../../../platform/process.ts'
import { makeCursorHostHandlers, type CursorHostDependencies } from '../host.ts'
import { CursorHostRpc } from '../protocol.ts'
import { CURSOR_AGENT_SDK_PROTOCOL, CURSOR_PROVIDER } from '@baton/providers/cursor'
import { nativeMessagesFromSdk } from '../history.ts'
import {
  makeCursorAgentSdkReplayRunner,
  type CursorAgentSdkReplayTranscript,
} from '../../../../../../packages/provider-testing/src/cursor.ts'

if (process.argv.at(-1) === 'watchdog') await runWatchdogCommand()
else {
  const transcript: CursorAgentSdkReplayTranscript = {
    provider: CURSOR_PROVIDER,
    protocol: CURSOR_AGENT_SDK_PROTOCOL,
    version: 'baton-local',
    scenario: 'stdio-cancel',
    entries: [
      {
        type: 'expect_outbound',
        frame: {
          type: 'agent.open',
          operation: 'create',
          options: {
            model: { id: 'default' },
            local: {
              hasCwd: true,
              autoReview: true,
              settingSources: [],
              sandboxEnabled: true,
              enableAgentRetries: false,
            },
          },
        },
      },
      { type: 'emit_inbound', frame: { type: 'agent.opened', agentId: 'native' } },
      { type: 'expect_outbound', frame: { type: 'run.start', message: 'hello', options: {} } },
      { type: 'emit_inbound', frame: { type: 'run.started', runId: 'run', agentId: 'native' } },
      {
        type: 'emit_inbound',
        frame: { type: 'interaction.update', runId: 'run', update: { type: 'text-delta', text: 'reply' } },
      },
      { type: 'expect_outbound', frame: { type: 'run.cancel', runId: 'run' } },
      { type: 'emit_inbound', frame: { type: 'run.completed', result: { id: 'run', status: 'cancelled' } } },
      { type: 'expect_outbound', frame: { type: 'agent.close', agentId: 'native' } },
    ],
  }
  const replay = makeCursorAgentSdkReplayRunner(transcript)
  let opened = false
  let submitted = false
  let readsAfterSubmission = 0
  const unused = async (): Promise<never> => {
    throw new Error('Unexpected fixture store operation')
  }
  const deps: CursorHostDependencies = {
    processGroup: { terminateChildren: Effect.void, waitQuiescent: () => Effect.void },
    runner: {
      ...replay,
      open: (input) =>
        replay.open(input).pipe(
          Effect.map((session) => {
            opened = true
            return {
              ...session,
              send: <Error>(input: Parameters<typeof session.send<Error>>[0]) =>
                session.send(input).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      submitted = true
                    }),
                  ),
                ),
            }
          }),
        ),
    },
    openStore: (native) =>
      Effect.succeed({
        agents: {
          get: async () => ({
            agentId: native.nativeSessionId,
            cwd: native.cwd,
            status: 'idle' as const,
            createdAt: 0,
            updatedAt: 0,
          }),
          create: unused,
          update: unused,
          delete: unused,
          list: unused,
        },
        checkpoints: { get: unused, create: unused, update: unused, delete: unused, list: unused },
        runs: { get: unused, create: unused, update: unused, delete: unused, list: unused },
        runEvents: { append: unused, list: unused, delete: unused },
        dispose: async () => {},
      }),
    history: (native) =>
      Effect.gen(function* () {
        // Native persistence becomes visible after the handle. Each query replays the SDK read API.
        const messages =
          submitted && readsAfterSubmission++ >= 2
            ? [
                {
                  uuid: 'user',
                  agent_id: 'native',
                  type: 'user' as const,
                  message: {
                    agentConversationTurn: {
                      userMessage: { text: 'hello' },
                      steps: [{ thinkingMessage: { text: 'ignored' } }, { assistantMessage: { text: 'reply' } }],
                    },
                  },
                },
              ]
            : []
        const reader = makeCursorAgentSdkReplayRunner({
          ...transcript,
          scenario: 'independent-read',
          entries: [
            { type: 'expect_outbound', frame: { type: 'agent.messages.list', agentId: native.nativeSessionId } },
            { type: 'emit_inbound', frame: { type: 'agent.messages', agentId: native.nativeSessionId, messages } },
          ],
        })
        const history = yield* reader.listMessages(native.nativeSessionId, { cwd: native.cwd })
        yield* reader.assertComplete
        return nativeMessagesFromSdk(history)
      })
        .pipe(Effect.mapError(() => new Error('SDK history replay failed')))
        .pipe(Effect.orDie),
    probe: Effect.succeed({
      authenticated: 'unknown',
      models: [],
      sdkVersion: 'fixture',
      platform: 'fixture',
      integrity: true,
      sandboxHelper: true,
    }),
  }
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => (opened ? replay.assertComplete.pipe(Effect.orDie) : Effect.void))
        const handlers = yield* makeCursorHostHandlers(deps)
        yield* RpcServer.make(CursorHostRpc).pipe(
          Effect.provide(CursorHostRpc.toLayer(handlers)),
          Effect.provide(RpcServer.layerProtocolStdio),
          Effect.provide(RpcSerialization.layerNdjson),
          Effect.provide(NodeStdio.layer),
        )
      }),
    ),
  )
}
