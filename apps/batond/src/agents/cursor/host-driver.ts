import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { Effect, Exit, Layer, Queue, Scope, Stream } from 'effect'
import {
  makeBatonCursorAgentSdkRunner,
  ProviderEventLoggers,
  NoOpProviderEventLoggers,
  ThreadId,
  ProviderSessionId,
  textFromInteractionUpdate,
  type CursorAgentSdkSession,
  type CursorAgentSdkRun,
  type InteractionUpdate,
  type LocalAgentStore,
} from '@baton/providers/cursor'
import type { WorkerOpenConfig } from '@baton/protocol'
import { makeOutputMailbox } from '../../worker/output.ts'
import { ensurePrivateDirectory, readPrivateFile } from '../../platform/private.ts'
import {
  AgentHostDriver,
  AgentHostError,
  AgentHostProcessGroup,
  type ExecutionEvent,
  type ProbeResult,
} from '../../agent-host/protocol.ts'
import type { AgentHostEnvironment } from '../../agent-host/host-layer.ts'
import { findSent, validatePreparation } from './evidence.ts'
import { nativeMessagesFromSdk } from './history.ts'
import { loadMapping, mappingFor, persistMapping } from './mapping.ts'
import type { NativeMapping, NativeMessage } from './protocol.ts'

type Store = LocalAgentStore & { dispose(): Promise<void> }
type Sdk = typeof import('@baton/providers/cursor/sdk')
type SdkLoader = typeof import('@baton/providers/cursor/sdk-loader')
type Runner = Effect.Success<ReturnType<typeof makeBatonCursorAgentSdkRunner>>

/**
 * Cursor driver for the Agent host, built on the extracted SDK runner. One host
 * owns one Thread: open or resume once, then send, observe and stop.
 */
export const cursorHostDriver = (input: {
  readonly agentType: string
}): Layer.Layer<AgentHostDriver, unknown, AgentHostEnvironment> =>
  Layer.effect(
    AgentHostDriver,
    Effect.gen(function* () {
      if (input.agentType !== 'cursor')
        return yield* new AgentHostError({ message: 'Cursor host driver requires agent type cursor' })
      const loader = yield* Effect.tryPromise({
        try: () => import('@baton/providers/cursor/sdk-loader'),
        catch: () => new AgentHostError({ message: 'Cursor SDK loader could not be loaded' }),
      })
      const sdk = yield* Effect.tryPromise({
        try: () => import('@baton/providers/cursor/sdk'),
        catch: () => new AgentHostError({ message: 'Cursor SDK could not be loaded' }),
      })
      const sdkContext = yield* Layer.build(sdk.layer)
      const runner = yield* makeBatonCursorAgentSdkRunner().pipe(
        Effect.provide(sdkContext),
        Effect.provideService(ProviderEventLoggers, NoOpProviderEventLoggers),
      )
      return yield* makeCursorDriver(runner, sdk, loader)
    }),
  )

