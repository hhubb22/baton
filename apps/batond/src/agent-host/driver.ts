import { realpath } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DateTime, Deferred, Effect, Queue, Scope, Stream } from 'effect'
import type {
  ModelSelection,
  OrchestrationV2AppThread,
  OrchestrationV2ProviderThread,
  OrchestrationV2RuntimeRequest,
  ProviderInstanceId,
  ProviderInteractionMode,
  ProviderTurnId,
  RunId,
  RuntimeMode,
} from '@t3tools/contracts'
import { MessageId as MessageIdSchema, ProjectId, ThreadId } from '@t3tools/contracts'
import type { WorkerOpenConfig } from '@baton/protocol'
import * as IdAllocator from '@t3tools/provider-core/server/IdAllocator'
import * as ProviderAdapter from '@t3tools/provider-core/server/ProviderAdapter'
import { makeOutputMailbox } from '../worker/output.ts'
import { ensurePrivateDirectory, readPrivateFile } from '../platform/private.ts'
import { findSent, validatePreparation, type SnapshotMessage } from './evidence.ts'
import { loadMapping, mappingFor, mappingThread, persistMapping, statePath } from './mapping.ts'
import type { NativeMapping } from './mapping.ts'
import {
  AgentHostError,
  AgentHostProcessGroup,
  type AgentHostDriverShape,
  type ExecutionEvent,
  type ProbeResult,
} from './protocol.ts'
import { runtimeRequestDecision } from './runtime-request.ts'

export interface ProviderHostDriverOptions {
  /** Shown in host errors. Credentials and SDK payloads stay out of the text. */
  readonly label: string
  readonly instanceId: ProviderInstanceId
  readonly adapter: ProviderAdapter.ProviderAdapterV2['Service']
  /** Upstream `supportsActiveSteering`. Queue-only agents reject steer here. */
  readonly steer: boolean
  /** Pi requires binding the native thread before its active-branch snapshot can be read. */
  readonly bindSnapshot?: boolean
  readonly snapshotMessages?: (
    snapshot: ProviderAdapter.ProviderAdapterV2ThreadSnapshot,
  ) => ReadonlyArray<SnapshotMessage>
  readonly runtimeMode: RuntimeMode
  readonly interactionMode: ProviderInteractionMode
  readonly runtimePolicy: (cwd: string) => ProviderAdapter.ProviderAdapterV2RuntimePolicy
  readonly model: (config: WorkerOpenConfig) => ModelSelection
  /** Dependencies are provided by the caller, so this effect's requirements are empty. */
  readonly probe: Effect.Effect<ProbeResult, AgentHostError>
  /** Overrides the default `Baton <thread>` session title. Replay uses the recorded name. */
  readonly sessionTitle?: string
}

interface ActiveTurn {
  readonly messageId: string
  readonly runId: RunId
  readonly attemptId: string
  readonly ordinal: number
  readonly started: Deferred.Deferred<ProviderTurnId>
  providerTurnId?: ProviderTurnId
  ended: boolean
}

const operationError = (label: string, operation: string, cause: unknown) => {
  const tags: string[] = []
  let current: unknown = cause
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const tag: unknown = Reflect.get(current, '_tag') ?? Reflect.get(current, 'name')
    if (typeof tag === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(tag)) tags.push(tag)
    current = Reflect.get(current, 'cause')
  }
  return new AgentHostError({ message: `${label} ${operation} failed (${tags.join(' > ') || 'unknown'})` })
}

