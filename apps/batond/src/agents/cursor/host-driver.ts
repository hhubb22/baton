import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { DateTime, Deferred, Effect, Layer, Queue, Scope, Stream } from 'effect'
import type {
  ModelSelection,
  OrchestrationV2AppThread,
  OrchestrationV2ProviderThread,
  ProviderTurnId,
} from '@t3tools/contracts'
import {
  MessageId as MessageIdSchema,
  ModelSelection as ModelSelectionSchema,
  ProjectId,
  ProviderInstanceId as ProviderInstanceIdSchema,
  ThreadId,
} from '@t3tools/contracts'
import type { WorkerOpenConfig } from '@baton/protocol'
import * as CursorAgentSdk from '@t3tools/provider-cursor/server/CursorAgentSdk'
import { makeCursorAdapterV2 } from '@t3tools/provider-cursor/server'
import { CursorSettings } from '@t3tools/provider-cursor/settings'
import { Schema } from 'effect'
import * as IdAllocator from '@t3tools/provider-core/server/IdAllocator'
import * as ProviderAdapter from '@t3tools/provider-core/server/ProviderAdapter'
import { makeOutputMailbox } from '../../worker/output.ts'
import { ensurePrivateDirectory, readPrivateFile } from '../../platform/private.ts'
import type { AgentHostEnvironment } from '../../agent-host/host-layer.ts'
import { AgentHostDriver, AgentHostError, AgentHostProcessGroup } from '../../agent-host/protocol.ts'
import { findSent, validatePreparation } from './evidence.ts'
import { loadMapping, mappingFor, mappingThread, persistMapping, statePath } from './mapping.ts'
import type { NativeMapping } from './protocol.ts'
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
      return yield* makeCursorDriver(adapter).pipe(
        Effect.mapError((cause: unknown) => (cause instanceof AgentHostError ? cause : sdkError('driver', cause))),
      )
    }),
  )

interface ActiveTurn {
  readonly messageId: string
  readonly runId: string
  readonly attemptId: string
  readonly ordinal: number
  readonly started: Deferred.Deferred<ProviderTurnId>
  providerTurnId?: ProviderTurnId
  ended: boolean
}

