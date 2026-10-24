import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Layer, Schema } from 'effect'
import { Crypto } from 'effect/Crypto'
import { FileSystem } from 'effect/FileSystem'
import * as ChildProcess from 'effect/process/ChildProcess'
import * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner'
import * as CodexClient from 'effect-codex-app-server/client'
import type { ModelSelection } from '@t3tools/contracts'
import { ModelSelection as ModelSelectionSchema } from '@t3tools/contracts'
import { CodexSettings } from '@t3tools/contracts/settings'
import type { WorkerOpenConfig } from '@baton/protocol'
import * as ProviderAdapter from '@t3tools/provider-core/server/ProviderAdapter'
import { expandHomePath } from '@t3tools/provider-core/server/pathExpansion'
import * as IdAllocator from '@t3tools/provider-core/server/IdAllocator'
import { NoOpProviderEventLoggers, ProviderEventLoggers } from '@t3tools/provider-core/server/ProviderEventLoggers'
import {
  CODEX_DEFAULT_INSTANCE_ID,
  CodexAppServerClientFactory,
  layerAppServerClientFactory,
  makeCodexAdapterV2,
} from '@t3tools/provider-codex/server'
import { buildCodexInitializeParams, codexAppServerEnvironment } from '@t3tools/provider-codex/server/codexSession'
import { codexAppServerArgs, resolveCodexLaunchArgs } from '@t3tools/provider-codex/server/codexLaunchArgs'
import { resolveSpawnCommand } from '@t3tools/shared/shell'
import * as HostProcess from '@t3tools/shared/HostProcess'
import { makeProviderHostDriver } from '../../agent-host/driver.ts'
import type { AgentHostPaths } from '../../agent-host/host-layer.ts'
import { AgentHostDriver, AgentHostError, type ProbeResult } from '../../agent-host/protocol.ts'

const settingsFor = () =>
  Schema.decodeSync(CodexSettings)({
    enabled: true,
    binaryPath: 'codex',
    homePath: process.env.CODEX_HOME?.trim() || '',
  })

const runtimePolicy = (cwd: string): ProviderAdapter.ProviderAdapterV2RuntimePolicy => ({
  // The mode selects the user reviewer. Approval and sandbox are explicit.
  runtimeMode: 'approval-required',
  interactionMode: 'default',
  cwd,
  approvalPolicy: 'never',
  sandboxPolicy: { type: 'workspaceWrite', networkAccess: false, writableRoots: [] },
})

const modelSelection = (config: WorkerOpenConfig): ModelSelection =>
  Schema.decodeSync(ModelSelectionSchema)({
    instanceId: CODEX_DEFAULT_INSTANCE_ID,
    model: config.model ?? config.adapter_config.model ?? 'gpt-6-luna',
  })

const versionOf = (userAgent: string | undefined) => /\/([^\s]+)/.exec(userAgent ?? '')?.[1] ?? 'unknown'

/**
 * Spawn Codex app-server the way the upstream provider probe does, then read
 * the account and one page of models. No prompt and no login browser.
 */