/** Map one `ProviderAdapterV2` onto the Agent host driver. */
export const makeProviderHostDriver = (options: ProviderHostDriverOptions) =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const processGroup = yield* AgentHostProcessGroup
    const idAllocator = yield* IdAllocator.IdAllocatorV2
    const { label } = options
    const control = yield* Queue.bounded<ExecutionEvent, AgentHostError>(256)
    const output = makeOutputMailbox()
    let mapping: NativeMapping | undefined
    let config: WorkerOpenConfig | undefined
    let providerThread: OrchestrationV2ProviderThread | undefined
    let session: ProviderAdapter.ProviderAdapterV2SessionRuntime | undefined
    let appThread: OrchestrationV2AppThread | undefined
    let active: ActiveTurn | undefined
    let ordinal = 0
    let closed = false
    let stopped = false
    const streams = new Map<string, string>()
    const replied = new Set<string>()
    const answered = new Set<string>()
    const error = (message: string) => new AgentHostError({ message })
    const fail = (operation: string, cause: unknown) =>
      cause instanceof AgentHostError ? cause : operationError(label, operation, cause)
    const emit = (event: ExecutionEvent) =>
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
    const answer = (request: OrchestrationV2RuntimeRequest) =>
      Effect.gen(function* () {
        const decision = runtimeRequestDecision(request, stopped || closed)
        if (!session || decision === undefined || answered.has(request.id)) return
        answered.add(request.id)
        yield* session
          .respondToRuntimeRequest({
            requestId: request.id,
            decision,
            ...(request.kind === 'user_input' ? { answers: {} } : {}),
          })
          .pipe(
            Effect.catch(() =>
              stopped || closed
                ? Effect.void
                : emit({ type: 'uncertain', reason: `${label} could not answer a runtime request` }),
            ),
          )
      })
    const consume = (event: ProviderAdapter.ProviderAdapterV2Event) =>
      Effect.gen(function* () {
        if (event.type === 'runtime_request.updated') {
          yield* answer(event.runtimeRequest)
          return
        }
        if (closed) return
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
              yield* emit({ type: 'uncertain', reason: `${label} turn failed` })
              return
            }
            yield* emit({
              ...identity(active),
              type: 'end',
              outcome: event.status === 'completed' ? 'completed' : 'cancelled',
            })
            return
          }
          default:
            return
        }
      })
    const consumeEvents = (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime) =>
      runtime.events.pipe(
        Stream.runForEach(consume),
        Effect.catchCause(() =>
          stopped || closed ? Effect.void : emit({ type: 'uncertain', reason: `${label} session event stream failed` }),
        ),
        Effect.forkIn(scope),
      )
    const authorize = (input: WorkerOpenConfig) =>
      Effect.gen(function* () {
        const cwd = yield* Effect.tryPromise({
          try: () => realpath(input.working_directory),
          catch: () => error(`${label} working directory is not accessible`),
        })
        return {
          threadId: ThreadId.make(input.thread_id),
          providerSessionId: idAllocator.derive.providerSession({ providerInstanceId: options.instanceId }),
          selection: options.model(input),
          policy: options.runtimePolicy(cwd),
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
        title: options.sessionTitle ?? `Baton ${input.thread_id}`,
        providerInstanceId: options.instanceId,
        modelSelection: selection,
        runtimeMode: options.runtimeMode,
        interactionMode: options.interactionMode,
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
        if (!nativeSessionId) return yield* error(`${label} provider thread has no native session id`)
        const next = yield* Effect.tryPromise({
          try: () => mappingFor(input, nativeSessionId, thread, label),
          catch: () => error(`Invalid ${label} native mapping`),
        })
        yield* Effect.tryPromise({
          try: () => ensurePrivateDirectory(dirname(statePath(input, label))),
          catch: () => error(`${label} private state is not accessible`),
        })
        yield* Effect.tryPromise({
          try: () => persistMapping(next),
          catch: () => error(`${label} native mapping could not be persisted`),
        })
        mapping = next
        providerThread = thread
        session = runtime
        config = input
        ordinal = 0
        appThread = appThreadFor(input, selection, yield* DateTime.now)
        return { nativeSessionId }
      })
    const driver: AgentHostDriverShape = {
      probe: options.probe,
      open: ({ config: input }) =>
        Effect.gen(function* () {
          if (session || providerThread || closed || stopped)
            return yield* error(`${label} host cannot open another session`)
          const exists = yield* Effect.promise(() =>
            readPrivateFile(statePath(input, label)).then(
              () => true,
              () => false,
            ),
          )
          if (exists) return yield* error(`${label} mapping already exists; resume explicitly`)
          const authorized = yield* authorize(input)
          const runtime = yield* options.adapter
            .openSession({
              threadId: authorized.threadId,
              providerSessionId: authorized.providerSessionId,
              modelSelection: authorized.selection,
              runtimePolicy: authorized.policy,
            })
            .pipe(
              Effect.provideService(Scope.Scope, scope),
              Effect.mapError((cause) => fail('open', cause)),
            )
          const thread = yield* runtime
            .ensureThread({
              threadId: authorized.threadId,
              modelSelection: authorized.selection,
              runtimePolicy: authorized.policy,
              providerSessionId: authorized.providerSessionId,
            })
            .pipe(Effect.mapError((cause) => fail('ensure thread', cause)))
          const result = yield* attach(input, runtime, thread, authorized.selection)
          yield* consumeEvents(runtime)
          return result
        }),
      resume: ({ config: input, nativeSessionId }) =>
        Effect.gen(function* () {
          if (session || providerThread || closed || stopped)
            return yield* error(`${label} host cannot open another session`)
          const stored = yield* Effect.tryPromise({
            try: () => loadMapping(input, nativeSessionId, label),
            catch: () => error(`${label} native mapping identity, working directory or profile mismatch`),
          })
          const authorized = yield* authorize(input)
          const runtime = yield* options.adapter
            .openSession({
              threadId: authorized.threadId,
              providerSessionId: authorized.providerSessionId,
              modelSelection: authorized.selection,
              runtimePolicy: authorized.policy,
            })
            .pipe(
              Effect.provideService(Scope.Scope, scope),
              Effect.mapError((cause) => fail('resume', cause)),
            )
          const thread = yield* runtime
            .resumeThread({
              providerThread: mappingThread(stored),
              threadId: authorized.threadId,
              modelSelection: authorized.selection,
              runtimePolicy: authorized.policy,
            })
            .pipe(Effect.mapError((cause) => fail('resume thread', cause)))
          const result = yield* attach(input, runtime, thread, authorized.selection)
          yield* consumeEvents(runtime)
          return result
        }),
      send: ({ message, preparation }) =>
        Effect.gen(function* () {
          if (!session || !providerThread || !mapping || !config || !appThread || closed || stopped)
            return yield* error(`${label} cannot submit in its current state`)
          yield* Effect.try({
            try: () => validatePreparation(message, preparation),
            catch: (cause) => (cause instanceof AgentHostError ? cause : error(`Invalid ${label} preparation`)),
          })
          const threadId = ThreadId.make(config.thread_id)
          const selection = options.model(config)
          const policy = options.runtimePolicy((yield* authorize(config)).cwd)
          if (message.mode === 'steer') {
            if (!options.steer) return yield* error(`${label} does not support steer`)
            const turn = active
            if (!turn || turn.ended || !turn.providerTurnId) return yield* error(`${label} has no active turn to steer`)
            yield* session
              .steerTurn({
                threadId,
                runId: turn.runId,
                providerThread,
                providerTurnId: turn.providerTurnId,
                message: {
                  messageId: MessageIdSchema.make(`message:baton:${message.id}`),
                  text: message.text,
                  attachments: [],
                  createdBy: 'user',
                  creationSource: 'server',
                },
              })
              .pipe(
                Effect.timeout('30 seconds'),
                Effect.mapError((cause) => fail('steer turn', cause)),
              )
            return { nativeSessionId: mapping.nativeSessionId, executionId: turn.runId }
          }
          if (active && !active.ended) return yield* error(`${label} turn is still active`)
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
              Effect.mapError((cause) => fail('start turn', cause)),
            )
          const turnId = yield* Deferred.await(started).pipe(
            Effect.timeout('5 seconds'),
            Effect.match({ onFailure: () => undefined, onSuccess: (value) => value }),
          )
          if (turnId) turn.providerTurnId = turnId
          return { nativeSessionId: mapping.nativeSessionId, executionId: runId }
        }),
      sent: ({ config: input, message, preparation }) =>
        Effect.gen(function* () {
          const stored = yield* Effect.tryPromise({
            try: () => loadMapping(input, preparation.nativeSessionId, label),
            catch: () => error(`${label} native mapping identity, working directory or profile mismatch`),
          })
          const authorized = yield* authorize(input)
          const snapshot = yield* Effect.scoped(
            Effect.gen(function* () {
              const runtime = yield* options.adapter.openSession({
                threadId: authorized.threadId,
                providerSessionId: authorized.providerSessionId,
                modelSelection: authorized.selection,
                runtimePolicy: authorized.policy,
              })
              const storedThread = mappingThread(stored)
              const thread = options.bindSnapshot
                ? yield* runtime.resumeThread({
                    providerThread: storedThread,
                    threadId: authorized.threadId,
                    modelSelection: authorized.selection,
                    runtimePolicy: authorized.policy,
                  })
                : storedThread
              return yield* runtime.readThreadSnapshot({ providerThread: thread }).pipe(Effect.timeout('30 seconds'))
            }),
          ).pipe(Effect.mapError((cause) => fail('read snapshot', cause)))
          const messages =
            options.snapshotMessages?.(snapshot) ??
            snapshot.messages.flatMap((entry) =>
              entry.role === 'user' || entry.role === 'assistant'
                ? [{ id: entry.id, role: entry.role, text: entry.text }]
                : [],
            )
          return yield* Effect.try({
            try: () => findSent(message, preparation, messages),
            catch: (cause) => (cause instanceof AgentHostError ? cause : error(`${label} input evidence is invalid`)),
          })
        }),
      events: Stream.fromQueue(control).pipe(
        Stream.merge(
          output.stream.pipe(
            Stream.map((event): ExecutionEvent => ({
              ...event,
              type: 'delta',
              id: event.executionId,
            })),
          ),
        ),
      ),
      abort: Effect.gen(function* () {
        stopped = true
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
        stopped = true
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
        stopped = true
      }),
    )
    return driver
  })
