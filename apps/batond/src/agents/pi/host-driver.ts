import { Effect, Layer, Schema } from 'effect'
import * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner'
import type { ModelSelection } from '@t3tools/contracts'
import {
  ModelSelection as ModelSelectionSchema,
  ProviderInstanceId as ProviderInstanceIdSchema,
} from '@t3tools/contracts'
import type { WorkerOpenConfig } from '@baton/protocol'
import { makePiAdapterV2, PI_PROVIDER } from '@t3tools/provider-pi/server'
import { PiSettings } from '@t3tools/provider-pi/settings'
import { checkPiProviderStatus } from '@t3tools/provider-pi/server/status'
import { makeProviderHostDriver } from '../../agent-host/driver.ts'
import { AgentHostDriver, AgentHostError, type ProbeResult } from '../../agent-host/protocol.ts'

const instanceId = ProviderInstanceIdSchema.make(PI_PROVIDER)

const modelSelection = (config: WorkerOpenConfig): ModelSelection =>
  Schema.decodeSync(ModelSelectionSchema)({
    instanceId,
    model: config.model ?? config.adapter_config.model ?? 'default',
  })

const settingsFor = (launchArgs: string) =>
  Schema.decodeSync(PiSettings)({
    enabled: true,
    binaryPath: 'pi',
    launchArgs,
  })

/** Upstream install, version and auth check. It does not send a prompt or open a browser. */
const piProbe = (launchArgs = '') =>
  Effect.gen(function* () {
    const status = yield* checkPiProviderStatus(settingsFor(launchArgs), process.env).pipe(
      Effect.mapError((cause) => new AgentHostError({ message: `Pi probe failed (${String(cause)})` })),
    )
    const version = status.version ?? 'unknown'
    const auth = status.auth.status
    const authenticated: ProbeResult['authenticated'] =
      auth === 'authenticated' ? 'valid' : auth === 'unauthenticated' ? 'missing' : 'unknown'
    const models = [
      ...status.models.filter((model) => model.isDefault),
      ...status.models.filter((model) => !model.isDefault),
    ].map((model) => model.slug)
    const reason = !status.installed
      ? 'Pi CLI 未安装或不可执行'
      : authenticated === 'missing'
        ? 'Pi CLI 尚未认证'
        : authenticated === 'unknown'
          ? 'Pi 认证状态尚未确认'
          : models.length === 0
            ? 'Pi 模型目录暂不可读，可使用默认模型'
            : status.message
              ? 'Pi 探测报告了配置或模型目录问题'
              : undefined
    const result: ProbeResult = {
      authenticated,
      models,
      ...(reason ? { reason } : {}),
      details: {
        version,
        platform: `${process.platform}-${process.arch}`,
        installed: Boolean(status.installed),
      },
    }
    return result
  })

export const piHostDriver = (input: {
  readonly agentType: string
  readonly launchArgs?: string
  readonly sessionTitle?: string
}) =>
  Layer.effect(
    AgentHostDriver,
    Effect.gen(function* () {
      if (input.agentType !== 'pi')
        return yield* new AgentHostError({ message: 'Pi host driver requires agent type pi' })
      const launchArgs = input.launchArgs ?? ''
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const probe: Effect.Effect<ProbeResult, AgentHostError> = piProbe(launchArgs).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      )
      const adapter = yield* makePiAdapterV2({
        instanceId,
        settings: settingsFor(launchArgs),
        environment: process.env,
      }).pipe(Effect.mapError((cause) => new AgentHostError({ message: `Pi adapter failed (${String(cause)})` })))
      return yield* makeProviderHostDriver({
        label: 'Pi',
        instanceId,
        adapter,
        steer: true,
        bindSnapshot: true,
        runtimeMode: 'approval-required',
        interactionMode: 'default',
        runtimePolicy: (cwd) => ({
          runtimeMode: 'approval-required',
          interactionMode: 'default',
          cwd,
        }),
        model: modelSelection,
        probe,
        ...(input.sessionTitle ? { sessionTitle: input.sessionTitle } : {}),
      })
    }),
  )