export const codexProbe = Effect.scoped(
  Effect.gen(function* () {
    const settings = settingsFor()
    const temporary = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), 'baton-codex-probe-'))),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
    )
    const cwd = yield* Effect.tryPromise({
      try: () => realpath(temporary),
      catch: () => new AgentHostError({ message: 'Codex probe workspace is not accessible' }),
    })
    const home = settings.homePath ? expandHomePath(settings.homePath, yield* HostProcess.HomeDirectory) : undefined
    const environment = { ...codexAppServerEnvironment(process.env), ...(home ? { CODEX_HOME: home } : {}) }
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const spawnCommand = yield* resolveSpawnCommand(
      settings.binaryPath || 'codex',
      codexAppServerArgs(resolveCodexLaunchArgs(settings.launchArgs, process.env)),
      { env: environment, extendEnv: true },
    ).pipe(Effect.mapError(() => new AgentHostError({ message: 'Codex binary could not be resolved' })))
    const child = yield* spawner
      .spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd,
          env: environment,
          extendEnv: true,
          shell: spawnCommand.shell,
        }),
      )
      .pipe(Effect.mapError(() => new AgentHostError({ message: 'Codex CLI is not installed or not on PATH' })))
    const clientContext = yield* Layer.build(CodexClient.layerChildProcess(child)).pipe(
      Effect.mapError(() => new AgentHostError({ message: 'Codex app-server client could not be started' })),
    )
    const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(Effect.provide(clientContext))
    const initialize = yield* client.request('initialize', buildCodexInitializeParams()).pipe(
      Effect.timeout('15 seconds'),
      Effect.mapError(() => new AgentHostError({ message: 'Codex initialize did not complete' })),
    )
    yield* client.notify('initialized', undefined).pipe(Effect.ignore)
    const account = yield* client.request('account/read', {}).pipe(
      Effect.timeout('15 seconds'),
      Effect.mapError(() => new AgentHostError({ message: 'Codex account check did not complete' })),
    )
    const details = {
      version: versionOf(initialize.userAgent),
      platform: `${process.platform}-${process.arch}`,
      installed: true,
    }
    if (!account.account) {
      const unauthenticated: ProbeResult = {
        authenticated: account.requiresOpenaiAuth ? 'missing' : 'unknown',
        models: [],
        reason: account.requiresOpenaiAuth
          ? 'Codex CLI is not authenticated'
          : 'Codex authentication could not be verified',
        details,
      }
      return unauthenticated
    }
    const listed = yield* client.request('model/list', {}).pipe(Effect.timeout('15 seconds'), Effect.option)
    if (listed._tag === 'None') {
      const unread: ProbeResult = {
        authenticated: 'valid',
        models: [],
        reason: 'Codex model catalog could not be read',
        details,
      }
      return unread
    }
    const ready: ProbeResult = {
      authenticated: 'valid',
      models: listed.value.data.map((model) => model.model),
      details,
    }
    return ready
  }),
)

export const codexHostDriver = (input: {
  readonly agentType: string
  readonly paths: AgentHostPaths
  readonly sessionTitle?: string
}) =>
  Layer.effect(
    AgentHostDriver,
    Effect.gen(function* () {
      if (input.agentType !== 'codex')
        return yield* new AgentHostError({ message: 'Codex host driver requires agent type codex' })
      const clientFactory = yield* CodexAppServerClientFactory
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const probe: Effect.Effect<ProbeResult, AgentHostError> = codexProbe.pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      )
      const crypto = yield* Crypto
      const fileSystem = yield* FileSystem
      const idAllocator = yield* IdAllocator.IdAllocatorV2
      const adapter = yield* makeCodexAdapterV2({
        instanceId: CODEX_DEFAULT_INSTANCE_ID,
        settings: settingsFor(),
        environment: process.env,
        clientFactory,
        crypto,
        fileSystem,
        idAllocator,
        serverConfig: { attachmentsDir: join(input.paths.privateDirectory, 'attachments') },
      }).pipe(Effect.mapError((cause) => new AgentHostError({ message: `Codex adapter failed (${String(cause)})` })))
      return yield* makeProviderHostDriver({
        label: 'Codex',
        instanceId: CODEX_DEFAULT_INSTANCE_ID,
        adapter,
        steer: true,
        runtimeMode: 'approval-required',
        interactionMode: 'default',
        runtimePolicy,
        model: modelSelection,
        probe,
        ...(input.sessionTitle ? { sessionTitle: input.sessionTitle } : {}),
      })
    }),
  )

export const codexDriverLayer = (input: {
  readonly agentType: string
  readonly paths: AgentHostPaths
  readonly sessionTitle?: string
}) =>
  codexHostDriver(input).pipe(
    Layer.provide(layerAppServerClientFactory),
    Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  )
