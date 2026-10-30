import { realpath } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DateTime, Deferred, Effect, Queue, Schema, Scope, Semaphore, Stream } from 'effect'
import type {
  ModelSelection,
  OrchestrationV2AppThread,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderThread,
  OrchestrationV2TurnItem,
  OrchestrationV2RuntimeRequest,
  ProviderInstanceId,
  ProviderInteractionMode,
  ProviderTurnId,
  RunId,
} from '@t3tools/contracts'
import {
  MessageId as MessageIdSchema,
  OrchestrationV2TurnItem as TurnItemSchema,
  ProjectId,
  ThreadId,
} from '@t3tools/contracts'
import { isThreadAnswerAllowed, ThreadQuestion, type WorkerOpenConfig } from '@baton/protocol'
import * as IdAllocator from '@t3tools/provider-core/server/IdAllocator'
import * as ProviderAdapter from '@t3tools/provider-core/server/ProviderAdapter'
import { makeOutputMailbox } from '../worker/output.ts'
import { runningSteps } from '../worker/running-steps.ts'
import { ensurePrivateDirectory, readPrivateFile } from '../platform/private.ts'
import { findSent, validatePreparation, type SnapshotMessage } from './evidence.ts'
import { loadMapping, mappingFor, mappingThread, persistMapping, RuntimeModeConflict, statePath } from './mapping.ts'
import type { NativeMapping } from './mapping.ts'
import {
  AgentHostError,
  AgentHostProcessGroup,
  type AgentHostDriverShape,
  type ExecutionEvent,
  type ProbeResult,
} from './protocol.ts'
import { runtimeRequestDecision } from './runtime-request.ts'
import { modelRejectedBeforeInput } from './model.ts'

