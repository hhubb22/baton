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

import type { AgentHostPaths } from './paths.ts'

/**
 * 命令直接在 host 中执行。adapter/spawner 的 Scope 释放各自资源，
 * 独立进程组由 registrar/watchdog 管理，Worker 负责外层进程树回收。
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
const registeredSpawner = (registrar: ProcessRegistrar, spawner?: Layer.Layer<ChildProcessSpawner>) =>
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
  ).pipe(Layer.provide(spawner ?? childProcessSpawnerLayer), Layer.provide(fileSystemLayer), Layer.provide(pathLayer))

export interface AgentHostLayerOptions {
  readonly paths: AgentHostPaths
  readonly registrar: ProcessRegistrar
  /** Replaces the Node spawner. Replay hosts pass an upstream testkit spawner. */
  readonly spawner?: Layer.Layer<ChildProcessSpawner>
}

/**
 * Effect services an upstream `ProviderAdapterV2` may require inside the host.
 * Every host owns one Agent session, so layers are built per process.
 */
export const agentHostLayer = (options: AgentHostLayerOptions) =>
  Layer.mergeAll(
    registeredSpawner(options.registrar, options.spawner),
    hostAgentScope,
    providerHost(options.paths),
    McpProviderSessions.layer,
    IdAllocator.layer,
    fileSystemLayer,
    pathLayer,
    cryptoLayer,
  )

export type AgentHostEnvironment = Layer.Success<ReturnType<typeof agentHostLayer>> | AgentHostProcessGroup
