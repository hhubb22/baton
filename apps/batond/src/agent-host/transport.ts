import { Duplex, Readable, Writable } from 'node:stream'
import { NodeSocket } from '@effect/platform-node'
import { Effect, Exit, Schedule, Scope, Stream } from 'effect'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { Socket } from 'effect/socket'
import type { ThreadAnswerInput, WorkerOpenConfig } from '@baton/protocol'
import type {
  OwnedProcess,
  ProcessCommand,
  ProcessRecordCallbacks,
  ProcessWatchdog,
} from '../platform/process-types.ts'
import { spawnOwnedProcessEffect } from '../platform/process.ts'
import { AgentError } from '../worker/agent.ts'
import type { AgentMessage } from '../worker/agent.ts'
import { agentEnvironment } from './environment.ts'
import type { AgentHostPaths } from './paths.ts'
import type { Preparation } from './protocol.ts'
import { AgentHostRpc, type Acceptance, type HostEvent, type ProbeResult, type SessionIdentity } from './protocol.ts'

export interface AgentHostConnection {
  readonly probe: Effect.Effect<ProbeResult, AgentError>
  readonly open: (config: WorkerOpenConfig, generation: string) => Effect.Effect<SessionIdentity, AgentError>
  readonly resume: (
    config: WorkerOpenConfig,
    generation: string,
    nativeSessionId: string,
  ) => Effect.Effect<SessionIdentity, AgentError>
  readonly send: (message: AgentMessage, preparation: Preparation) => Effect.Effect<Acceptance, AgentError>
  readonly sent: (
    config: WorkerOpenConfig,
    message: AgentMessage,
    preparation: Preparation,
  ) => Effect.Effect<Acceptance | undefined, AgentError>
  readonly answer?: (answer: ThreadAnswerInput) => Effect.Effect<void, AgentError>
  readonly events: Stream.Stream<HostEvent, AgentError>
  readonly abort: Effect.Effect<void, AgentError>
  readonly close: Effect.Effect<void, AgentError>
  /** Closes transport without claiming that execution has stopped. */
  readonly disconnect: Effect.Effect<void>
  readonly reap: Effect.Effect<{ readonly processTreeStopped: boolean }, AgentError>
  readonly exited: Effect.Effect<void, AgentError>
}

export interface AgentHostProcessOptions {
  /** batond invocation before the agent-host subcommand. */
  readonly command: ProcessCommand
  readonly agentType: string
  readonly paths: AgentHostPaths
  readonly watchdog?: ProcessWatchdog
  readonly records?: ProcessRecordCallbacks
  /** Local diagnostics contain only error class/tag/code names, never SDK payloads. */
  readonly onDiagnostic?: (diagnostic: { readonly tags: ReadonlyArray<string> }) => void
}

const agentHostArguments = (agentType: string, paths: AgentHostPaths): string[] => [
  'agent-host',
  agentType,
  '--cwd',
  paths.workingDirectory,
  '--state',
  paths.privateDirectory,
]

