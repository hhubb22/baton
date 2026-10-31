import { Effect, Layer, Schema } from 'effect'
import { Crypto } from 'effect/Crypto'
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'
import type { ModelSelection, OrchestrationV2ProviderFailure } from '@t3tools/contracts'
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ModelSelection as ModelSelectionSchema,
  ProviderInstanceId,
} from '@t3tools/contracts'
import type { WorkerOpenConfig } from '@baton/protocol'
import * as AcpSessionRuntime from '@t3tools/provider-acp/server/AcpSessionRuntime'
import {
  makeAntigravityAdapterV2,
  type AntigravityAdapterRuntimeInput,
} from '@t3tools/provider-antigravity/server/AntigravityAdapterV2'
import { normalizeAntigravitySessionUpdate } from '@t3tools/provider-antigravity/server/AntigravityProtocol'
import { NoOpProviderEventLoggers, ProviderEventLoggers } from '@t3tools/provider-core/server/ProviderEventLoggers'
import { resolveSelfInvocation } from '@t3tools/shared/nodeRuntime'
import { makeProviderHostDriver } from '../../agent-host/driver.ts'
import type { AgentHostPaths } from '../../agent-host/paths.ts'
import { AgentHostDriver, AgentHostError, type ProbeResult } from '../../agent-host/protocol.ts'
import { kiroVersion, type KiroVersionResult } from '../kiro/version.ts'

const instanceId = ProviderInstanceId.make('antigravity')
const clientInfo = { name: 'baton', version: '0.0.0' }

const modelSelection = (config: WorkerOpenConfig): ModelSelection =>
  Schema.decodeSync(ModelSelectionSchema)({
    instanceId,
    model: config.model ?? config.adapter_config.model ?? ANTIGRAVITY_DEFAULT_MODEL,
  })

/** ACP code -32000 also covers ordinary agent errors, so only the message decides. */
const isAuthenticationFailure = (message: string) =>
  /\b(?:authentication (?:required|failed)|not authenticated|unauthenticated|not logged in|not signed in|sign[- ]in required)\b/iu.test(
    message,
  )

export const antigravityTurnFailure = (failure: OrchestrationV2ProviderFailure): string =>
  isAuthenticationFailure(failure.message)
    ? 'Sign in to the Antigravity CLI and try again.'
    : 'Check the Antigravity CLI on this device and try again.'

/** Uses the sign-in already stored by `agy`; the session never starts a browser flow of its own. */
const nativeRuntime = (
  input: Pick<
    AntigravityAdapterRuntimeInput,
    'cwd' | 'clientFileSystem' | 'additionalDirectories' | 'mcpServers' | 'processEnvironment'
  > &
    Partial<AntigravityAdapterRuntimeInput>,
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        clientInfo: input.clientInfo ?? clientInfo,
        protocolLogging: input.protocolLogging ?? {},
        spawn: {
          command: 'agy',
          args: ['acp'],
          cwd: input.cwd,
          ...(input.processEnvironment ? { env: input.processEnvironment } : {}),
        },
        authenticateOnAuthRequired: false,
        resumeMethod: 'resume',
        cancelBehavior: 'wait-for-prompt',
        clientCapabilities: {
          fs: { readTextFile: input.clientFileSystem, writeTextFile: input.clientFileSystem },
          terminal: false,
        },
        transformSessionUpdate: normalizeAntigravitySessionUpdate,
      }),
    )
    const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context))
    return {
      ...runtime,
      // Native `agy acp` reports no modes and rejects `session/set_mode`; each tool call asks
      // through `session/request_permission`, which the client answers from the runtime mode.
      setMode: (modeId: string) =>
        runtime.getModeState.pipe(
          Effect.flatMap((modes) => (modes === undefined ? Effect.succeed({}) : runtime.setMode(modeId))),
        ),
    }
  })

interface Discovery {
  readonly authenticated: ProbeResult['authenticated']
  readonly models: readonly string[]
  readonly thinking?: NonNullable<ProbeResult['model_thinking']>[number]['thinking']
}

