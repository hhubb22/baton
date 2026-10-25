import { join } from 'node:path'
import { Effect, Layer, Option, Schema } from 'effect'
import * as CodexSchema from 'effect-codex-app-server/schema'
import { Crypto } from 'effect/Crypto'
import { FileSystem } from 'effect/FileSystem'
import { Path } from 'effect/Path'
import * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner'
import type { ModelSelection } from '@t3tools/contracts'
import { DEFAULT_MODEL, ModelSelection as ModelSelectionSchema } from '@t3tools/contracts'
import { CodexSettings } from '@t3tools/contracts/settings'
import type { WorkerOpenConfig } from '@baton/protocol'
import * as ProviderAdapter from '@t3tools/provider-core/server/ProviderAdapter'
import * as IdAllocator from '@t3tools/provider-core/server/IdAllocator'
import { NoOpProviderEventLoggers, ProviderEventLoggers } from '@t3tools/provider-core/server/ProviderEventLoggers'
import {
  CODEX_DEFAULT_INSTANCE_ID,
  CodexAppServerClientFactory,
  layerAppServerClientFactory,
  makeCodexAdapterV2,
} from '@t3tools/provider-codex/server'
import { checkCodexProviderStatus } from '@t3tools/provider-codex/server/status'
import type { SnapshotMessage } from '../../agent-host/evidence.ts'
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
    model: config.model ?? config.adapter_config.model ?? DEFAULT_MODEL,
  })

// Codex snapshots keep native turns in providerPayload and leave messages empty.
const snapshotMessages = (
  snapshot: ProviderAdapter.ProviderAdapterV2ThreadSnapshot,
): ReadonlyArray<SnapshotMessage> => {
  const thread = Schema.decodeUnknownOption(CodexSchema.V2ThreadReadResponse__Thread)(snapshot.providerPayload)
  if (Option.isNone(thread)) return []
  return thread.value.turns.flatMap((turn) =>
    turn.items.flatMap((item): SnapshotMessage[] =>
      item.type === 'userMessage'
        ? [
            {
              id: turn.id,
              role: 'user',
              text: item.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n'),
            },
          ]
        : [],
    ),
  )
}

const codexProbe = Effect.gen(function* () {
  const status = yield* checkCodexProviderStatus(settingsFor(), undefined, process.env).pipe(
    Effect.mapError((cause) => new AgentHostError({ message: `Codex probe failed (${String(cause)})` })),
  )
  const auth = status.auth.status
  const authenticated: ProbeResult['authenticated'] =
    auth === 'authenticated' ? 'valid' : auth === 'unauthenticated' ? 'missing' : 'unknown'
  const reason = !status.installed
    ? 'Codex CLI 未安装或不可执行'
    : authenticated === 'missing'
      ? 'Codex CLI 尚未认证'
      : authenticated === 'unknown'
        ? 'Codex 认证状态尚未确认'
        : status.models.length === 0
          ? 'Codex 模型目录暂不可读，可使用默认模型'
          : status.message
            ? 'Codex 探测报告了配置或模型目录问题'
            : undefined
  const result: ProbeResult = {
    authenticated,
    models: [
      ...status.models.filter((model) => model.isDefault),
      ...status.models.filter((model) => !model.isDefault),
    ].map((model) => model.slug),
    ...(reason ? { reason } : {}),
    details: {
      version: status.version ?? 'unknown',
      platform: `${process.platform}-${process.arch}`,
      installed: Boolean(status.installed),
    },
  }
  return result
})

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
      const fileSystem = yield* FileSystem
      const path = yield* Path
      const probe: Effect.Effect<ProbeResult, AgentHostError> = codexProbe.pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem, fileSystem),
        Effect.provideService(Path, path),
      )
      const crypto = yield* Crypto
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
        snapshotMessages,
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