export const connectAgentHost = (
  options: AgentHostProcessOptions,
  signal: AbortSignal,
): Effect.Effect<AgentHostConnection, AgentError> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    let owned: OwnedProcess | undefined
    let channelFailure: AgentError | undefined
    const fail = (cause: unknown) => {
      const tags = new Set<string>()
      const seen = new Set<object>()
      const visit = (value: unknown, depth: number): void => {
        if (!value || typeof value !== 'object' || depth > 6 || seen.has(value)) return
        seen.add(value)
        for (const key of ['_tag', 'name', 'code']) {
          const tag: unknown = Reflect.get(value, key)
          if (typeof tag === 'string' && /^[A-Za-z0-9_/-]{1,80}$/.test(tag)) tags.add(tag)
        }
        for (const key of ['reason', 'cause', 'error', 'defect', 'reasons']) {
          const nested: unknown = Reflect.get(value, key)
          if (Array.isArray(nested)) nested.forEach((entry) => visit(entry, depth + 1))
          else visit(nested, depth + 1)
        }
      }
      visit(cause, 0)
      options.onDiagnostic?.({ tags: [...tags] })
      if (
        cause &&
        typeof cause === 'object' &&
        '_tag' in cause &&
        cause._tag === 'AgentHostError' &&
        'message' in cause &&
        typeof cause.message === 'string'
      )
        return new AgentError(cause.message, cause, 'modelRejected' in cause && cause.modelRejected === true)
      const detail =
        cause && typeof cause === 'object' && '_tag' in cause && cause._tag === 'TimeoutError'
          ? 'RPC timeout after 32 seconds'
          : cause &&
              typeof cause === 'object' &&
              '_tag' in cause &&
              cause._tag === 'RpcClientError' &&
              'reason' in cause &&
              cause.reason &&
              typeof cause.reason === 'object' &&
              '_tag' in cause.reason
            ? String(cause.reason._tag)
            : 'transport failure'
      return new AgentError(`Agent host operation failed (${detail})`, cause)
    }
    const connected = Effect.gen(function* () {
      owned = yield* spawnOwnedProcessEffect(
        {
          ...options.command,
          args: [...(options.command.args ?? []), ...agentHostArguments(options.agentType, options.paths)],
          env: agentEnvironment(options.agentType),
          cwd: options.paths.workingDirectory,
        },
        {
          watchdog: options.watchdog,
          records: options.records,
          role: `${options.agentType}-host`,
          signal,
        },
      ).pipe(Effect.mapError(fail))
      // Drain SDK diagnostics without forwarding credentials or unbounded output.
      owned.stderr.resume()
      const duplex = Duplex.from({ readable: Readable.toWeb(owned.stdout), writable: Writable.toWeb(owned.stdin) })
      // Node's web stream adapter emits a final AbortError when its socket scope closes.
      // Keep an error listener through destruction; Socket.run still reports protocol failures.
      duplex.on('error', () => {})
      const socket = yield* NodeSocket.fromDuplex(Effect.succeed(duplex))
      const protocol = yield* RpcClient.makeProtocolSocket({
        retryPolicy: Schedule.recurs(0),
        retryTransientErrors: false,
      }).pipe(Effect.provideService(Socket.Socket, socket), Effect.provide(RpcSerialization.layerNdjson))
      const client = yield* RpcClient.make(AgentHostRpc).pipe(Effect.provideService(RpcClient.Protocol, protocol))
      const disconnect = Scope.close(scope, Exit.void)
      // The owner closes this scope after an RPC error; closing it from a client fiber can await that same fiber.
      const call = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, AgentError> =>
        effect.pipe(
          Effect.timeout('32 seconds'),
          Effect.mapError(fail),
          Effect.tapError((error) =>
            Effect.sync(() => {
              channelFailure = error
            }),
          ),
        )
      const processHandle = owned
      return {
        probe: call(client.probe()),
        open: (config: WorkerOpenConfig, generation: string) => call(client.open({ config, generation })),
        resume: (config: WorkerOpenConfig, generation: string, nativeSessionId: string) =>
          call(client.resume({ config, generation, nativeSessionId })),
        answer: (answer: ThreadAnswerInput) => call(client.answer({ answer })),
        send: (message: AgentMessage, preparation: Preparation) => call(client.send({ message, preparation })),
        sent: (config: WorkerOpenConfig, message: AgentMessage, preparation: Preparation) =>
          call(client.sent({ config, message, preparation })).pipe(Effect.map((value) => value ?? undefined)),
        events: client.events().pipe(Stream.mapError((cause) => channelFailure ?? fail(cause))),
        abort: call(client.abort()),
        close: call(client.close()).pipe(Effect.ensuring(disconnect)),
        disconnect,
        reap: Effect.tryPromise({ try: () => processHandle.reap(), catch: fail }).pipe(
          Effect.map((result) => ({ processTreeStopped: result.reaped })),
        ),
        exited: Effect.tryPromise({ try: () => processHandle.exited.then(() => undefined), catch: fail }),
      } satisfies AgentHostConnection
    }).pipe(Scope.provide(scope))
    return yield* connected.pipe(
      Effect.onError(() =>
        Effect.gen(function* () {
          yield* Scope.close(scope, Exit.void)
          if (owned) yield* Effect.tryPromise({ try: () => owned!.reap(), catch: fail }).pipe(Effect.ignore)
        }),
      ),
    )
  })