/** Reads models from an empty discovery session; no prompt is sent. */
const discover = (paths: AgentHostPaths): Effect.Effect<Discovery, never, ChildProcessSpawner | Crypto> =>
  Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* nativeRuntime({
        cwd: paths.workingDirectory,
        mcpServers: [],
        clientFileSystem: false,
        additionalDirectories: [],
      })
      yield* runtime.start()
      const options = yield* runtime.getConfigOptions
      const select = (id: string) => {
        const option = options.find((candidate) => candidate.id === id)
        if (option?.type !== 'select') return undefined
        return {
          current: option.currentValue,
          values: option.options.flatMap((entry) => ('value' in entry ? [entry] : entry.options)),
        }
      }
      const model = select('model')
      const level = select('thought_level')
      const discovery: Discovery = {
        authenticated: 'valid',
        models: [
          ...(model?.values ?? []).filter((entry) => entry.value === model?.current),
          ...(model?.values ?? []).filter((entry) => entry.value !== model?.current),
        ].map((entry) => entry.value),
        ...(level
          ? {
              thinking: {
                id: 'thought_level',
                options: level.values.map((entry) => ({
                  id: entry.value,
                  label: entry.name,
                  is_default: entry.value === level.current,
                })),
                current_value: level.current,
              },
            }
          : {}),
      }
      return discovery
    }),
  ).pipe(
    Effect.timeout('20 seconds'),
    Effect.catch((cause) =>
      Effect.succeed<Discovery>({
        authenticated: isAuthenticationFailure(cause instanceof Error ? cause.message : '') ? 'missing' : 'unknown',
        models: [],
      }),
    ),
  )

const probeFor = (paths: AgentHostPaths, versionProbe = kiroVersion({ cwd: paths.workingDirectory, binary: 'agy' })) =>
  Effect.gen(function* () {
    const [version, discovery] = yield* Effect.all([versionProbe, discover(paths)], { concurrency: 'unbounded' })
    const installed = version.state !== 'missing'
    const reason = !installed
      ? 'Antigravity CLI 未安装或不可执行'
      : discovery.authenticated === 'missing'
        ? 'Antigravity CLI 尚未登录'
        : version.state === 'timeout'
          ? 'Antigravity 版本探测超时'
          : version.state !== 'ready'
            ? 'Antigravity 版本暂不可确认'
            : discovery.authenticated === 'unknown'
              ? 'Antigravity 登录状态未知，首次执行时由原生程序检查'
              : discovery.models.length === 0
                ? 'Antigravity 模型目录暂不可读，可使用默认模型'
                : undefined
    const { thinking } = discovery
    const result: ProbeResult = {
      authenticated: discovery.authenticated,
      models: discovery.models,
      model_thinking: thinking ? discovery.models.map((model) => ({ model, thinking })) : [],
      ...(reason ? { reason } : {}),
      details: {
        version: version.version,
        platform: `${process.platform}-${process.arch}`,
        installed,
      },
    }
    return result
  })

export const antigravityHostDriver = (input: {
  readonly agentType: string
  readonly paths: AgentHostPaths
  readonly sessionTitle?: string
  readonly versionProbe?: Effect.Effect<KiroVersionResult, never, ChildProcessSpawner>
}) =>
  Layer.effect(
    AgentHostDriver,
    Effect.gen(function* () {
      if (input.agentType !== 'antigravity')
        return yield* new AgentHostError({ message: 'Antigravity host driver requires agent type antigravity' })
      const spawner = yield* ChildProcessSpawner
      const crypto = yield* Crypto
      const probe: Effect.Effect<ProbeResult, AgentHostError> = probeFor(input.paths, input.versionProbe).pipe(
        Effect.provideService(ChildProcessSpawner, spawner),
        Effect.provideService(Crypto, crypto),
      )
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (runtimeInput) =>
          nativeRuntime(runtimeInput).pipe(
            Effect.provideService(ChildProcessSpawner, spawner),
            Effect.provideService(Crypto, crypto),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.succeed(undefined),
      }).pipe(Effect.mapError(() => new AgentHostError({ message: 'Antigravity adapter could not be created' })))
      return yield* makeProviderHostDriver({
        label: 'Antigravity',
        instanceId,
        adapter,
        turnFailure: antigravityTurnFailure,
        steer: false,
        resumeOnOpen: true,
        interactionMode: 'default',
        model: modelSelection,
        probe,
        ...(input.sessionTitle ? { sessionTitle: input.sessionTitle } : {}),
      })
    }),
  )

export const antigravityDriverLayer = (input: Parameters<typeof antigravityHostDriver>[0]) =>
  antigravityHostDriver(input).pipe(Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)))
