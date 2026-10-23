import { Duplex, Readable, Writable } from 'node:stream'
import { NodeSocket } from '@effect/platform-node'
import { Effect, Exit, Schedule, Scope, Stream } from 'effect'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { Socket } from 'effect/socket'
import type { WorkerOpenConfig } from '@baton/protocol'
import type {
  OwnedProcess,
  ProcessCommand,
  ProcessRecordCallbacks,
  ProcessWatchdog,
} from '../../platform/process-types.ts'
import { spawnOwnedProcessEffect } from '../../platform/process.ts'
import { AgentError } from '../../worker/agent.ts'
import type { AgentMessage, InputAcceptance, InputPreparation } from '../../worker/agent.ts'
import { CursorHostRpc, type HostEvent, type NativeMapping, type NativeMessage, type ProbeResult } from './protocol.ts'

export interface CursorHostConnection {
  readonly probe: Effect.Effect<ProbeResult, AgentError>
  readonly open: (
    config: WorkerOpenConfig,
    generation: string,
    mapping?: NativeMapping,
  ) => Effect.Effect<NativeMapping, AgentError>
  readonly send: (message: AgentMessage, preparation: InputPreparation) => Effect.Effect<InputAcceptance, AgentError>
  readonly history: (mapping: NativeMapping) => Effect.Effect<ReadonlyArray<NativeMessage>, AgentError>
  readonly events: Stream.Stream<HostEvent, AgentError>
  readonly abort: Effect.Effect<void, AgentError>
  readonly close: Effect.Effect<void, AgentError>
  /** Closes transport without claiming that execution has stopped. */
  readonly disconnect: Effect.Effect<void>
  readonly reap: Effect.Effect<{ readonly processTreeStopped: boolean }, AgentError>
  readonly exited: Effect.Effect<void, AgentError>
}

export interface CursorProcessOptions {
  /** batond invocation before the cursor-host subcommand. */
  readonly command: ProcessCommand
  readonly watchdog?: ProcessWatchdog
  readonly records?: ProcessRecordCallbacks
  readonly apiKey?: string
  /** Local diagnostics contain only error class/tag/code names, never SDK payloads. */
  readonly onDiagnostic?: (diagnostic: { readonly tags: ReadonlyArray<string> }) => void
}

/** Do not inherit unrelated provider credentials or Node injection flags. */
function hostEnvironment(apiKey: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of [
    'PATH',
    'HOME',
    'USERPROFILE',
    'SystemRoot',
    'COMSPEC',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  if (apiKey !== undefined) env.CURSOR_API_KEY = apiKey
  return env
}

export const connectCursorHost = (
  options: CursorProcessOptions,
  signal: AbortSignal,
): Effect.Effect<CursorHostConnection, AgentError> =>
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
        cause._tag === 'CursorHostError' &&
        'message' in cause &&
        typeof cause.message === 'string'
      )
        return new AgentError(cause.message, cause)
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
      return new AgentError(`Cursor host operation failed (${detail})`, cause)
    }
    const connected = Effect.gen(function* () {
      owned = yield* spawnOwnedProcessEffect(
        {
          ...options.command,
          args: [...(options.command.args ?? []), 'cursor-host'],
          env: hostEnvironment(options.apiKey),
        },
        { watchdog: options.watchdog, records: options.records, role: 'cursor-host', signal },
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
      const client = yield* RpcClient.make(CursorHostRpc).pipe(Effect.provideService(RpcClient.Protocol, protocol))
      const disconnect = Scope.close(scope, Exit.void)
      const call = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, AgentError> =>
        effect.pipe(
          Effect.timeout('32 seconds'),
          Effect.mapError(fail),
          Effect.tapError((error) =>
            Effect.sync(() => {
              channelFailure = error
            }),
          ),
          Effect.onError(() => disconnect),
        )
      const processHandle = owned
      return {
        probe: call(client.probe()),
        open: (config: WorkerOpenConfig, generation: string, mapping?: NativeMapping) =>
          call(client.open({ config, generation, ...(mapping ? { mapping } : {}) })),
        send: (message: AgentMessage, preparation: InputPreparation) => call(client.send({ message, preparation })),
        history: (mapping: NativeMapping) => call(client.history(mapping)),
        events: client.events().pipe(Stream.mapError((cause) => channelFailure ?? fail(cause))),
        abort: call(client.abort()),
        close: call(client.close()).pipe(Effect.ensuring(disconnect)),
        disconnect,
        reap: Effect.tryPromise({ try: () => processHandle.reap(), catch: fail }).pipe(
          Effect.map((result) => ({ processTreeStopped: result.reaped })),
        ),
        exited: Effect.tryPromise({ try: () => processHandle.exited.then(() => undefined), catch: fail }),
      } satisfies CursorHostConnection
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
