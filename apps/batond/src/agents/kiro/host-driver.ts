import { Effect, Layer, Schema } from 'effect'
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
import type { AgentHostPaths } from '../../agent-host/host-layer.ts'
import { AgentHostDriver, AgentHostError, type ProbeResult } from '../../agent-host/protocol.ts'
import { kiroVersion, type KiroVersionResult } from './version.ts'
import { kiroTurnFailure } from './failure.ts'

const instanceId = ProviderInstanceId.make('kiro')
const settingsFor = () =>
  Schema.decodeSync(AcpRegistrySettings)({
    enabled: true,
    source: 'local',
    agentId: 'kiro',
    commandPath: 'kiro-cli',
  })

const modelSelection = (config: WorkerOpenConfig): ModelSelection =>
  Schema.decodeSync(ModelSelectionSchema)({
    instanceId,
    model: config.model ?? config.adapter_config.model ?? 'default',
  })

/** Upstream discovery creates an empty session; the separate version command never prompts. */
const kiroProbe = (paths: AgentHostPaths, versionProbe = kiroVersion({ cwd: paths.workingDirectory })) =>
  Effect.gen(function* () {
    const [status, version] = yield* Effect.all(
      [
        checkAcpRegistryProviderStatus(
          {
            instanceId,
            displayName: 'Kiro',
            accentColor: undefined,
            continuationKey: 'kiro',
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
        ? 'Kiro CLI 未安装或不可执行'
        : authenticated === 'missing'
          ? 'Kiro CLI 尚未认证'
          : version.state === 'timeout'
            ? 'Kiro 版本探测超时'
            : version.state !== 'ready'
              ? 'Kiro 版本暂不可确认'
              : authenticated === 'unknown'
                ? 'Kiro 认证状态未知，首次执行时由原生程序检查'
                : status.models.length === 0
                  ? 'Kiro 模型目录暂不可读，可使用默认模型'
                  : undefined
    const result: ProbeResult = {
      authenticated,
      models: [
        ...status.models.filter((model) => model.isDefault),
        ...status.models.filter((model) => !model.isDefault),
      ].map((model) => model.slug),
      ...(reason ? { reason } : {}),
      details: {
        version: version.version,
        platform: `${process.platform}-${process.arch}`,
        installed: Boolean(status.installed) && version.state !== 'missing',
      },
    }
    return result
  })

export const kiroHostDriver = (input: {
  readonly agentType: string
  readonly paths: AgentHostPaths
  readonly sessionTitle?: string
  readonly versionProbe?: Effect.Effect<KiroVersionResult, never, ChildProcessSpawner>
}) =>
  Layer.effect(
    AgentHostDriver,
    Effect.gen(function* () {
      if (input.agentType !== 'kiro')
        return yield* new AgentHostError({ message: 'Kiro host driver requires agent type kiro' })
      const spawner = yield* ChildProcessSpawner
      const crypto = yield* Crypto
      const catalog = yield* AcpRegistryCatalog
      const probe: Effect.Effect<ProbeResult, AgentHostError> = kiroProbe(input.paths, input.versionProbe).pipe(
        Effect.provideService(ChildProcessSpawner, spawner),
        Effect.provideService(Crypto, crypto),
        Effect.provideService(AcpRegistryCatalog, catalog),
      )
      const adapter = yield* makeAcpRegistryAdapterV2({
        instanceId,
        settings: settingsFor(),
        environment: process.env,
        selfInvocation: yield* resolveSelfInvocation(),
      }).pipe(Effect.mapError(() => new AgentHostError({ message: 'Kiro adapter could not be created' })))
      return yield* makeProviderHostDriver({
        label: 'Kiro',
        instanceId,
        adapter,
        turnFailure: kiroTurnFailure,
        steer: false,
        resumeOnOpen: true,
        runtimeMode: 'approval-required',
        interactionMode: 'default',
        runtimePolicy: (cwd) => ({ runtimeMode: 'approval-required', interactionMode: 'default', cwd }),
        model: modelSelection,
        probe,
        ...(input.sessionTitle ? { sessionTitle: input.sessionTitle } : {}),
      })
    }),
  )

/** Local Kiro resolution uses the catalog without fetching a registry or installing packages. */
export const kiroDriverLayer = (input: Parameters<typeof kiroHostDriver>[0]) =>
  kiroHostDriver(input).pipe(
    Layer.provide(layerFromHost.pipe(Layer.provide(FetchHttpClient.layer))),
    Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  )
