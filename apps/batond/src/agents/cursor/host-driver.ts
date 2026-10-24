import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { Effect, Layer, Schema } from 'effect'
import type { ModelSelection } from '@t3tools/contracts'
import {
  ModelSelection as ModelSelectionSchema,
  ProviderInstanceId as ProviderInstanceIdSchema,
} from '@t3tools/contracts'
import type { WorkerOpenConfig } from '@baton/protocol'
import * as CursorAgentSdk from '@t3tools/provider-cursor/server/CursorAgentSdk'
import { makeCursorAdapterV2 } from '@t3tools/provider-cursor/server'
import { CursorSettings } from '@t3tools/provider-cursor/settings'
import * as ProviderAdapter from '@t3tools/provider-core/server/ProviderAdapter'
import { makeProviderHostDriver } from '../../agent-host/driver.ts'
import type { AgentHostEnvironment } from '../../agent-host/host-layer.ts'
import { AgentHostDriver, AgentHostError } from '../../agent-host/protocol.ts'
import { ensurePrivateDirectory } from '../../platform/private.ts'
import { inspectCursorSdk, Cursor, createAgentPlatform, SqliteLocalAgentStore } from './sdk-loader.ts'

const instanceId = ProviderInstanceIdSchema.make('cursor')
const settings = Schema.decodeSync(CursorSettings)({ enabled: true })

const sdkError = (operation: string, cause: unknown) => {
  // Only class names and codes leave the host; SDK payloads stay inside it.
  const tags: string[] = []
  let current: unknown = cause
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const tag: unknown = Reflect.get(current, '_tag') ?? Reflect.get(current, 'name')
    if (typeof tag === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(tag)) tags.push(tag)
    current = Reflect.get(current, 'cause')
  }
  return new AgentHostError({ message: `Cursor ${operation} failed (${tags.join(' > ') || 'unknown'})` })
}

const runtimePolicy = (cwd: string): ProviderAdapter.ProviderAdapterV2RuntimePolicy => ({
  // Approval policy "never" keeps auto-review off while the native sandbox stays on.
  runtimeMode: 'approval-required',
  interactionMode: 'default',
  cwd,
  approvalPolicy: 'never',
})

const modelSelection = (config: WorkerOpenConfig): ModelSelection =>
  Schema.decodeSync(ModelSelectionSchema)({
    instanceId,
    model: config.model ?? config.adapter_config.model ?? 'default',
  })

const cursorProbe = Effect.gen(function* () {
  const key = process.env.CURSOR_API_KEY
  const inspected = yield* Effect.try({ try: () => inspectCursorSdk(), catch: () => undefined }).pipe(Effect.option)
  const details: Record<string, string | number | boolean> = {
    version: inspected._tag === 'Some' ? inspected.value.version : 'unknown',
    platform: `${process.platform}-${process.arch}`,
    integrity: false,
    sandboxHelper: false,
  }
  const result = (fields: { authenticated: 'valid' | 'missing' | 'unknown'; models: string[]; reason?: string }) => ({
    ...fields,
    details,
  })
  if (inspected._tag === 'None' || inspected.value.missingAssets.length > 0)
    return result({ authenticated: 'unknown', models: [], reason: 'Cursor SDK installation is incomplete' })
  const helpers = yield* Effect.tryPromise({
    try: async () => {
      await promisify(execFile)(inspected.value.sandboxHelper, ['--help'], { timeout: 5000, maxBuffer: 1024 * 1024 })
      await promisify(execFile)(inspected.value.rg, ['--version'], { timeout: 5000, maxBuffer: 1024 * 1024 })
    },
    catch: () => undefined,
  }).pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }))
  if (!helpers)
    return result({ authenticated: 'unknown', models: [], reason: 'Cursor SDK platform helpers could not be executed' })
  details.integrity = true
  if (!key?.trim())
    return result({ authenticated: 'missing', models: [], reason: 'An explicit CURSOR_API_KEY is required' })
  const authenticated = yield* Effect.tryPromise({
    try: () => Cursor.me({ apiKey: key }),
    catch: () => undefined,
  }).pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }))
  if (!authenticated)
    return result({ authenticated: 'unknown', models: [], reason: 'Cursor authentication could not be verified' })
  const sandbox = yield* Effect.tryPromise({
    try: async () => {
      try {
        const policy: unknown = JSON.parse(await readFile(join(homedir(), '.cursor', 'sandbox.json'), 'utf8'))
        if (policy && typeof policy === 'object' && 'type' in policy && policy.type === 'insecure_none') return false
      } catch (cause) {
        if (!cause || typeof cause !== 'object' || !('code' in cause) || cause.code !== 'ENOENT') throw cause
      }
      const temporary = await mkdtemp(join(tmpdir(), 'baton-cursor-probe-'))
      let probeStore: Awaited<ReturnType<typeof SqliteLocalAgentStore.open>> | undefined
      try {
        const cwd = await realpath(temporary)
        const storePath = join(cwd, 'state')
        await ensurePrivateDirectory(storePath)
        probeStore = await SqliteLocalAgentStore.open({ workspaceRef: cwd, stateRoot: storePath })
        const platform = await createAgentPlatform({ workspaceRef: cwd, localStore: probeStore, stateRoot: storePath })
        // In SDK 1.0.35 an empty settingSources disables hooks, plugins, skills and ambient MCP.
        const release = await platform.prewarmLocalWorkspace({
          apiKey: key,
          model: { id: 'default' },
          mcpServers: {},
          agents: {},
          local: {
            cwd,
            store: probeStore,
            settingSources: [],
            autoReview: true,
            sandboxOptions: { enabled: true },
            enableAgentRetries: false,
          },
        })
        await release()
        return true
      } finally {
        if (probeStore) await probeStore.dispose()
        await rm(temporary, { recursive: true, force: true })
      }
    },
    catch: () => undefined,
  }).pipe(Effect.match({ onFailure: () => false, onSuccess: (supported) => supported }))
  if (!sandbox)
    return result({
      authenticated: 'valid',
      models: [],
      reason: 'Cursor native sandbox could not be verified with isolated settings',
    })
  details.sandboxHelper = true
  const models = yield* Effect.tryPromise({
    try: () => Cursor.models.list({ apiKey: key }),
    catch: () => undefined,
  }).pipe(Effect.option)
  if (models._tag === 'None')
    return result({ authenticated: 'valid', models: [], reason: 'Cursor model catalog could not be read' })
  return result({ authenticated: 'valid', models: models.value.map((model) => model.id) })
})

export const cursorHostDriver = (input: {
  readonly agentType: string
}): Layer.Layer<AgentHostDriver, AgentHostError, AgentHostEnvironment | CursorAgentSdk.CursorAgentSdkRunner> =>
  Layer.effect(
    AgentHostDriver,
    Effect.gen(function* () {
      if (input.agentType !== 'cursor')
        return yield* new AgentHostError({ message: 'Cursor host driver requires agent type cursor' })
      const adapter = yield* makeCursorAdapterV2({
        instanceId,
        settings,
        environment: process.env,
        getModels: () => [],
      }).pipe(Effect.mapError((cause) => sdkError('adapter', cause)))
      return yield* makeProviderHostDriver({
        label: 'Cursor',
        instanceId,
        adapter,
        steer: false,
        runtimeMode: 'approval-required',
        interactionMode: 'default',
        runtimePolicy,
        model: modelSelection,
        probe: cursorProbe,
      }).pipe(
        Effect.mapError((cause: unknown) => (cause instanceof AgentHostError ? cause : sdkError('driver', cause))),
      )
    }),
  )