export interface ProviderHostDriverOptions {
  /** Shown in host errors. Credentials and SDK payloads stay out of the text. */
  readonly label: string
  readonly instanceId: ProviderInstanceId
  readonly adapter: ProviderAdapter.ProviderAdapterV2['Service']
  /** Upstream `supportsActiveSteering`. Queue-only agents reject steer here. */
  readonly steer: boolean
  readonly turnFailure?: (failure: OrchestrationV2ProviderFailure) => string
  /** Pi requires binding the native thread before its active-branch snapshot can be read. */
  readonly bindSnapshot?: boolean
  /** ACP must load the native session during openSession, before resumeThread or snapshot reads. */
  readonly resumeOnOpen?: boolean
  readonly snapshotMessages?: (
    snapshot: ProviderAdapter.ProviderAdapterV2ThreadSnapshot,
  ) => ReadonlyArray<SnapshotMessage>
  readonly interactionMode: ProviderInteractionMode
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
  readonly items: Map<string, OrchestrationV2TurnItem>
  readonly emittedItems: Set<string>
  tokenUsage?: typeof Schema.Json.Type
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
    const eventLock = yield* Semaphore.make(1)
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
    const requests = new Map<string, OrchestrationV2RuntimeRequest>()
    const requestTurns = new Map<string, ActiveTurn>()
    const questions = new Map<string, ThreadQuestion>()
    const questionTurns = new Map<string, ActiveTurn>()
    const published = new Set<string>()
    // 底层原因附在消息后面，跨进程传给 Worker 后仍能看出具体失败。
    const error = (message: string, cause?: unknown) =>
      new AgentHostError({
        message:
          cause === undefined
            ? message
            : `${message}: ${cause instanceof Error ? cause.message : JSON.stringify(cause)}`,
      })
    const fail = (operation: string, cause: unknown) =>
      cause instanceof AgentHostError ? cause : operationError(label, operation, cause)
    const mappingError = (cause: unknown) =>
      cause instanceof RuntimeModeConflict
        ? new AgentHostError({ message: 'runtime_mode_conflict' })
        : error(`${label} native mapping identity, working directory or profile mismatch`, cause)
    const emit = (event: ExecutionEvent) =>
      Effect.gen(function* () {
        if (event.type === 'delta') {
          output.offer({ ...event, replyId: event.id })
          return
        }
        yield* Queue.offer(control, event)
      })
    const identity = (turn: ActiveTurn) => ({
      nativeSessionId: mapping?.nativeSessionId ?? '',
      messageId: turn.messageId,
      executionId: turn.runId,
    })
    const publishQuestion = (id: string) =>
      Effect.gen(function* () {
        const request = requests.get(id)
        const question = questions.get(id)
        if (
          !request ||
          !question ||
          !active ||
          questionTurns.get(id) !== active ||
          requestTurns.get(id) !== active ||
          active.ended ||
          stopped ||
          closed ||
          published.has(id)
        )
          return
        published.add(id)
        yield* emit({ ...identity(active), type: 'question', question })
      })
    const answer = (request: OrchestrationV2RuntimeRequest) =>
      Effect.gen(function* () {
        if (request.status !== 'pending') {
          const owner = questionTurns.get(request.id)
          if (published.has(request.id) && owner && owner === active && !owner.ended)
            yield* emit({ ...identity(owner), type: 'question.resolved', requestId: request.id })
          requests.delete(request.id)
          requestTurns.delete(request.id)
          questions.delete(request.id)
          return
        }
        if (
          active &&
          !active.ended &&
          (!request.providerTurnId || !active.providerTurnId || request.providerTurnId === active.providerTurnId)
        ) {
          requests.set(request.id, request)
          requestTurns.set(request.id, active)
        }
        const decision = runtimeRequestDecision(request, stopped || closed || !active || active.ended)
        if (decision === undefined) {
          yield* publishQuestion(request.id)
          return
        }
        if (!session || decision === undefined || answered.has(request.id)) return
        answered.add(request.id)
        yield* session
          .respondToRuntimeRequest({
            requestId: request.id,
            decision,
            ...(request.kind === 'user_input' && label === 'Codex' ? { answers: {} } : {}),
          })
          .pipe(
            Effect.catch(() =>
              stopped || closed
                ? Effect.void
                : emit({ type: 'uncertain', reason: `${label} could not answer a runtime request` }),
            ),
          )
      })
    const toItem = (item: OrchestrationV2TurnItem) => ({
      id: item.id,
      type: item.type,
      status: item.status,
      ordinal: item.ordinal,
      ...(item.parentItemId === null ? {} : { parent_id: item.parentItemId }),
      ...(item.title === null ? {} : { title: item.title }),
      ...(item.startedAt === null ? {} : { started_at: DateTime.formatIso(item.startedAt) }),
      ...(item.completedAt === null ? {} : { completed_at: DateTime.formatIso(item.completedAt) }),
      data: Schema.encodeSync(Schema.toCodecJson(TurnItemSchema))(item),
    })
    const emitSnapshot = (turn: ActiveTurn) => {
      const snapshot = runningSteps([...turn.items.values()].map(toItem))
      output.offer({
        ...identity(turn),
        text: '',
        runningSteps: snapshot.steps,
        runningStepsTruncated: snapshot.truncated,
      })
    }
    const emitItem = (turn: ActiveTurn, item: OrchestrationV2TurnItem) => {
      turn.items.delete(item.id)
      turn.emittedItems.add(item.id)
      emitSnapshot(turn)
      return emit({ ...identity(turn), type: 'item', item: toItem(item) })
    }
    const flushItems = (turn: ActiveTurn) =>
      Effect.forEach(
        [...turn.items.values()].sort((a, b) => a.ordinal - b.ordinal),
        (item) => emitItem(turn, item),
        { discard: true },
      )
    const consume = (event: ProviderAdapter.ProviderAdapterV2Event) =>
      Effect.gen(function* () {
        if (event.type === 'runtime_request.updated') {
          yield* answer(event.runtimeRequest)
          return
        }
        if (closed) return
        switch (event.type) {
          case 'provider_session.updated': {
            if (active && !active.ended && event.providerSession.model)
              yield* emit({ ...identity(active), type: 'model', model: event.providerSession.model })
            return
          }
          case 'turn_item.updated': {
            const item = event.turnItem
            if (!active || active.ended || item.runId !== active.runId) return
            if (
              item.type !== 'assistant_message' &&
              item.type !== 'user_message' &&
              !active.emittedItems.has(item.id)
            ) {
              if (['completed', 'failed', 'cancelled', 'interrupted'].includes(item.status))
                yield* emitItem(active, item)
              else {
                active.items.set(item.id, item)
                emitSnapshot(active)
              }
            }
            if (item.type !== 'user_input_request' && item.type !== 'approval_request') return
            const question = yield* Schema.decodeUnknownEffect(ThreadQuestion)({
              request_id: item.requestId,
              kind:
                item.type === 'user_input_request'
                  ? 'user_input'
                  : item.requestKind === 'mcp-elicitation'
                    ? 'mcp-elicitation'
                    : 'approval',
              questions: item.type === 'user_input_request' ? item.questions : [],
              ...(item.type === 'approval_request' ? { prompt: item.prompt ?? item.reason ?? 'Continue?' } : {}),
              ...(item.type === 'approval_request' && item.requestKind !== 'mcp-elicitation'
                ? {
                    request_kind: item.requestKind,
                    ...(item.reason === undefined ? {} : { reason: item.reason }),
                    ...(item.options === undefined ? {} : { options: item.options }),
                    ...(item.fullAccessOverride === undefined ? {} : { full_access_override: item.fullAccessOverride }),
                  }
                : {}),
            }).pipe(Effect.mapError(() => error(`${label} question exceeds the supported format`)))
            questions.set(item.requestId, question)
            questionTurns.set(item.requestId, active)
            yield* publishQuestion(item.requestId)
            return
          }
          case 'provider_turn.updated': {
            const turn = event.providerTurn
            if (!active || active.ended || turn.runAttemptId !== active.attemptId) return
            if (turn.tokenUsage !== undefined)
              active.tokenUsage = Schema.decodeUnknownSync(Schema.Json)(turn.tokenUsage)
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
            if (!active || active.ended || event.runOrdinal !== active.ordinal) return
            active.ended = true
            yield* flushItems(active)
            if (event.status === 'failed') {
              yield* emit({
                ...identity(active),
                type: 'end',
                outcome: 'failed',
                ...(active.tokenUsage === undefined ? {} : { tokenUsage: active.tokenUsage }),
                reason:
                  options.turnFailure?.(event.failure) ?? `Send your message again or check ${label} on this device.`,
              })
              return
            }
            yield* emit({
              ...identity(active),
              type: 'end',
              outcome: event.status === 'completed' ? 'completed' : 'cancelled',
              ...(active.tokenUsage === undefined ? {} : { tokenUsage: active.tokenUsage }),
            })
            return
          }
          default:
            return
        }
      })
    const consumeEvents = (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime) =>
      runtime.events.pipe(
        Stream.runForEach((event) => eventLock.withPermit(consume(event))),
        Effect.catchCause(() =>
          stopped || closed ? Effect.void : emit({ type: 'uncertain', reason: `${label} session event stream failed` }),
        ),
        Effect.forkIn(scope),
      )
    const authorize = (input: WorkerOpenConfig) =>
      Effect.gen(function* () {
        const cwd = yield* Effect.tryPromise({
          try: () => realpath(input.working_directory),
          catch: (cause) => error(`${label} working directory is not accessible`, cause),
        })
        return {
          threadId: ThreadId.make(input.thread_id),
          providerSessionId: idAllocator.derive.providerSession({ providerInstanceId: options.instanceId }),
          selection: options.model(input),
          policy: { cwd, runtimeMode: input.runtime_mode, interactionMode: options.interactionMode },
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
        runtimeMode: input.runtime_mode,
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
          catch: (cause) => error(`Invalid ${label} native mapping`, cause),
        })
        yield* Effect.tryPromise({
          try: () => ensurePrivateDirectory(dirname(statePath(input, label))),
          catch: (cause) => error(`${label} private state is not accessible`, cause),
        })
        yield* Effect.tryPromise({
          try: () => persistMapping(next),
          catch: (cause) => error(`${label} native mapping could not be persisted`, cause),
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
            catch: mappingError,
          })
          const authorized = yield* authorize(input)
          const runtime = yield* options.adapter
            .openSession({
              threadId: authorized.threadId,
              providerSessionId: authorized.providerSessionId,
              modelSelection: authorized.selection,
              runtimePolicy: authorized.policy,
              ...(options.resumeOnOpen ? { initialNativeThreadId: stored.nativeSessionId } : {}),
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
      answer: (input) =>
        Effect.gen(function* () {
          const request = requests.get(input.request_id)
          if (
            !session ||
            stopped ||
            closed ||
            !active ||
            active.ended ||
            !request ||
            questionTurns.get(input.request_id) !== active ||
            requestTurns.get(input.request_id) !== active ||
            !published.has(input.request_id) ||
            answered.has(input.request_id)
          )
            return yield* error(`${label} question is no longer pending`)
          const question = questions.get(input.request_id)
          if (!question || !isThreadAnswerAllowed(question, input))
            return yield* error(`${label} question decision is not offered`)
          answered.add(input.request_id)
          yield* session
            .respondToRuntimeRequest({
              requestId: request.id,
              decision: input.decision,
              ...(request.kind === 'user_input'
                ? input.decision === 'accept'
                  ? { answers: input.answers ?? {} }
                  : label === 'Codex'
                    ? { answers: {} }
                    : {}
                : {}),
            })
            .pipe(Effect.mapError((cause) => fail('answer question', cause)))
          yield* emit({ ...identity(active), type: 'question.resolved', requestId: request.id })
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
          const agentType = config.agent_type
          const selectedModel = options.model(
            message.model === undefined ? config : { ...config, model: message.model },
          )
          const selection = message.thinking
            ? {
                ...selectedModel,
                options: [
                  ...(selectedModel.options ?? []).filter((option) => option.id !== message.thinking!.id),
                  { id: message.thinking.id, value: message.thinking.value },
                ],
              }
            : selectedModel
          const policy = (yield* authorize(config)).policy
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
          const turn: ActiveTurn = {
            messageId: message.id,
            runId,
            attemptId,
            ordinal,
            started,
            ended: false,
            items: new Map(),
            emittedItems: new Set(),
          }
          active = turn
          streams.clear()
          replied.clear()
          yield* session
            .startTurn({
              appThread: { ...appThread, modelSelection: selection },
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
              Effect.mapError((cause) => {
                if (!modelRejectedBeforeInput(agentType, cause)) return fail('start turn', cause)
                turn.ended = true
                return new AgentHostError({
                  message: `${label} rejected the selected model before submitting the message; choose another model`,
                  modelRejected: true,
                })
              }),
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
            catch: mappingError,
          })
          const authorized = yield* authorize(input)
          const snapshot = yield* Effect.scoped(
            Effect.gen(function* () {
              const runtime = yield* options.adapter.openSession({
                threadId: authorized.threadId,
                providerSessionId: authorized.providerSessionId,
                modelSelection: authorized.selection,
                runtimePolicy: authorized.policy,
                ...(options.resumeOnOpen ? { initialNativeThreadId: stored.nativeSessionId } : {}),
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
            Stream.flatMap((event) =>
              Stream.fromIterable<ExecutionEvent>([
                ...(event.runningSteps === undefined
                  ? []
                  : [
                      {
                        nativeSessionId: event.nativeSessionId,
                        messageId: event.messageId,
                        executionId: event.executionId,
                        type: 'running_steps' as const,
                        steps: event.runningSteps,
                        truncated: event.runningStepsTruncated ?? false,
                      },
                    ]),
                ...(event.text || event.gap || event.runningSteps === undefined
                  ? [
                      {
                        nativeSessionId: event.nativeSessionId,
                        messageId: event.messageId,
                        executionId: event.executionId,
                        type: 'delta' as const,
                        id: event.replyId ?? event.executionId,
                        text: event.text,
                        ...(event.gap === undefined ? {} : { gap: event.gap }),
                      },
                    ]
                  : []),
              ]),
            ),
          ),
        ),
      ),
      flushEvents: (id) =>
        eventLock.withPermit(
          Effect.gen(function* () {
            if (active && !active.ended) yield* flushItems(active)
            yield* emit({ type: 'barrier', id })
          }),
        ),
      abort: Effect.gen(function* () {
        stopped = true
        yield* eventLock.withPermit(Effect.suspend(() => (active && !active.ended ? flushItems(active) : Effect.void)))
        yield* Effect.forEach(requests.values(), (request) => answer(request), {
          concurrency: 'unbounded',
          discard: true,
        }).pipe(Effect.timeout('1 second'), Effect.ignore)
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
        yield* eventLock.withPermit(Effect.suspend(() => (active && !active.ended ? flushItems(active) : Effect.void)))
        closed = true
        stopped = true
        yield* Effect.forEach(requests.values(), (request) => answer(request), {
          concurrency: 'unbounded',
          discard: true,
        }).pipe(Effect.timeout('1 second'), Effect.ignore)
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
