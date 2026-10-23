import { Console } from 'node:console'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { Cause, Effect, Exit, Fiber, Layer, Queue, Scope, Semaphore, Stream } from 'effect'
import { RpcServer, RpcSerialization } from 'effect/rpc'
import { NodeStdio } from '@effect/platform-node'
import {
  makeBatonCursorAgentSdkRunner,
  ProviderEventLoggers,
  NoOpProviderEventLoggers,
  ThreadId,
  ProviderSessionId,
  textFromInteractionUpdate,
  type CursorAgentSdkSession,
  CursorAgentSdkRunnerError,
  type CursorAgentSdkRun,
  type LocalAgentStore,
  type InteractionUpdate,
} from '@baton/providers/cursor'
import { installHostProcessGroup } from '../../platform/host-process-group.ts'
import { ensurePrivateDirectory } from '../../platform/private.ts'
import { findSent, validatePreparation } from './evidence.ts'
import { nativeMessagesFromSdk } from './history.ts'
import { mappingFor } from './mapping.ts'
import {
  CursorHostError,
  CursorHostRpc,
  type HostEvent,
  type ExecutionEvent,
  type NativeMapping,
  type NativeMessage,
  type ProbeResult,
} from './protocol.ts'

/** SDK modules are only loaded when the CLI enters the cursor-host subcommand. */
export const runCursorHost = () =>
  Effect.gen(function* () {
    if (process.platform !== 'win32') process.umask(0o077)
    const originalConsole = globalThis.console
    globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        globalThis.console = originalConsole
      }),
    )
    const processGroup = yield* Effect.sync(installHostProcessGroup)
    yield* Effect.addFinalizer(() =>
      processGroup
        .terminateChildrenEffect({ timeoutMs: 5000 })
        .pipe(Effect.andThen(processGroup.waitQuiescentEffect({ timeoutMs: 2000 })), Effect.orDie),
    )
    const sdk = yield* Effect.promise(() => import('@baton/providers/cursor/sdk-loader'))
    const runtime = yield* Effect.promise(() => import('@baton/providers/cursor/sdk'))
    const sdkContext = yield* Layer.build(runtime.layer)
    const runner = yield* makeBatonCursorAgentSdkRunner().pipe(
      Effect.provide(sdkContext),
      Effect.provideService(ProviderEventLoggers, NoOpProviderEventLoggers),
    )
    const hostScope = yield* Scope.Scope
    const warmedRunner: typeof runner = {
      ...runner,
      open: (input) =>
        Effect.gen(function* () {
          const local = input.options.local
          if (!local?.cwd || !local.store)
            return yield* Effect.fail(
              new CursorAgentSdkRunnerError({
                method: 'workspace.prewarm',
                cause: new Error('Private local workspace and store are required'),
              }),
            )
          const cwd = local.cwd
          const store = local.store
          const release = yield* Effect.tryPromise({
            try: async () => {
              const platform = await sdk.createAgentPlatform({ workspaceRef: cwd, localStore: store })
              return platform.prewarmLocalWorkspace(input.options)
            },
            catch: (cause) => new CursorAgentSdkRunnerError({ method: 'workspace.prewarm', cause }),
          })
          yield* Scope.addFinalizer(
            hostScope,
            Effect.tryPromise(release).pipe(Effect.timeout('5 seconds'), Effect.ignore),
          )
          return yield* runner.open(input)
        }),
    }
    const handlers = yield* makeCursorHostHandlers({
      processGroup: {
        terminateChildren: processGroup
          .terminateChildrenEffect()
          .pipe(
            Effect.mapError(() => new CursorHostError({ message: 'Cursor host children could not be terminated' })),
          ),
        waitQuiescent: (timeoutMs) =>
          processGroup
            .waitQuiescentEffect({ timeoutMs })
            .pipe(Effect.mapError(() => new CursorHostError({ message: 'Cursor host children are not quiescent' }))),
      },
      runner: warmedRunner,
      openStore: (mapping) =>
        Effect.tryPromise({
          try: () => sdk.SqliteLocalAgentStore.open({ workspaceRef: mapping.cwd, stateRoot: mapping.storePath }),
          catch: () => new CursorHostError({ message: 'Cursor persistent store could not be opened' }),
        }),
      history: (mapping, store) =>
        runner.listMessages(mapping.nativeSessionId, { cwd: mapping.cwd, store }).pipe(
          Effect.mapError(() => new CursorHostError({ message: 'Cursor native history could not be read' })),
          Effect.map(nativeMessagesFromSdk),
        ),
      probe: Effect.gen(function* () {
        const key = process.env.CURSOR_API_KEY
        const inspected = yield* Effect.try({ try: () => sdk.inspectCursorSdk(), catch: () => undefined }).pipe(
          Effect.option,
        )
        const base = {
          models: [] as string[],
          sdkVersion: inspected._tag === 'Some' ? inspected.value.version : 'unknown',
          platform: `${process.platform}-${process.arch}`,
          integrity: false,
          sandboxHelper: false,
        }
        if (inspected._tag === 'None' || inspected.value.missingAssets.length > 0)
          return { ...base, authenticated: 'unknown' as const, reason: 'Cursor SDK installation is incomplete' }
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
          return {
            ...base,
            authenticated: 'unknown' as const,
            reason: 'Cursor SDK platform helpers could not be executed',
          }
        base.integrity = true
        if (!key?.trim())
          return { ...base, authenticated: 'missing' as const, reason: 'An explicit CURSOR_API_KEY is required' }
        const authenticated = yield* Effect.tryPromise({
          try: () => sdk.Cursor.me({ apiKey: key }),
          catch: () => undefined,
        }).pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }))
        if (!authenticated)
          return { ...base, authenticated: 'unknown' as const, reason: 'Cursor authentication could not be verified' }
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
            let store: Awaited<ReturnType<typeof sdk.SqliteLocalAgentStore.open>> | undefined
            try {
              const cwd = await realpath(temporary)
              const storePath = join(cwd, 'state')
              await ensurePrivateDirectory(storePath)
              store = await sdk.SqliteLocalAgentStore.open({ workspaceRef: cwd, stateRoot: storePath })
              const platform = await sdk.createAgentPlatform({
                workspaceRef: cwd,
                localStore: store,
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
                  store,
                  settingSources: [],
                  autoReview: true,
                  sandboxOptions: { enabled: true },
                  enableAgentRetries: false,
                },
              })
              await release()
              return true
            } finally {
              if (store) await store.dispose()
              await rm(temporary, { recursive: true, force: true })
            }
          },
          catch: () => undefined,
        }).pipe(Effect.match({ onFailure: () => false, onSuccess: (supported) => supported }))
        if (!sandbox)
          return {
            ...base,
            authenticated: 'valid' as const,
            reason: 'Cursor native sandbox could not be verified with isolated settings',
          }
        base.sandboxHelper = true
        const models = yield* Effect.tryPromise({
          try: () => sdk.Cursor.models.list({ apiKey: key }),
          catch: () => undefined,
        }).pipe(Effect.option)
        if (models._tag === 'None')
          return { ...base, authenticated: 'valid' as const, reason: 'Cursor model catalog could not be read' }
        return { ...base, authenticated: 'valid' as const, models: models.value.map((model) => model.id) }
      }),
    })
    return yield* RpcServer.make(CursorHostRpc, { concurrency: 'unbounded', disableTracing: true }).pipe(
      Effect.provide(CursorHostRpc.toLayer(handlers)),
      Effect.provide(RpcServer.layerProtocolStdio),
      Effect.provide(RpcSerialization.layerNdjson),
      Effect.provide(NodeStdio.layer),
      Effect.forkScoped,
      Effect.flatMap(Fiber.await),
      Effect.flatMap((exit) =>
        Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause) ? Effect.failCause(exit.cause) : Effect.void,
      ),
    )
  })