const makeCursorDriver = (runner: Runner, sdk: Sdk, loader: SdkLoader) =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const control = yield* Queue.bounded<ExecutionEvent, AgentHostError>(256)
    const output = makeOutputMailbox()
    const processGroup = yield* AgentHostProcessGroup
    let mapping: NativeMapping | undefined
    let config: WorkerOpenConfig | undefined
    let session: CursorAgentSdkSession | undefined
    let store: Store | undefined
    let cancelled = false
    let closed = false
    let sending = false
    let forceNextInput = false
    let executionTimeoutMs = 0
    let run: CursorAgentSdkRun | undefined
    let activeInput: object | undefined
    const error = (message: string) => new AgentHostError({ message })
    const emit = (event: ExecutionEvent) =>
      Effect.gen(function* () {
        if (event.type === 'delta') {
          output.offer(event)
          return
        }
        yield* Queue.offer(control, event)
      })
    const sdkFailure = (cause: unknown, operation: string): AgentHostError => {
      if (cause instanceof AgentHostError) return cause
      const tagged = cause && typeof cause === 'object' ? cause : undefined
      const timeout = tagged && '_tag' in tagged && tagged._tag === 'TimeoutError'
      const method =
        tagged && 'method' in tagged && typeof tagged.method === 'string' && /^[a-zA-Z.]{1,64}$/.test(tagged.method)
          ? ` (${tagged.method})`
          : ''
      const details = new Set<string>()
      let current: unknown = cause
      for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
        for (const key of ['name', 'code']) {
          const value: unknown = Reflect.get(current, key)
          if (typeof value === 'string' && /^[A-Za-z0-9_/-]{1,64}$/.test(value)) details.add(value)
        }
        const status: unknown = Reflect.get(current, 'status')
        if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599)
          details.add(`HTTP ${status}`)
        current = Reflect.get(current, 'cause')
      }
      const category = details.size > 0 ? ` [${[...details].join(', ')}]` : ''
      return error(`Cursor SDK ${operation}${method} ${timeout ? 'timed out' : 'failed'}${category}`)
    }
    const sdkCall = <A, E>(effect: Effect.Effect<A, E>, operation: string) =>
      effect.pipe(
        Effect.timeout('30 seconds'),
        Effect.mapError((cause) => sdkFailure(cause, operation)),
      )
    const openStore = (native: NativeMapping) =>
      Effect.tryPromise({
        try: () => loader.SqliteLocalAgentStore.open({ workspaceRef: native.cwd, stateRoot: native.storePath }),
        catch: () => error('Cursor persistent store could not be opened'),
      }).pipe(Effect.map((opened) => opened as Store))
    const persistedAgent = (native: NativeMapping, source: Store) =>
      Effect.tryPromise({
        try: async () => {
          const agent = await source.agents.get({ agentId: native.nativeSessionId })
          if (!agent || agent.agentId !== native.nativeSessionId || agent.cwd !== native.cwd)
            throw error('Cursor native history unavailable: session metadata is missing or mismatched')
          return agent
        },
        catch: (cause) => sdkFailure(cause, 'native session lookup'),
      })
    /** Read-only evidence; never attaches to the execution channel. */
    const readHistory = (native: NativeMapping) =>
      Effect.gen(function* () {
        const reader = yield* openStore(native)
        const messages = yield* sdkCall(
          persistedAgent(native, reader).pipe(
            Effect.andThen(runner.listMessages(native.nativeSessionId, { cwd: native.cwd, store: reader })),
          ),
          'history',
        ).pipe(Effect.ensuring(Effect.promise(() => reader.dispose())))
        return nativeMessagesFromSdk(messages) as ReadonlyArray<NativeMessage>
      })
    const cancelAndTerminate = (handle: CursorAgentSdkRun | undefined) =>
      Effect.gen(function* () {
        const results = yield* Effect.all(
          [
            Effect.exit(handle ? sdkCall(handle.cancel, 'cancel') : Effect.void),
            Effect.exit(processGroup.terminateChildren),
          ],
          { concurrency: 'unbounded' },
        )
        for (const result of results) if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause)
      })
    const flush = (
      identity: { nativeSessionId: string; messageId: string; executionId: string },
      assistant: { text: string; index: number },
    ) =>
      Effect.gen(function* () {
        if (!assistant.text) return
        yield* emit({
          ...identity,
          type: 'reply',
          id: `${identity.executionId}:${assistant.index++}`,
          text: assistant.text,
        })
        assistant.text = ''
      })
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        cancelled = true
        yield* cancelAndTerminate(run).pipe(Effect.ignore)
        if (session) yield* session.close.pipe(Effect.ignore)
        if (store) yield* Effect.promise(() => store!.dispose())
      }),
    )
    const mappingForConfig = (input: WorkerOpenConfig) =>
      Effect.tryPromise({
        try: () => mappingFor(input, ''),
        catch: () => error('Invalid Cursor native mapping'),
      })
    const prepareState = (base: NativeMapping) =>
      Effect.tryPromise({
        try: async () => {
          await ensurePrivateDirectory(dirname(base.statePath))
          await ensurePrivateDirectory(base.storePath)
        },
        catch: () => error('Cursor private state is not accessible'),
      })
    const startSession = (
      input: WorkerOpenConfig,
      base: NativeMapping,
      operation: 'create' | 'resume',
      nativeSessionId: string,
    ) =>
      Effect.gen(function* () {
        executionTimeoutMs = input.execution_timeout_seconds * 1000
        store = yield* openStore(base)
        if (operation === 'resume') {
          const resumeStore = store
          const agent = yield* persistedAgent(base, resumeStore)
          forceNextInput = yield* sdkCall(
            Effect.tryPromise({
              try: async () => {
                if (!agent.activeRunId) return false
                const previous = await resumeStore.runs.get({ agentId: agent.agentId, runId: agent.activeRunId })
                if (!previous || previous.agentId !== agent.agentId || previous.runId !== agent.activeRunId)
                  throw error('Cursor persisted active run identity mismatch')
                return previous.status === 'queued' || previous.status === 'running'
              },
              catch: (cause) => sdkFailure(cause, 'resume state lookup'),
            }),
            'resume state lookup',
          )
        }
        session = yield* sdkCall(
          runner.open({
            operation,
            ...(operation === 'resume' ? { agentId: nativeSessionId } : {}),
            threadId: ThreadId.make(input.thread_id),
            providerSessionId: ProviderSessionId.make(input.thread_id),
            options: {
              apiKey: process.env.CURSOR_API_KEY ?? '',
              model: { id: input.model ?? input.adapter_config.model ?? 'default' },
              local: {
                cwd: base.cwd,
                store,
                autoReview: true,
                settingSources: [],
                sandboxOptions: { enabled: true },
                enableAgentRetries: false,
              },
              mcpServers: {},
            },
          }),
          'open',
        )
        if (cancelled || closed) {
          yield* session.close.pipe(Effect.ignore)
          return yield* Effect.fail(error('Cursor startup was cancelled'))
        }
        if (operation === 'resume' && session.agentId !== nativeSessionId)
          return yield* Effect.fail(error('Cursor resumed a different native session'))
        config = input
        return { ...base, nativeSessionId: session.agentId }
      })
    const driver: AgentHostDriver['Service'] = {
      probe: Effect.gen(function* () {
        const key = process.env.CURSOR_API_KEY
        const inspected = yield* Effect.try({ try: () => loader.inspectCursorSdk(), catch: () => undefined }).pipe(
          Effect.option,
        )
        const details: Record<string, string | number | boolean> = {
          version: inspected._tag === 'Some' ? inspected.value.version : 'unknown',
          platform: `${process.platform}-${process.arch}`,
          integrity: false,
          sandboxHelper: false,
        }
        const result = (fields: Omit<ProbeResult, 'details'>): ProbeResult => ({ ...fields, details })
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
          try: () => loader.Cursor.me({ apiKey: key }),
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
            let probeStore: Awaited<ReturnType<typeof loader.SqliteLocalAgentStore.open>> | undefined
            try {
              const cwd = await realpath(temporary)
              const storePath = join(cwd, 'state')
              await ensurePrivateDirectory(storePath)
              probeStore = await loader.SqliteLocalAgentStore.open({ workspaceRef: cwd, stateRoot: storePath })
              const platform = await loader.createAgentPlatform({
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
          try: () => loader.Cursor.models.list({ apiKey: key }),
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
          if (session || mapping || closed || cancelled || config !== undefined)
            return yield* Effect.fail(error('Cursor host cannot open another session'))
          const base = yield* mappingForConfig(input)
          yield* prepareState(base)
          const exists = yield* Effect.promise(() =>
            readPrivateFile(base.statePath).then(
              () => true,
              () => false,
            ),
          )
          if (exists) return yield* Effect.fail(error('Cursor mapping already exists; resume explicitly'))
          mapping = yield* startSession(input, base, 'create', '')
          yield* Effect.tryPromise({
            try: () => persistMapping(mapping!),
            catch: () => error('Cursor native mapping could not be persisted'),
          })
          return { nativeSessionId: mapping.nativeSessionId }
        }),
      resume: ({ config: input, nativeSessionId }) =>
        Effect.gen(function* () {
          if (session || mapping || closed || cancelled || config !== undefined)
            return yield* Effect.fail(error('Cursor host cannot open another session'))
          const existing = yield* Effect.tryPromise({
            try: () => loadMapping(input, nativeSessionId),
            catch: () => error('Cursor native mapping identity or working directory mismatch'),
          })
          mapping = yield* startSession(input, existing, 'resume', nativeSessionId)
          return { nativeSessionId: mapping.nativeSessionId }
        }),
      send: ({ message, preparation }) =>
        Effect.gen(function* () {
          if (!session || !mapping || !store || !config || cancelled || closed || sending || run)
            return yield* Effect.fail(error('Cursor cannot submit in its current state'))
          if (message.mode !== 'queue') return yield* Effect.fail(error('Cursor does not support steer'))
          yield* Effect.try({
            try: () => validatePreparation(config!, message, mapping!, preparation),
            catch: (cause) => (cause instanceof AgentHostError ? cause : error('Invalid Cursor preparation')),
          })
          const native = mapping
          const agent = session
          sending = true
          const identity = { nativeSessionId: native.nativeSessionId, messageId: message.id, executionId: '' }
          const token = {}
          activeInput = token
          const assistant = { text: '', index: 0 }
          const earlyUpdates: InteractionUpdate[] = []
          let earlyBytes = 0
          let callbacksReady = false
          const update = (value: InteractionUpdate) =>
            Effect.gen(function* () {
              if (activeInput !== token) return
              const text = textFromInteractionUpdate(value)
              if (text !== undefined) {
                assistant.text += text
                if (assistant.text.length > 1024 * 1024)
                  return yield* Effect.fail(error('Cursor assistant output exceeds buffer limit'))
                yield* emit({ ...identity, type: 'delta', id: `${identity.executionId}:${assistant.index}`, text })
              } else if (
                [
                  'thinking-delta',
                  'tool-call-started',
                  'partial-tool-call',
                  'tool-call-completed',
                  'step-completed',
                  'turn-ended',
                ].includes(value.type)
              ) {
                yield* flush(identity, assistant)
              }
            })
          let phase = 'send'
          return yield* Effect.gen(function* () {
            const force = forceNextInput
            forceNextInput = false
            const handle = yield* agent
              .send({
                message: message.text,
                options: {
                  ...(message.model ? { model: { id: message.model } } : {}),
                  ...(force ? { local: { force: true } } : {}),
                  mcpServers: {},
                },
                onDelta: (value) =>
                  Effect.gen(function* () {
                    if (activeInput !== token) return
                    if (callbacksReady) return yield* update(value)
                    const bytes = Buffer.byteLength(JSON.stringify(value))
                    if (earlyUpdates.length >= 256 || earlyBytes + bytes > 1024 * 1024)
                      return yield* Effect.fail(error('Cursor startup event buffer overflow'))
                    earlyBytes += bytes
                    earlyUpdates.push(value)
                  }),
              })
              .pipe(Effect.mapError((cause) => sdkFailure(cause, 'send')))
            phase = 'input confirmation'
            run = handle
            identity.executionId = handle.runId
            if (handle.agentId !== native.nativeSessionId)
              return yield* Effect.fail(error('Cursor native run identity mismatch'))
            if (cancelled || closed) yield* cancelAndTerminate(handle).pipe(Effect.ignore)
            while (earlyUpdates.length) yield* update(earlyUpdates.shift()!)
            callbacksReady = true
            yield* handle.wait.pipe(
              Effect.flatMap((result) =>
                Effect.gen(function* () {
                  if (result.id !== handle.runId)
                    return yield* emit({ type: 'uncertain', reason: 'Cursor terminal run identity mismatch' })
                  yield* flush(identity, assistant)
                  if (result.status === 'finished' || result.status === 'cancelled') {
                    yield* processGroup.waitQuiescent(executionTimeoutMs)
                    yield* flush(identity, assistant)
                    yield* emit({
                      ...identity,
                      type: 'end',
                      outcome: result.status === 'finished' ? 'completed' : 'cancelled',
                    })
                  } else yield* emit({ type: 'uncertain', reason: 'Cursor native run failed' })
                }),
              ),
              Effect.catchCause(() => emit({ type: 'uncertain', reason: 'Cursor native run termination is unknown' })),
              Effect.ensuring(
                Effect.sync(() => {
                  if (run === handle) run = undefined
                  if (activeInput === token) activeInput = undefined
                }),
              ),
              Effect.forkIn(scope),
            )
            return { nativeSessionId: native.nativeSessionId, executionId: handle.runId }
          }).pipe(
            Effect.timeout('30 seconds'),
            Effect.mapError((cause) => sdkFailure(cause, phase)),
            Effect.ensuring(
              Effect.sync(() => {
                sending = false
              }),
            ),
          )
        }),
      sent: ({ config: input, message, preparation }) =>
        Effect.gen(function* () {
          const native = yield* Effect.tryPromise({
            try: () => loadMapping(input, preparation.nativeSessionId),
            catch: () => error('Cursor native mapping identity or working directory mismatch'),
          })
          const history = yield* readHistory(native)
          return yield* Effect.try({
            try: () => findSent(input, message, native, preparation, history),
            catch: (cause) => (cause instanceof AgentHostError ? cause : error('Cursor input evidence is invalid')),
          })
        }),
      events: Stream.fromQueue(control).pipe(
        Stream.merge(
          output.stream.pipe(
            Stream.map((event): ExecutionEvent => ({ ...event, type: 'delta', id: event.executionId })),
          ),
        ),
      ),
      abort: Effect.sync(() => {
        cancelled = true
      }).pipe(Effect.andThen(cancelAndTerminate(run))),
      close: Effect.sync(() => {
        closed = true
        cancelled = true
      }).pipe(
        Effect.andThen(cancelAndTerminate(run)),
        Effect.andThen(session ? sdkCall(session.close, 'close') : Effect.void),
      ),
    }
    return driver
  })
