import { Effect, Layer, Schema } from 'effect'
import type { OrchestrationV2ProviderFailure } from '@t3tools/contracts'
import { Crypto } from 'effect/Crypto'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'
import type { ModelSelection } from '@t3tools/contracts'
import { ModelSelection as ModelSelectionSchema, ProviderInstanceId } from '@t3tools/contracts'
import type { WorkerOpenConfig } from '@baton/protocol'
import { makeAcpRegistryAdapterV2 } from '@t3tools/provider-acp-registry/server'
import { AcpRegistrySettings } from '@t3tools/provider-acp-registry/settings'
import { AcpRegistryCatalog, layerFromHost } from '@t3tools/provider-acp-registry/server/AcpRegistrySupport'
import {
  checkAcpRegistryProviderStatus,
  probeAcpRegistryConfiguration,
} from '@t3tools/provider-acp-registry/server/status'
import { NoOpProviderEventLoggers, ProviderEventLoggers } from '@t3tools/provider-core/server/ProviderEventLoggers'
import { resolveSelfInvocation } from '@t3tools/shared/nodeRuntime'
import { makeProviderHostDriver } from '../../agent-host/driver.ts'
import type { AgentHostPaths } from '../../agent-host/paths.ts'
import { AgentHostDriver, AgentHostError, type ProbeResult } from '../../agent-host/protocol.ts'
import { thinkingCapability } from '../thinking.ts'
import { kiroVersion, type KiroVersionResult } from '../kiro/version.ts'

const instanceId = ProviderInstanceId.make('droid')
const DROID_DEFAULT_MODEL = 'auto'
const settingsFor = () =>
  Schema.decodeSync(AcpRegistrySettings)({
    enabled: true,
    source: 'local',
    agentId: 'factory-droid',
    commandPath: 'droid',
    commandArgs: ['exec', '--output-format', 'acp'],
  })

const modelSelection = (config: WorkerOpenConfig): ModelSelection =>
  Schema.decodeSync(ModelSelectionSchema)({
    instanceId,
    model: config.model ?? config.adapter_config.model ?? DROID_DEFAULT_MODEL,
  })

/** Droid reports -32000 for authentication and other provider errors, so the message settles ordinary failures. */
const isAuthenticationFailure = (failure: OrchestrationV2ProviderFailure) =>
  failure.code === '-32000' ||
  /\b(?:authenticat(?:e|ed|es|ing|ion)|credentials?|log(?:[\s-]+)?in|sign(?:[\s-]+)?in|api key)\b/iu.test(
    failure.message,
  )

export const droidTurnFailure = (failure: OrchestrationV2ProviderFailure): string =>
  isAuthenticationFailure(failure)
    ? 'Sign in to the Factory Droid CLI and try again.'
    : 'Check the Factory Droid CLI on this device and try again.'

/** Discovery creates one empty session and reads its models and default-model options without prompting. */
const droidProbe = (
  paths: AgentHostPaths,
  versionProbe = kiroVersion({ cwd: paths.workingDirectory, binary: 'droid' }),
) =>
  Effect.gen(function* () {
    const [status, version] = yield* Effect.all(
      [
        checkAcpRegistryProviderStatus(
          {
            instanceId,
            displayName: 'Droid',
            accentColor: undefined,
            continuationKey: 'droid',
            settings: settingsFor(),
            cwd: paths.workingDirectory,
            environment: process.env,
          },
          probeAcpRegistryConfiguration,
        ),
        versionProbe,
      ],
      { concurrency: 'unbounded' },
    )
    const auth = status.auth.status
    const authenticated: ProbeResult['authenticated'] =
      auth === 'authenticated' ? 'valid' : auth === 'unauthenticated' ? 'missing' : 'unknown'
    const reason =
      !status.installed || version.state === 'missing'
        ? 'Factory Droid CLI 未安装或不可执行'
        : authenticated === 'missing'
          ? 'Factory Droid CLI 尚未认证'
          : version.state === 'timeout'
            ? 'Droid 版本探测超时'
            : version.state !== 'ready'
              ? 'Droid 版本暂不可确认'
              : authenticated === 'unknown'
                ? 'Droid 认证状态未知，首次执行时由原生程序检查'
                : status.models.length === 0
                  ? 'Droid 模型目录暂不可读，可使用默认模型'
                  : undefined
    const result: ProbeResult = {
      authenticated,
      models: [
        ...status.models.filter((model) => model.isDefault),
        ...status.models.filter((model) => !model.isDefault),
      ].map((model) => model.slug),
      model_thinking: status.models.flatMap((model) => {
        const thinking = thinkingCapability(model.capabilities)
        return thinking ? [{ model: model.slug, thinking }] : []
      }),
      ...(reason ? { reason } : {}),
      details: {
        version: version.version,
        platform: `${process.platform}-${process.arch}`,
        installed: Boolean(status.installed) && version.state !== 'missing',
      },
    }
    return result
  })

export const droidHostDriver = (input: {
  readonly agentType: string
  readonly paths: AgentHostPaths
  readonly sessionTitle?: string
  readonly versionProbe?: Effect.Effect<KiroVersionResult, never, ChildProcessSpawner>
}) =>
  Layer.effect(
    AgentHostDriver,
    Effect.gen(function* () {
      if (input.agentType !== 'droid')
        return yield* new AgentHostError({ message: 'Droid host driver requires agent type droid' })
      const spawner = yield* ChildProcessSpawner
      const crypto = yield* Crypto
      const catalog = yield* AcpRegistryCatalog
      const probe: Effect.Effect<ProbeResult, AgentHostError> = droidProbe(input.paths, input.versionProbe).pipe(
        Effect.provideService(ChildProcessSpawner, spawner),
        Effect.provideService(Crypto, crypto),
        Effect.provideService(AcpRegistryCatalog, catalog),
      )
      const adapter = yield* makeAcpRegistryAdapterV2({
        instanceId,
        settings: settingsFor(),
        environment: process.env,
        selfInvocation: yield* resolveSelfInvocation(),
      }).pipe(Effect.mapError(() => new AgentHostError({ message: 'Droid adapter could not be created' })))
      return yield* makeProviderHostDriver({
        label: 'Droid',
        instanceId,
        adapter,
        turnFailure: droidTurnFailure,
        steer: false,
        resumeOnOpen: true,
        interactionMode: 'default',
        model: modelSelection,
        probe,
        ...(input.sessionTitle ? { sessionTitle: input.sessionTitle } : {}),
      })
    }),
  )

/** Local Droid resolution uses the catalog without fetching a registry or installing packages. */
export const droidDriverLayer = (input: Parameters<typeof droidHostDriver>[0]) =>
  droidHostDriver(input).pipe(
    Layer.provide(layerFromHost.pipe(Layer.provide(FetchHttpClient.layer))),
    Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  )