type Store = LocalAgentStore & { dispose(): Promise<void> }
export interface CursorHostDependencies {
  readonly processGroup: {
    readonly terminateChildren: Effect.Effect<void, CursorHostError>
    readonly waitQuiescent: (timeoutMs: number) => Effect.Effect<void, CursorHostError>
  }
  readonly runner: Effect.Success<ReturnType<typeof makeBatonCursorAgentSdkRunner>>
  readonly openStore: (mapping: NativeMapping) => Effect.Effect<Store, CursorHostError>
  readonly history: (
    mapping: NativeMapping,
    store: Store,
  ) => Effect.Effect<ReadonlyArray<NativeMessage>, CursorHostError>
  readonly probe: Effect.Effect<ProbeResult, CursorHostError>
}

export const makeCursorHostHandlers = (deps: CursorHostDependencies) =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const regular = Semaphore.makeUnsafe(7)
    const control = Semaphore.makeUnsafe(1)
    const events = yield* Queue.dropping<HostEvent, CursorHostError>(256)
    let mapping: NativeMapping | undefined
    let session: CursorAgentSdkSession | undefined
    let store: Store | undefined
    let generation = ''
    let sequence = 0
    let cancelled = false
    let closed = false
    let failed = false
    let sending = false
    let forceNextInput = false
    let executionTimeoutMs = 0
    let run: CursorAgentSdkRun | undefined
    const submitted = new Set<string>()
    const error = (message: string) => new CursorHostError({ message })
    const emit = (event: ExecutionEvent) =>
      Effect.gen(function* () {
        if (failed) return
        if (!(yield* Queue.offer(events, { generation, sequence: ++sequence, event }))) {
          failed = true
          yield* Queue.clear(events)
          yield* Queue.offer(events, {
            generation,
            sequence: ++sequence,
            event: { type: 'uncertain', reason: 'Cursor host event buffer overflow' },
          })
        }
      })
    const sdkFailure = (cause: unknown, operation: string): CursorHostError => {
      if (cause instanceof CursorHostError) return cause
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
    const cancelAndTerminate = (handle: CursorAgentSdkRun | undefined) =>
      Effect.gen(function* () {
        const results = yield* Effect.all(
          [
            Effect.exit(handle ? sdkCall(handle.cancel, 'cancel') : Effect.void),
            Effect.exit(deps.processGroup.terminateChildren),
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
    return CursorHostRpc.of({
      probe: () => regular.withPermit(sdkCall(deps.probe, 'probe')),
      history: (native) =>
        regular.withPermit(
          Effect.gen(function* () {
            const reader = yield* deps.openStore(native)
            return yield* sdkCall(
              persistedAgent(native, reader).pipe(Effect.andThen(deps.history(native, reader))),
              'history',
            ).pipe(Effect.ensuring(Effect.promise(() => reader.dispose())))
          }),
        ),
      open: ({ config, generation: processGeneration, mapping: existing }) =>
        regular.withPermit(
          Effect.gen(function* () {
            if (session || mapping || closed || cancelled)
              return yield* Effect.fail(error('Cursor host cannot open another session'))
            const base = yield* Effect.tryPromise({
              try: () => mappingFor(config, existing?.nativeSessionId ?? ''),
              catch: () => error('Invalid Cursor native mapping'),
            })
            if (existing && JSON.stringify(existing) !== JSON.stringify(base))
              return yield* Effect.fail(error('Cursor native mapping mismatch'))
            generation = processGeneration
            executionTimeoutMs = config.execution_timeout_seconds * 1000
            yield* Effect.tryPromise({
              try: async () => {
                await ensurePrivateDirectory(dirname(base.statePath))
                await ensurePrivateDirectory(base.storePath)
              },
              catch: () => error('Cursor private state is not accessible'),
            })
            store = yield* deps.openStore(base)
            if (existing) {
              const resumeStore = store
              const agent = yield* persistedAgent(existing, resumeStore)
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
              deps.runner.open({
                operation: existing ? 'resume' : 'create',
                ...(existing ? { agentId: existing.nativeSessionId } : {}),
                threadId: ThreadId.make(config.thread_id),
                providerSessionId: ProviderSessionId.make(config.thread_id),
                options: {
                  apiKey: process.env.CURSOR_API_KEY ?? '',
                  model: { id: config.model ?? config.adapter_config.model ?? 'default' },
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
            if (existing && session.agentId !== existing.nativeSessionId)
              return yield* Effect.fail(error('Cursor resumed a different native session'))
            mapping = { ...base, nativeSessionId: session.agentId }
            return mapping
          }),
        ),
      send: ({ message, preparation }) =>
        regular.withPermit(
          Effect.gen(function* () {
            if (!session || !mapping || !store || cancelled || closed || failed || sending || run)
              return yield* Effect.fail(error('Cursor cannot submit in its current state'))
            if (message.mode !== 'queue' || submitted.has(message.id))
              return yield* Effect.fail(error('Cursor input replay or steer is not supported'))
            yield* Effect.try({
              try: () => validatePreparation(message, mapping!, preparation),
              catch: () => error('Invalid Cursor preparation'),
            })
            submitted.add(message.id)
            sending = true
            const native = mapping
            const agent = session
            const localStore = store
            // The callback and wait fiber share this input, never the next input's mutable state.
            const identity = { nativeSessionId: native.nativeSessionId, messageId: message.id, executionId: '' }
            const assistant = { text: '', index: 0 }
            const earlyUpdates: InteractionUpdate[] = []
            let callbacksReady = false
            const update = (value: InteractionUpdate) =>
              Effect.gen(function* () {
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
              // Worker confirms the old tree stopped before resume. SDK force applies to this new input once.
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
                      if (callbacksReady) return yield* update(value)
                      if (earlyUpdates.length >= 256)
                        return yield* Effect.fail(error('Cursor startup event buffer overflow'))
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
                      yield* deps.processGroup.waitQuiescent(executionTimeoutMs)
                      yield* flush(identity, assistant)
                      yield* emit({
                        ...identity,
                        type: 'end',
                        outcome: result.status === 'finished' ? 'completed' : 'cancelled',
                      })
                    } else yield* emit({ type: 'uncertain', reason: 'Cursor native run failed' })
                  }),
                ),
                Effect.catchCause(() =>
                  emit({ type: 'uncertain', reason: 'Cursor native run termination is unknown' }),
                ),
                Effect.ensuring(
                  Effect.sync(() => {
                    if (run === handle) run = undefined
                  }),
                ),
                Effect.forkIn(scope),
              )
              // A handle can precede the first persisted checkpoint. Poll evidence without resubmitting input.
              while (true) {
                const history = yield* deps.history(native, localStore)
                const accepted = yield* Effect.try({
                  try: () => findSent(message, native, preparation, history),
                  catch: () => error('Cursor native evidence mismatch'),
                })
                if (accepted) return { nativeSessionId: native.nativeSessionId, executionId: handle.runId }
                yield* Effect.sleep('50 millis')
              }
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
        ),
      events: () =>
        Stream.unwrap(Effect.as(regular.take(1), Stream.fromQueue(events).pipe(Stream.ensuring(regular.release(1))))),
      abort: () => {
        // This handler runs outside the seven ordinary request permits.
        cancelled = true
        return control.withPermit(cancelAndTerminate(run))
      },
      close: () => {
        closed = true
        cancelled = true
        return control.withPermit(
          Effect.gen(function* () {
            yield* cancelAndTerminate(run)
            if (session) yield* sdkCall(session.close, 'close')
          }),
        )
      },
    })
  })