const makeCursorDriver = (adapter: ProviderAdapter.ProviderAdapterV2['Service']) =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const processGroup = yield* AgentHostProcessGroup
    const idAllocator = yield* IdAllocator.IdAllocatorV2
    const control = yield* Queue.bounded<import('../../agent-host/protocol.ts').ExecutionEvent, AgentHostError>(256)
    const output = makeOutputMailbox()
    let mapping: NativeMapping | undefined
    let config: WorkerOpenConfig | undefined
    let providerThread: OrchestrationV2ProviderThread | undefined
    let session: ProviderAdapter.ProviderAdapterV2SessionRuntime | undefined
    let appThread: OrchestrationV2AppThread | undefined
    let active: ActiveTurn | undefined
    let ordinal = 0
    let closed = false
    let cancelled = false
    const streams = new Map<string, string>()
    const replied = new Set<string>()
    const error = (message: string) => new AgentHostError({ message })
    const emit = (event: import('../../agent-host/protocol.ts').ExecutionEvent) =>
      Effect.gen(function* () {
        if (event.type === 'delta') {
          output.offer(event)
          return
        }
        yield* Queue.offer(control, event)
      })
    const identity = (turn: ActiveTurn) => ({
      nativeSessionId: mapping?.nativeSessionId ?? '',
      messageId: turn.messageId,
      executionId: turn.runId,
    })
    const consume = (event: ProviderAdapter.ProviderAdapterV2Event) =>
      Effect.gen(function* () {
        if (closed || cancelled) return
        switch (event.type) {
          case 'provider_turn.updated': {
            const turn = event.providerTurn
            if (!active || turn.runAttemptId !== active.attemptId) return
            if (turn.status !== 'running') return
            active.providerTurnId = turn.id
            yield* Deferred.succeed(active.started, turn.id).pipe(Effect.ignore)
            return
          }
          case 'message.updated': {
            const message = event.message
            // Late events from a previous turn never reach the next turn's identity.
            if (!active || active.ended || message.role !== 'assistant' || message.runId !== active.runId) return
            const turn = active
            if (message.streaming) {
              const previous = streams.get(message.id) ?? ''
              if (message.text === previous) return
              const suffix = message.text.startsWith(previous) ? message.text.slice(previous.length) : message.text
              streams.set(message.id, message.text)
              if (suffix.length > 0)
                yield* emit({
                  ...identity(turn),
                  type: 'delta',
                  id: message.id,
                  text: suffix,
                  ...(message.text.startsWith(previous) ? {} : { gap: true }),
                })
              return
            }
            streams.delete(message.id)
            if (message.text.length === 0 || replied.has(message.id)) return
            replied.add(message.id)
            yield* emit({ ...identity(turn), type: 'reply', id: message.id, text: message.text })
            return
          }
          case 'turn.terminal': {
            if (!active || event.runOrdinal !== active.ordinal) return
            active.ended = true
            if (event.status === 'failed') {
              yield* emit({ type: 'uncertain', reason: 'Cursor turn failed' })
              return
            }
            yield* emit({
              ...identity(active),
              type: 'end',
              outcome: event.status === 'completed' ? 'completed' : 'cancelled',
            })
            return
          }
          case 'runtime_request.updated':
            // The Cursor SDK exposes no interactive request, and a stopped turn cancels any late one.
            return
          default:
            return
        }
      })
    const consumeEvents = (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime) =>
      runtime.events.pipe(
        Stream.runForEach(consume),
        Effect.catchCause(() =>
          cancelled || closed ? Effect.void : emit({ type: 'uncertain', reason: 'Cursor session event stream failed' }),
        ),
        Effect.forkIn(scope),
      )
    const authorize = (input: WorkerOpenConfig) =>
      Effect.gen(function* () {
        const cwd = yield* Effect.tryPromise({
          try: () => realpath(input.working_directory),
          catch: () => error('Cursor working directory is not accessible'),
        })
        return {
          threadId: ThreadId.make(input.thread_id),
          providerSessionId: idAllocator.derive.providerSession({ providerInstanceId: instanceId }),
          selection: modelSelection(input),
          policy: runtimePolicy(cwd),
          cwd,
        }
      })
    const appThreadFor = (input: WorkerOpenConfig, selection: ModelSelection, now: DateTime.Utc) => {
      const threadId = ThreadId.make(input.thread_id)
      return {
        createdBy: 'user',
        creationSource: 'server',
        id: threadId,
        projectId: ProjectId.make(`project:baton:${input.thread_id}`),
        title: `Baton ${input.thread_id}`,
        providerInstanceId: instanceId,
        modelSelection: selection,
        runtimeMode: 'approval-required',
        interactionMode: 'default',
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
        lastVisitedAt: null,
        settledOverride: null,
        settledAt: null,
      } satisfies OrchestrationV2AppThread
    }
    const attach = (
      input: WorkerOpenConfig,
      runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
      thread: OrchestrationV2ProviderThread,
      selection: ModelSelection,
    ) =>
      Effect.gen(function* () {
        const nativeSessionId = thread.nativeThreadRef?.nativeId
        if (!nativeSessionId) return yield* error('Cursor provider thread has no native session id')
        const next = yield* Effect.tryPromise({
          try: () => mappingFor(input, nativeSessionId, thread),
          catch: () => error('Invalid Cursor native mapping'),
        })
        yield* Effect.tryPromise({
          try: () => ensurePrivateDirectory(dirname(statePath(input))),
          catch: () => error('Cursor private state is not accessible'),
        })
        yield* Effect.tryPromise({
          try: () => persistMapping(next),
          catch: () => error('Cursor native mapping could not be persisted'),
        })
        mapping = next
        providerThread = thread
        session = runtime
        config = input
        ordinal = 0
        appThread = appThreadFor(input, selection, yield* DateTime.now)
        return { nativeSessionId }
      })
    const driver: AgentHostDriver['Service'] = {
      probe: Effect.gen(function* () {
        const key = process.env.CURSOR_API_KEY
        const inspected = yield* Effect.try({ try: () => inspectCursorSdk(), catch: () => undefined }).pipe(
          Effect.option,
        )
        const details: Record<string, string | number | boolean> = {
          version: inspected._tag === 'Some' ? inspected.value.version : 'unknown',
          platform: `${process.platform}-${process.arch}`,
          integrity: false,
          sandboxHelper: false,
        }
        const result = (fields: {
          authenticated: 'valid' | 'missing' | 'unknown'
          models: string[]
          reason?: string
        }) => ({
          ...fields,
          details,
        })
        if (inspected._tag === 'None' || inspected.value.missingAssets.length > 0)
          return result({
            authenticated: 'unknown',
            models: [],
            reason: 'Cursor SDK installation is incomplete',
          })
        const helpers = yield* Effect.tryPromise({
          try: async () => {
            await promisify(execFile)(inspected.value.sandboxHelper, ['--help'], {
              timeout: 5000,
              maxBuffer: 1024 * 1024,
            })
            await promisify(execFile)(inspected.value.rg, ['--version'], { timeout: 5000, maxBuffer: 1024 * 1024 })
          },
          catch: () => undefined,
        }).pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }))
        if (!helpers)
          return result({
            authenticated: 'unknown',
            models: [],
            reason: 'Cursor SDK platform helpers could not be executed',
          })
        details.integrity = true
        if (!key?.trim())
          return result({
            authenticated: 'missing',
            models: [],
            reason: 'An explicit CURSOR_API_KEY is required',
          })
        const authenticated = yield* Effect.tryPromise({
          try: () => Cursor.me({ apiKey: key }),
          catch: () => undefined,
        }).pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }))
        if (!authenticated)
          return result({
            authenticated: 'unknown',
            models: [],
            reason: 'Cursor authentication could not be verified',
          })
        const sandbox = yield* Effect.tryPromise({
          try: async () => {
            try {
              const policy: unknown = JSON.parse(await readFile(join(homedir(), '.cursor', 'sandbox.json'), 'utf8'))
              if (policy && typeof policy === 'object' && 'type' in policy && policy.type === 'insecure_none')
                return false
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
              const platform = await createAgentPlatform({
                workspaceRef: cwd,
                localStore: probeStore,
                stateRoot: storePath,
              })
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
          return result({
            authenticated: 'valid',
            models: [],
            reason: 'Cursor model catalog could not be read',
          })
        return result({ authenticated: 'valid', models: models.value.map((model) => model.id) })
      }),
      open: ({ config: input }) =>
        Effect.gen(function* () {
          if (session || providerThread || closed || cancelled)
            return yield* error('Cursor host cannot open another session')
          const exists = yield* Effect.promise(() =>
            readPrivateFile(statePath(input)).then(
              () => true,
              () => false,
            ),
          )
          if (exists) return yield* error('Cursor mapping already exists; resume explicitly')
          const authorized = yield* authorize(input)
          const runtime = yield* adapter
            .openSession({
              threadId: authorized.threadId,
              providerSessionId: authorized.providerSessionId,
              modelSelection: authorized.selection,
              runtimePolicy: authorized.policy,
            })
            .pipe(
              Effect.provideService(Scope.Scope, scope),
              Effect.mapError((cause) => sdkError('open', cause)),
            )
          const thread = yield* runtime
            .ensureThread({
              threadId: authorized.threadId,
              modelSelection: authorized.selection,
              runtimePolicy: authorized.policy,
              providerSessionId: authorized.providerSessionId,
            })
            .pipe(Effect.mapError((cause) => sdkError('ensure thread', cause)))
          const result = yield* attach(input, runtime, thread, authorized.selection)
          yield* consumeEvents(runtime)
          return result
        }),
      resume: ({ config: input, nativeSessionId }) =>
        Effect.gen(function* () {
          if (session || providerThread || closed || cancelled)
            return yield* error('Cursor host cannot open another session')
          const stored = yield* Effect.tryPromise({
            try: () => loadMapping(input, nativeSessionId),
            catch: () => error('Cursor native mapping identity or working directory mismatch'),
          })
          const authorized = yield* authorize(input)
          const runtime = yield* adapter
            .openSession({
              threadId: authorized.threadId,
              providerSessionId: authorized.providerSessionId,
              modelSelection: authorized.selection,
              runtimePolicy: authorized.policy,
            })
            .pipe(
              Effect.provideService(Scope.Scope, scope),
              Effect.mapError((cause) => sdkError('resume', cause)),
            )
          const thread = yield* runtime
            .resumeThread({
              providerThread: mappingThread(stored),
              threadId: authorized.threadId,
              modelSelection: authorized.selection,
              runtimePolicy: authorized.policy,
            })
            .pipe(Effect.mapError((cause) => sdkError('resume thread', cause)))
          const result = yield* attach(input, runtime, thread, authorized.selection)
          yield* consumeEvents(runtime)
          return result
        }),
      send: ({ message, preparation }) =>
        Effect.gen(function* () {
          if (!session || !providerThread || !config || !appThread || closed || cancelled)
            return yield* error('Cursor cannot submit in its current state')
          if (active && !active.ended) return yield* error('Cursor turn is still active')
          if (message.mode !== 'queue') return yield* error('Cursor does not support steer')
          yield* Effect.try({
            try: () => validatePreparation(message, preparation),
            catch: (cause) => (cause instanceof AgentHostError ? cause : error('Invalid Cursor preparation')),
          })
          const threadId = ThreadId.make(config.thread_id)
          const selection = modelSelection(config)
          const policy = runtimePolicy((yield* authorize(config)).cwd)
          ordinal += 1
          const runId = idAllocator.derive.run({ threadId, ordinal })
          const attemptId = idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 })
          const rootNodeId = idAllocator.derive.rootNode({ runId })
          const started = yield* Deferred.make<ProviderTurnId>()
          const turn: ActiveTurn = { messageId: message.id, runId, attemptId, ordinal, started, ended: false }
          active = turn
          streams.clear()
          replied.clear()
          yield* session
            .startTurn({
              appThread,
              threadId,
              runId,
              runOrdinal: ordinal,
              providerTurnOrdinal: ordinal,
              attemptId,
              rootNodeId,
              providerThread,
              message: {
                messageId: MessageIdSchema.make(`message:baton:${message.id}`),
                text: message.text,
                attachments: [],
                createdBy: 'user',
                creationSource: 'server',
              },
              modelSelection: selection,
              runtimePolicy: policy,
            })
            .pipe(
              Effect.timeout('30 seconds'),
              Effect.mapError((cause) => sdkError('start turn', cause)),
            )
          const turnId = yield* Deferred.await(started).pipe(
            Effect.timeout('5 seconds'),
            Effect.match({ onFailure: () => undefined, onSuccess: (value) => value }),
          )
          if (turnId) turn.providerTurnId = turnId
          return { nativeSessionId: mapping!.nativeSessionId, executionId: runId }
        }),
      sent: ({ config: input, message, preparation }) =>
        Effect.gen(function* () {
          const stored = yield* Effect.tryPromise({
            try: () => loadMapping(input, preparation.nativeSessionId),
            catch: () => error('Cursor native mapping identity or working directory mismatch'),
          })
          const authorized = yield* authorize(input)
          const snapshot = yield* Effect.scoped(
            Effect.gen(function* () {
              const runtime = yield* adapter.openSession({
                threadId: authorized.threadId,
                providerSessionId: authorized.providerSessionId,
                modelSelection: authorized.selection,
                runtimePolicy: authorized.policy,
              })
              return yield* runtime
                .readThreadSnapshot({ providerThread: mappingThread(stored) })
                .pipe(Effect.timeout('30 seconds'))
            }),
          ).pipe(Effect.mapError((cause) => sdkError('read snapshot', cause)))
          const messages = snapshot.messages.flatMap((entry) =>
            entry.role === 'user' || entry.role === 'assistant'
              ? [{ id: entry.id, role: entry.role, text: entry.text }]
              : [],
          )
          return yield* Effect.try({
            try: () => findSent(message, preparation, messages),
            catch: (cause) => (cause instanceof AgentHostError ? cause : error('Cursor input evidence is invalid')),
          })
        }),
      events: Stream.fromQueue(control).pipe(
        Stream.merge(
          output.stream.pipe(
            Stream.map((event): import('../../agent-host/protocol.ts').ExecutionEvent => ({
              ...event,
              type: 'delta',
              id: event.executionId,
            })),
          ),
        ),
      ),
      abort: Effect.gen(function* () {
        const turn = active
        if (!session || !providerThread || !turn || turn.ended) return
        const turnId =
          turn.providerTurnId ??
          (yield* Deferred.await(turn.started).pipe(
            Effect.timeout('5 seconds'),
            Effect.match({ onFailure: () => undefined, onSuccess: (value) => value }),
          ))
        if (!turnId) {
          yield* processGroup.terminateChildren.pipe(Effect.ignore)
          return
        }
        yield* session
          .interruptTurn({ providerThread, providerTurnId: turnId })
          .pipe(Effect.timeout('30 seconds'), Effect.ignore)
      }),
      close: Effect.gen(function* () {
        closed = true
        cancelled = true
        const turn = active
        if (!session || !providerThread || !turn || turn.ended) return
        if (!turn.providerTurnId) return
        yield* session
          .interruptTurn({ providerThread, providerTurnId: turn.providerTurnId })
          .pipe(Effect.timeout('10 seconds'), Effect.ignore)
      }),
    }
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closed = true
        cancelled = true
      }),
    )
    return driver
  })
