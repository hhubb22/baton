import { layer as childProcessSpawnerLayer } from '@effect/platform-node/NodeChildProcessSpawner'
import { layer as cryptoLayer } from '@effect/platform-node/NodeCrypto'
import { layer as fileSystemLayer } from '@effect/platform-node/NodeFileSystem'
import { layer as pathLayer } from '@effect/platform-node/NodePath'
import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from '@t3tools/contracts'
import * as IdAllocator from '@t3tools/provider-core/server/IdAllocator'
import * as McpProviderSessions from '@t3tools/provider-core/server/McpProviderSessions'
import * as ProviderHost from '@t3tools/provider-core/server/ProviderHost'
import { ProviderCredentialError } from '@t3tools/provider-core/server/errors'
import { AgentScope } from '@t3tools/shared/AgentScope'
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'
import { Effect, Layer, Option, Stream } from 'effect'
import { join } from 'node:path'
import type { AgentHostProcessGroup } from './protocol.ts'
import type { ProcessRegistrar } from './process-registrar.ts'

export interface AgentHostPaths {
  /** Thread working directory, the Agent's `cwd`. */
  readonly workingDirectory: string
  /** Private per-Thread directory holding the native mapping and SDK state. */
  readonly privateDirectory: string
}

/**
 * Host execution scope. The Agent host process already leads the group that
 * contains every child it starts, and its Scope kills that group on exit, so
 * `wrap` never needs a systemd unit and `stop` has nothing of its own to clean.
 */
const hostAgentScope = Layer.succeed(
  AgentScope,
  AgentScope.of({
    wrap: ({ command, args }) => Effect.succeed({ command, args }),
    oomKilled: () => Effect.succeed(false),
    stop: () => Effect.void,
    clear: () => Effect.void,
  }),
)

const settings: ServerSettings = DEFAULT_SERVER_SETTINGS

const providerHost = (paths: AgentHostPaths) =>
  Layer.succeed(
    ProviderHost.ProviderHost,
    ProviderHost.ProviderHost.of({
      paths: {
        cwd: paths.workingDirectory,
        baseDir: paths.privateDirectory,
        stateDir: paths.privateDirectory,
        providerStatusCacheDir: join(paths.privateDirectory, 'cache'),
        attachmentsDir: join(paths.privateDirectory, 'attachments'),
      },
      settings: {
        get: Effect.succeed(settings),
        withSnapshot: (use) => use(settings),
        changes: Stream.empty,
        subscribe: Effect.succeed(Stream.empty),
      },
      shouldRunBackgroundWork: () => Effect.succeed(false),
      // Baton does not forward chat attachments to Agents yet.
      resolveAttachmentPath: () => null,
      credentials: (namespace, bindingId) =>
        Effect.succeed({
          binding: { owner: 't3' as const, key: `${namespace}:${bindingId}` },
          get: Effect.succeed(Option.none()),
          set: () =>
            Effect.fail(
              new ProviderCredentialError({
                operation: 'set',
                cause: 'Baton Agent hosts read credentials from the device environment',
              }),
            ),
          remove: Effect.fail(
            new ProviderCredentialError({
              operation: 'remove',
              cause: 'Baton Agent hosts read credentials from the device environment',
            }),
          ),
        }),
    }),
  )

/** Register upstream-created process groups before the adapter can use them. */
const registeredSpawner = (registrar: ProcessRegistrar) =>
  Layer.effect(
    ChildProcessSpawner,
    Effect.gen(function* () {
      const inner = yield* ChildProcessSpawner
      return ChildProcessSpawner.of({
        ...inner,
        spawn: (command) =>
          Effect.gen(function* () {
            const handle = yield* inner.spawn(command)
            const pid = Number(handle.pid)
            const separate = yield* registrar.register(pid).pipe(Effect.catch((error) => Effect.die(error)))
            if (separate) yield* Effect.addFinalizer(() => registrar.release(pid).pipe(Effect.ignore))
            return handle
          }),
      })
    }),
  ).pipe(Layer.provide(childProcessSpawnerLayer), Layer.provide(fileSystemLayer), Layer.provide(pathLayer))

export interface AgentHostLayerOptions {
  readonly paths: AgentHostPaths
  readonly registrar: ProcessRegistrar
}

/**
 * Effect services an upstream `ProviderAdapterV2` may require inside the host.
 * Every host owns one Agent session, so layers are built per process.
 */
export const agentHostLayer = (options: AgentHostLayerOptions) =>
  Layer.mergeAll(
    registeredSpawner(options.registrar),
    hostAgentScope,
    providerHost(options.paths),
    McpProviderSessions.layer,
    IdAllocator.layer,
    fileSystemLayer,
    pathLayer,
    cryptoLayer,
  )

export type AgentHostEnvironment = Layer.Success<ReturnType<typeof agentHostLayer>> | AgentHostProcessGroup
