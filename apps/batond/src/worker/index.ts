import { createHash, randomUUID } from 'node:crypto'
import { upgradePaused, readUpgradeState, upgradeOffline } from '../daemon/upgrade.ts'
import {
  WorkerRequest,
  boundedText,
  type ThreadReport,
  type WorkerCommandReceipt,
  type WorkerCommandAction,
  type WorkerIPCMessage,
  type WorkerOpenConfig,
} from '@baton/protocol'
import { CommitUnknown } from '@baton/sqlite'
import { HttpTraceContext } from 'effect/http'
import { captureTrace, traceParent, waitEvent, withTraceSpan } from '@baton/telemetry'
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Queue,
  Schema,
  Scope,
  Stream,
  Tracer,
} from 'effect'
import type { ProcessRecord } from '../platform/process-types.ts'
import { agentCatalog } from '../agents/catalog.ts'
import {
  AgentError,
  type AgentEvent,
  type AgentFactory,
  type AgentOutput,
  type InputAcceptance,
  type ThreadAgent,
} from './agent.ts'
import { OutputBuffer } from './output.ts'
import { boundReason, displayText, pendingResult } from './reports.ts'
import {
  openWorkerLedger,
  WorkerFailure,
  type Command,
  type Message,
  type Outcome,
  type OutboxEntry,
  type State,
} from './ledger.ts'

export * from './agent.ts'
export { WorkerFailure } from './ledger.ts'

export interface WorkerOptions {
  readonly dbPath: string
  readonly dataDirectory?: string
  readonly agentFactory: AgentFactory
  readonly openTimeoutMs?: number
  readonly prepareTimeoutMs?: number
  readonly sendTimeoutMs?: number
  readonly stopTimeoutMs?: number
  readonly recoverProcesses?: (
    records: readonly ProcessRecord[],
  ) => Effect.Effect<{ readonly processTreeStopped: boolean }, AgentError>
  readonly attachments?: (
    config: WorkerOpenConfig,
    text: string,
  ) => Effect.Effect<NonNullable<ThreadReport['attachments']>, AgentError>
}
export interface Worker {
  /** Authentication and the exclusive process lock belong to the IPC/platform owner. */
  readonly handle: (request: WorkerRequest) => Effect.Effect<WorkerIPCMessage, WorkerFailure>
  readonly drain: Effect.Effect<boolean, WorkerFailure>
  /** Fails once execution is frozen; the owner must exit the Scope and release the Worker lock. */
  readonly failed: Effect.Effect<never, WorkerFailure>
  readonly records: {
    readonly add: (record: ProcessRecord) => Effect.Effect<void, WorkerFailure>
    readonly remove: (record: ProcessRecord) => Effect.Effect<void, WorkerFailure>
    readonly list: () => Effect.Effect<readonly ProcessRecord[], WorkerFailure>
  }
}
interface Operation {
  readonly id: string
  readonly epoch: number
  readonly kind: 'open' | 'resume' | 'prepare' | 'send' | 'recover' | 'cleanup' | 'answer'
  readonly messageId?: string
  fiber?: Fiber.Fiber<void>
}

/** Only confirmed queue submissions advance the inherited model. */
const modelConfig = (config: WorkerOpenConfig, messages: readonly Message[]): WorkerOpenConfig => {
  const latest = messages
    .filter(
      (message) => message.state === 'sent' && message.input.mode === 'queue' && message.input.model !== undefined,
    )
    .sort((left, right) => (right.turn ?? 0) - (left.turn ?? 0))[0]
  return latest?.input.model === undefined ? config : { ...config, model: latest.input.model }
}

const terminalMessage = (message: Message): Outcome | undefined => {
  switch (message.state) {
    case 'sent':
      return 'succeeded'
    case 'withdrawn':
      return 'cancelled'
    case 'unknown':
      return 'unknown'
    default:
      return undefined
  }
}
const canonical = (value: unknown): string => {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
const safeReplyId = (id: string) =>
  Buffer.byteLength(id) > 512 || id.startsWith('baton:reply:sha256:') || displayText(id) !== id
    ? `baton:reply:sha256:${digest(id)}`
    : id
const reasonOf = (value: unknown) => boundReason(value instanceof Error ? value.message : String(value))
const reject = (code: string, message: string): never => {
  throw new WorkerFailure(code, message)
}

const isPending = (command: Command) => command.status.state === 'accepted' || command.status.state === 'running'

const commandAction = (type: string): WorkerCommandAction | undefined => {
  switch (type) {
    case 'thread_open':
      return 'open'
    case 'thread_resume':
      return 'resume'
    case 'thread_message':
      return 'message'
    case 'thread_answer':
      return 'answer'
    case 'thread_settings':
      return 'settings'
    case 'thread_stop':
      return 'stop'
    case 'thread_withdraw':
      return 'withdraw'
    default:
      return undefined
  }
}

export const makeWorker = Effect.fn('Worker.make')(function* (options: WorkerOptions) {
  const parentScope = yield* Effect.scope
  const scope = yield* Scope.make()
  const clock = yield* Clock.Clock
  const tracer = yield* Tracer.Tracer
  const turns = new Map<string, { span: Tracer.Span; started: number; output: boolean; usage: boolean }>()
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const { span } of turns.values()) {
        span.attribute('baton.turn.result', 'lost')
        span.end(clock.currentTimeNanosUnsafe(), Exit.void)
      }
      turns.clear()
    }),
  )
  const ledger = yield* openWorkerLedger({
    dbPath: options.dbPath,
    ...(options.dataDirectory === undefined ? {} : { dataDirectory: options.dataDirectory }),
  }).pipe(Effect.mapError((cause) => new WorkerFailure('storage_error', 'Cannot open Worker ledger', cause)))
  let state = ledger.initial
  const jobs = yield* Queue.unbounded<Effect.Effect<void>>()
  const fatal = yield* Deferred.make<never, WorkerFailure>()
  let agent: ThreadAgent | undefined
  const ownedAgents = new Set<ThreadAgent>()
  let operation: Operation | undefined
  let stopFiber: Fiber.Fiber<void> | undefined
  let eventsFiber: Fiber.Fiber<void> | undefined
  let outputFiber: Fiber.Fiber<void> | undefined
  const output = new OutputBuffer()
  let outputTurn: string | undefined
  let outputExecution: string | undefined
  let outputReplyId: string | undefined
  let stopEvidence: Deferred.Deferred<void> | undefined
  let frozen: WorkerFailure | undefined
  let closed = false
  let closing = false
  let recovering = true
  let uncertaintyCleanup = false
  let unknownRecoveryRunning = false
  let turnTimer: { messageId: string; turn: number; budget: number; fiber: Fiber.Fiber<void> } | undefined
  let reclaimedOnRecovery = false
  const buffered: AgentEvent[] = []
  const waiting = new Set<(failure: WorkerFailure) => Effect.Effect<void>>()
  const openMs = options.openTimeoutMs ?? 35_000
  const prepareMs = options.prepareTimeoutMs ?? 10_000
  const sendMs = options.sendTimeoutMs ?? 35_000
  const paused = Effect.tryPromise({
    try: () => upgradePaused(options.dataDirectory),
    catch: (cause) => new WorkerFailure('upgrade_state_invalid', '无法读取升级门禁', cause),
  })
  const stopMs = options.stopTimeoutMs ?? 60_000

  function report(
    draft: State,
    kind: ThreadReport['kind'],
    fields: Partial<ThreadReport> = {},
    replyEvidence?: OutboxEntry['replyEvidence'],
  ) {
    const config = draft.config
    if (!config) return
    const messageId =
      fields.client_message_id ??
      (fields.command_id ? draft.commands[fields.command_id]?.messageId : undefined) ??
      draft.activeMessage
    const message = messageId ? draft.messages[messageId] : undefined
    const turn = messageId ? turns.get(messageId) : undefined
    const trace = turn
      ? {
          traceparent: HttpTraceContext.toHeaders(turn.span).traceparent!,
          ...(message?.trace_context?.tracestate ? { tracestate: message.trace_context.tracestate } : {}),
        }
      : message?.trace_context
    draft.outbox.push({
      acked: false,
      ...(replyEvidence ? { replyEvidence } : {}),
      ...(kind === 'turn.item' && fields.item ? { itemId: fields.item.id } : {}),
      report: {
        type: 'thread.report',
        ...(trace ? { trace_context: trace } : {}),
        thread_id: config.thread_id,
        storage_generation: config.storage_generation,
        event_id: randomUUID(),
        worker_seq: draft.outbox.length + 1,
        kind,
        ...(kind === 'turn.ended'
          ? { queue_empty: !Object.values(draft.messages).some((message) => message.state === 'queued') }
          : {}),
        ...fields,
      },
    })
  }
  function finish(draft: State, command: Command, outcome: Outcome, reason = '') {
    if (!isPending(command)) return
    reason = boundReason(reason)
    command.status = { command_id: command.receipt.command_id, state: outcome, command_outcome: outcome, reason }
    report(draft, 'command.completed', { command_id: command.receipt.command_id, command_outcome: outcome, reason })
  }
  function finishMessages(draft: State, messageId: string, outcome: Outcome, reason = '') {
    for (const command of Object.values(draft.commands)) {
      if (command.receipt.action === 'message' && command.messageId === messageId)
        finish(draft, command, outcome, reason)
    }
  }
  function settleMessage(draft: State, message: Message, outcome: Outcome, reason = '') {
    if (terminalMessage(message)) return
    message.state = outcome === 'succeeded' ? 'sent' : outcome === 'unknown' ? 'unknown' : 'withdrawn'
    message.reason = reason
    report(
      draft,
      outcome === 'succeeded' ? 'message.sent' : outcome === 'unknown' ? 'message.unknown' : 'message.withdrawn',
      {
        client_message_id: message.input.id,
        ...(message.turn === undefined ? {} : { worker_turn_seq: message.turn }),
        reason,
      },
    )
    finishMessages(draft, message.input.id, outcome, reason)
  }
  function withdrawQueued(draft: State, reason: string) {
    for (const message of Object.values(draft.messages)) {
      if (message.state === 'queued') settleMessage(draft, message, 'cancelled', reason)
    }
  }
  function cancelQuestions(draft: State, reason: string) {
    for (const question of draft.questions ?? []) {
      if (question.state === 'resolved' || question.state === 'cancelled') continue
      const outcome = question.state === 'intent' ? 'unknown' : 'cancelled'
      question.state = 'cancelled'
      report(draft, 'question.resolved', {
        request_id: question.question.request_id,
        worker_turn_seq: question.turn,
        reason,
      })
      const command = question.commandId ? draft.commands[question.commandId] : undefined
      if (command) finish(draft, command, outcome, reason)
    }
  }
  function endActive(draft: State, reason: string) {
    cancelQuestions(draft, reason)
    const active = draft.activeMessage ? draft.messages[draft.activeMessage] : undefined
    if (active?.state !== 'sent' || active.ended) return
    active.ended = true
    report(draft, 'turn.ended', {
      client_message_id: active.input.id,
      worker_turn_seq: active.turn!,
      reason,
      ...(active.tokenUsage === undefined ? {} : { token_usage: active.tokenUsage }),
    })
    delete draft.activeMessage
  }
  function finishUnknown(draft: State) {
    endActive(draft, draft.stopReason ?? 'agent_exited')
    if (draft.unknownReason !== undefined) {
      report(draft, 'thread.unknown', { reason: draft.unknownReason })
      delete draft.unknownReason
    }
  }
  function requestStop(draft: State, reason: 'stopped' | 'timeout') {
    if (draft.phase === 'stopping') return
    draft.epoch++
    draft.stopStartedNs = process.hrtime.bigint().toString()
    draft.stopReason = reason
    draft.phase = draft.phase === 'unknown' ? 'unknown' : 'stopping'
    draft.resumeRequested = false
    withdrawQueued(draft, reason === 'timeout' ? 'timeout' : 'Stopped before input intent')
    cancelQuestions(draft, reason)
    for (const previous of Object.values(draft.commands)) {
      if (!isPending(previous)) continue
      if (previous.receipt.action === 'open') {
        report(draft, 'thread.open_failed', { reason: 'Startup was stopped' })
        finish(draft, previous, 'cancelled', 'Startup was stopped')
      }
      if (previous.receipt.action === 'resume') finish(draft, previous, 'cancelled', 'Resume was stopped')
    }
  }
  function markUnknown(draft: State, reason: string, settleInputs = true) {
    for (const message of Object.values(draft.messages)) {
      if (message.state === 'intent' && (settleInputs || message.input.mode === 'steer'))
        settleMessage(draft, message, 'unknown', reason)
    }
    if (draft.phase !== 'unknown') {
      draft.phase = 'unknown'
      draft.epoch++
      draft.resumeRequested = false
      draft.processTreeStopped = false
      withdrawQueued(draft, 'Execution became uncertain before input intent')
      cancelQuestions(draft, reason)
      const active = draft.activeMessage ? draft.messages[draft.activeMessage] : undefined
      if (active && !active.ended && (active.state === 'sent' || active.state === 'intent'))
        draft.unknownReason = boundReason(reason)
      else {
        endActive(draft, draft.stopReason ?? 'agent_exited')
        report(draft, 'thread.unknown', { reason })
      }
    }
    for (const command of Object.values(draft.commands)) {
      if (command.receipt.action !== 'message') finish(draft, command, 'unknown', reason)
    }
  }
  function freeze(cause: unknown): Effect.Effect<void> {
    return Effect.gen(function* () {
      if (frozen) return
      frozen =
        cause instanceof WorkerFailure
          ? cause
          : new WorkerFailure(
              cause instanceof CommitUnknown ? 'commit_unknown' : 'storage_error',
              'Worker execution stopped; reopen and reconcile the ledger',
              cause,
            )
      operation = undefined
      yield* Deferred.fail(fatal, frozen)
      yield* Effect.forkIn(
        Effect.gen(function* () {
          yield* Scope.close(scope, Exit.void)
          for (const current of ownedAgents) yield* current.reap().pipe(Effect.timeout(stopMs), Effect.ignore)
        }),
        parentScope,
      )
    })
  }
  function commit<A>(change: (draft: State) => A): Effect.Effect<A, WorkerFailure> {
    return Effect.gen(function* () {
      if (frozen) return yield* Effect.fail(frozen)
      const draft = structuredClone(state)
      const value = yield* Effect.try({
        try: () => change(draft),
        catch: (cause) =>
          cause instanceof WorkerFailure ? cause : new WorkerFailure('invalid_state', reasonOf(cause), cause),
      })
      yield* ledger.save(draft).pipe(Effect.catch((cause) => freeze(cause).pipe(Effect.andThen(Effect.fail(frozen!)))))
      const previous = state
      state = draft
      const waitAttributes = {
        'baton.thread.id': state.config?.thread_id ?? '',
        'baton.node.id': state.config?.node_id ?? '',
      }
      for (const command of Object.values(state.commands)) {
        const old = previous.commands[command.receipt.command_id]
        if (command.receipt.action !== 'stop' || (old && !isPending(old)) || isPending(command)) continue
        const outcome = command.status.command_outcome
        if (outcome !== 'succeeded' && outcome !== 'unknown') continue
        yield* withTraceSpan(Effect.void, 'baton.worker.stop', command.trace_context, {
          attributes: {
            ...waitAttributes,
            'baton.command.id': command.receipt.command_id,
            'baton.stop.result': outcome === 'succeeded' ? 'stopped' : 'unknown',
          },
        })
      }
      for (const message of Object.values(state.messages)) {
        if (message.input.mode !== 'queue') continue
        const old = previous.messages[message.input.id]
        if (!old && message.state === 'queued')
          yield* waitEvent('start', 'queue', waitAttributes, message.trace_context)
        if (old?.state === 'queued' && message.state !== 'queued')
          yield* waitEvent(
            'end',
            'queue',
            waitAttributes,
            message.trace_context,
            clock.currentTimeMillisUnsafe() - (message.receivedAtMs ?? clock.currentTimeMillisUnsafe()),
          )
      }
      for (const question of state.questions ?? []) {
        const old = previous.questions?.find(
          (entry) =>
            entry.messageId === question.messageId && entry.question.request_id === question.question.request_id,
        )
        const pending = (value: string) => !['resolved', 'cancelled'].includes(value)
        const message = state.messages[question.messageId]
        const attributes = { ...waitAttributes, 'baton.turn.seq': question.turn }
        if (!old && pending(question.state)) yield* waitEvent('start', 'approval', attributes, message?.trace_context)
        if (old && pending(old.state) && !pending(question.state))
          yield* waitEvent(
            'end',
            'approval',
            attributes,
            message?.trace_context,
            clock.currentTimeMillisUnsafe() - (question.startedAtMs ?? clock.currentTimeMillisUnsafe()),
          )
      }
      for (const message of Object.values(state.messages)) {
        if (message.input.mode !== 'queue') continue
        let turn = turns.get(message.input.id)
        if (
          !turn &&
          message.turn !== undefined &&
          !message.ended &&
          (message.state === 'intent' || message.state === 'sent')
        ) {
          const parent = traceParent(message.trace_context)
          const command = Object.values(state.commands).find((entry) => entry.messageId === message.input.id)
          const started = message.receivedAtMs ?? message.startedAtMs ?? clock.currentTimeMillisUnsafe()
          const span = tracer.span({
            name: 'baton.turn',
            parent: parent ? Option.some(parent) : Option.none(),
            annotations: Context.empty(),
            links: [],
            kind: 'internal',
            root: !parent,
            sampled: parent?.sampled ?? true,
            startTime: BigInt(Math.floor(started)) * 1_000_000n,
          })
          const attributes = {
            'baton.thread.id': state.config?.thread_id ?? '',
            'baton.agent': state.config?.agent_type ?? '',
            'baton.node.id': state.config?.node_id ?? '',
            'baton.command.action': 'message',
            'baton.turn.seq': message.turn,
            ...(command ? { 'baton.command.id': command.receipt.command_id } : {}),
            ...(message.input.model ? { 'gen_ai.request.model': message.input.model } : {}),
          }
          for (const [key, value] of Object.entries(attributes)) span.attribute(key, value)
          turn = {
            span,
            started,
            output: false,
            usage: false,
          }
          turns.set(message.input.id, turn)
        }
        if (!turn) continue
        if (message.turn !== undefined) turn.span.attribute('baton.turn.seq', message.turn)
        if (message.ended) {
          const last = state.outbox.findLast(
            (entry) => entry.report.kind === 'turn.ended' && entry.report.client_message_id === message.input.id,
          )
          const reason = last?.report.reason
          const result =
            reason === 'completed'
              ? 'completed'
              : reason === 'failed'
                ? 'failed'
                : reason === 'stopped'
                  ? 'stopped'
                  : 'unknown'
          turn.span.attribute('baton.turn.result', result)
          if (result === 'failed') turn.span.attribute('baton.error.code', 'turn_failed')
          turn.span.attribute('baton.usage.reported', turn.usage)
          turn.span.end(clock.currentTimeNanosUnsafe(), result === 'failed' ? Exit.fail('turn_failed') : Exit.void)
          turns.delete(message.input.id)
        }
      }
      const active = state.activeMessage ? state.messages[state.activeMessage] : undefined
      const turn = active && !active.ended ? `${active.input.id}:${active.turn}` : undefined
      if (turn !== outputTurn) {
        output.reset()
        outputTurn = turn
        outputExecution = undefined
        outputReplyId = undefined
      }
      if (active?.executionId && outputExecution && active.executionId !== outputExecution) {
        output.reset()
        outputExecution = active.executionId
        outputReplyId = undefined
      }
      return value
    }).pipe(Effect.uninterruptible)
  }
  function post(task: Effect.Effect<void, WorkerFailure>): Effect.Effect<void> {
    return Queue.offer(
      jobs,
      Effect.gen(function* () {
        if (closed || closing || frozen) return
        yield* task.pipe(Effect.catch((cause) => freeze(cause)))
        if (!frozen && !closed) yield* drive().pipe(Effect.catch((cause) => freeze(cause)))
      }),
    ).pipe(Effect.asVoid)
  }
  function launch<A, E>(
    op: Operation,
    task: Effect.Effect<A, E>,
    complete: (result: Exit.Exit<A, E>) => Effect.Effect<void, WorkerFailure>,
  ): Effect.Effect<void> {
    return Effect.gen(function* () {
      operation = op
      op.fiber = yield* Effect.forkIn(
        Effect.gen(function* () {
          const durableTrace = op.messageId
            ? state.messages[op.messageId]?.trace_context
            : Object.values(state.commands).find(
                (command) => isPending(command) && command.receipt.action === (op.kind === 'open' ? 'open' : 'resume'),
              )?.trace_context
          const result = yield* Effect.exit(
            withTraceSpan(task, `baton.worker.${op.kind}`, durableTrace, {
              kind: 'internal',
              ...(op.messageId && turns.get(op.messageId) ? { parent: turns.get(op.messageId)!.span } : {}),
              attributes: { 'baton.thread.id': state.config?.thread_id ?? '', 'baton.recovery': op.kind === 'recover' },
            }),
          )
          yield* post(
            Effect.suspend(() => {
              if (operation?.id !== op.id || state.epoch !== op.epoch) return Effect.void
              operation = undefined
              return complete(result)
            }),
          )
        }),
        scope,
      )
    })
  }
  function newOperation(kind: Operation['kind'], messageId?: string): Operation {
    return { id: randomUUID(), epoch: state.epoch, kind, ...(messageId === undefined ? {} : { messageId }) }
  }
  function retireAgent(current: ThreadAgent): Effect.Effect<void> {
    return Effect.gen(function* () {
      ownedAgents.delete(current)
      if (agent !== current) return
      agent = undefined
      const previous = eventsFiber
      eventsFiber = undefined
      if (previous) yield* Effect.forkIn(Fiber.interrupt(previous), scope)
      if (outputFiber) yield* Effect.forkIn(Fiber.interrupt(outputFiber), scope)
      outputFiber = undefined
    })
  }
  function receiveOutput(current: ThreadAgent, event: AgentOutput) {
    if (closed || closing || frozen || agent !== current || operation?.kind === 'cleanup') return
    const message = state.activeMessage ? state.messages[state.activeMessage] : undefined
    if (
      !message ||
      message.ended ||
      !outputTurn ||
      (state.phase !== 'busy' && state.phase !== 'stopping') ||
      state.nativeId !== event.nativeSessionId ||
      message.input.id !== event.messageId ||
      (message.executionId !== undefined && message.executionId !== event.executionId) ||
      (outputExecution !== undefined && outputExecution !== event.executionId)
    )
      return
    outputExecution = event.executionId
    const turn = turns.get(message.input.id)
    if (turn && !turn.output && event.text) {
      turn.output = true
      turn.span.attribute('baton.turn.first_output_ms', Math.max(0, clock.currentTimeMillisUnsafe() - turn.started))
    }
    const replyId = event.replyId === undefined ? undefined : safeReplyId(event.replyId)
    if (replyId !== outputReplyId) {
      output.reset()
      outputReplyId = replyId
    }
    output.append(event.text, event.gap)
  }
  function ensureAgent(): Effect.Effect<ThreadAgent> {
    return Effect.gen(function* () {
      if (agent) return agent
      agent = options.agentFactory(state.config!)
      ownedAgents.add(agent)
      const current = agent
      let terminalEventSeen = false
      const streamEnded = () =>
        post(
          Effect.suspend(() => {
            if (
              agent !== current ||
              operation?.kind === 'cleanup' ||
              terminalEventSeen ||
              closing ||
              closed ||
              state.phase === 'stopped' ||
              state.phase === 'failed'
            )
              return Effect.void
            return uncertain('Agent event stream ended without termination evidence')
          }),
        )
      eventsFiber = yield* Effect.forkIn(
        Stream.runForEach(current.events, (event) =>
          Effect.gen(function* () {
            let enriched = event
            if (
              event.type === 'reply' &&
              options.attachments &&
              state.config &&
              !event.attachments &&
              event.metadata?.encoding !== 'base64'
            ) {
              const attachments = yield* options.attachments(state.config, event.text).pipe(
                Effect.timeout('1 second'),
                Effect.catch((error) =>
                  Effect.as(
                    Effect.logWarning('Attachment extraction failed', {
                      thread_id: state.config?.thread_id,
                      code: error._tag,
                    }),
                    [],
                  ),
                ),
              )
              if (attachments.length) enriched = { ...event, attachments }
            }
            yield* post(
              Effect.gen(function* () {
                if (agent !== current || operation?.kind === 'cleanup') return
                if (enriched.type === 'uncertain' || enriched.type === 'exited') terminalEventSeen = true
                yield* onEvent(enriched)
              }),
            )
          }),
        ).pipe(
          Effect.andThen(streamEnded),
          Effect.catch((error) =>
            post(
              Effect.suspend(() =>
                terminalEventSeen || agent !== current || operation?.kind === 'cleanup'
                  ? Effect.void
                  : uncertain(reasonOf(error)),
              ),
            ),
          ),
        ),
        scope,
      )
      if (current.output)
        outputFiber = yield* Effect.forkIn(
          Stream.runForEach(current.output, (event) => Effect.sync(() => receiveOutput(current, event))).pipe(
            Effect.catch(() =>
              Effect.sync(() => {
                if (agent === current && outputTurn) output.append('', true)
              }),
            ),
          ),
          scope,
        )
      return current
    })
  }
  function uncertain(reason: string): Effect.Effect<void, WorkerFailure> {
    if (state.phase === 'unknown') return Effect.void
    return commit((draft) => markUnknown(draft, reason, false)).pipe(Effect.asVoid)
  }
  function accepted(draft: State, messageId: string, acceptance: InputAcceptance, allowUnknown = false) {
    const message = draft.messages[messageId]!
    if ((draft.phase === 'unknown' && !allowUnknown) || message.state !== 'intent') return
    if (acceptance.nativeSessionId !== draft.nativeId || !acceptance.executionId) {
      markUnknown(draft, 'Input acceptance identity mismatch')
      return
    }
    if (message.input.mode === 'steer') {
      const target = Object.values(draft.messages).find(
        (item) => item.input.mode === 'queue' && item.turn === message.input.targetTurn,
      )
      if (!target?.executionId || target.executionId !== acceptance.executionId) {
        markUnknown(draft, 'Steering acceptance has no conclusive target turn')
        return
      }
      message.executionId = acceptance.executionId
      settleMessage(draft, message, 'succeeded')
      return
    }
    message.executionId = acceptance.executionId
    message.startedAtNs = process.hrtime.bigint().toString()
    message.startedAtMs = Date.now()
    report(draft, 'turn.started', {
      worker_turn_seq: message.turn!,
      client_message_id: messageId,
      native_session_id: draft.nativeId!,
      execution_id: acceptance.executionId,
    })
    settleMessage(draft, message, 'succeeded')
  }
  function syncTurnTimer(): Effect.Effect<void> {
    return Effect.gen(function* () {
      const active = state.activeMessage ? state.messages[state.activeMessage] : undefined
      const running = !recovering && state.phase === 'busy' && active?.state === 'sent' && !active.ended
      const budget = state.config?.execution_timeout_seconds ?? 7200
      if (
        !running ||
        turnTimer?.messageId !== active?.input.id ||
        turnTimer?.turn !== active?.turn ||
        turnTimer?.budget !== budget
      ) {
        if (turnTimer) yield* Effect.forkIn(Fiber.interrupt(turnTimer.fiber), scope)
        turnTimer = undefined
      }
      if (
        !running ||
        turnTimer ||
        active?.turn === undefined ||
        active.startedAtNs === undefined ||
        active.startedAtMs === undefined
      )
        return
      const messageId = active.input.id
      const turn = active.turn
      const epoch = state.epoch
      const startedNs = BigInt(active.startedAtNs)
      const startedMs = active.startedAtMs
      const fiber = yield* Effect.forkIn(
        Effect.gen(function* () {
          while (true) {
            const elapsed = Math.max(Number(process.hrtime.bigint() - startedNs) / 1_000_000, Date.now() - startedMs)
            const remaining = (budget - elapsed / 1000) * 1000
            if (remaining <= 0) break
            yield* Effect.sleep(Math.min(1000, remaining))
          }
          yield* post(
            Effect.suspend(() => {
              if (
                state.epoch !== epoch ||
                state.phase !== 'busy' ||
                state.activeMessage !== messageId ||
                state.messages[messageId]?.turn !== turn ||
                (state.config?.execution_timeout_seconds ?? 7200) !== budget
              )
                return Effect.void
              return commit((draft) => requestStop(draft, 'timeout')).pipe(Effect.asVoid)
            }),
          )
        }),
        scope,
      )
      turnTimer = { messageId, turn, budget, fiber }
    })
  }
  function flushBuffered(): Effect.Effect<void, WorkerFailure> {
    return Effect.gen(function* () {
      for (const event of buffered.splice(0)) yield* onEvent(event)
    })
  }
  function onEvent(event: AgentEvent): Effect.Effect<void, WorkerFailure> {
    return Effect.gen(function* () {
      if (event.type === 'barrier') {
        yield* event.acknowledge
        return
      }
      if (recovering && state.config?.agent_type === 'shell') {
        if (buffered.length >= 256) return yield* uncertain('shell recovery event buffer overflow')
        buffered.push(event)
        return
      }
      if (event.type === 'uncertain') {
        yield* uncertain(event.reason)
        return
      }
      if (event.type === 'exited') {
        if (state.phase === 'unknown') return
        if (state.phase === 'stopping') {
          if (event.processTreeStopped && stopEvidence) yield* Deferred.succeed(stopEvidence, undefined)
          return
        }
        if (state.phase === 'stopped' || state.phase === 'failed' || state.phase === 'empty') return
        yield* uncertain(event.reason || 'Agent exited without a confirmed turn end')
        return
      }
      const message = state.messages[event.messageId]
      if (message?.ended && state.nativeId === event.nativeSessionId && message.executionId === event.executionId)
        return
      if (state.phase === 'stopped' || state.phase === 'failed') return
      if (
        state.phase === 'unknown' &&
        (message?.state !== 'sent' ||
          !message.executionId ||
          (event.type !== 'item' && event.type !== 'reply' && event.type !== 'end'))
      )
        return
      if (state.nativeId !== event.nativeSessionId || state.activeMessage !== event.messageId || !message) {
        yield* uncertain('Agent event identity mismatch')
        return
      }
      if (!message.executionId && message.state === 'intent') {
        if (buffered.length >= 256) yield* uncertain('Agent event buffer overflow before acceptance')
        else buffered.push(event)
        return
      }
      if (message.executionId !== event.executionId) {
        yield* uncertain('Agent execution identity mismatch')
        return
      }
      if (event.type === 'model') {
        turns.get(event.messageId)?.span.attribute('gen_ai.request.model', event.model)
        return
      }
      if (event.type === 'item' || event.type === 'reply') {
        const turn = turns.get(event.messageId)
        if (turn && !turn.output) {
          turn.output = true
          turn.span.attribute('baton.turn.first_output_ms', Math.max(0, clock.currentTimeMillisUnsafe() - turn.started))
        }
        if (event.truncated !== undefined || event.original_bytes !== undefined) {
          yield* withTraceSpan(Effect.void, 'baton.output', message.trace_context, {
            ...(turn ? { parent: turn.span } : {}),
            attributes: {
              ...(event.truncated === undefined ? {} : { 'baton.output.truncated': event.truncated }),
              ...(event.original_bytes === undefined ||
              !Number.isSafeInteger(event.original_bytes) ||
              event.original_bytes < 0
                ? {}
                : { 'baton.output.bytes': event.original_bytes }),
            },
          })
        }
      }
      if (event.type === 'end' && event.tokenUsage !== undefined) {
        const turn = turns.get(event.messageId)
        if (turn && event.tokenUsage && typeof event.tokenUsage === 'object' && !Array.isArray(event.tokenUsage)) {
          for (const [source, target] of [
            ['inputTokens', 'gen_ai.usage.input_tokens'],
            ['outputTokens', 'gen_ai.usage.output_tokens'],
            ['cachedInputTokens', 'baton.usage.cached_input_tokens'],
          ] as const) {
            const value: unknown = Reflect.get(event.tokenUsage, source)
            if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
              turn.usage = true
              turn.span.attribute(target, value)
            }
          }
        }
      }
      if (event.type === 'end' && state.phase === 'unknown') {
        if (event.tokenUsage !== undefined)
          yield* commit((draft) => {
            draft.messages[event.messageId]!.tokenUsage = event.tokenUsage!
          })
        return
      }
      const submitting =
        operation?.kind === 'send' && operation.messageId ? state.messages[operation.messageId] : undefined
      // The coordinator attaches sent inputs only while their target turn is still open.
      if (event.type === 'end' && submitting?.input.mode === 'steer' && submitting.state === 'intent') {
        if (buffered.length >= 256) yield* uncertain('Agent event buffer overflow before steering acceptance')
        else buffered.push(event)
        return
      }
      yield* commit((draft) => {
        const current = draft.messages[event.messageId]!
        if (event.type === 'question') {
          if (draft.phase !== 'busy' || current.turn === undefined) return
          draft.questions ??= []
          if (draft.questions.some((q) => q.question.request_id === event.question.request_id)) return
          draft.questions.push({
            startedAtMs: clock.currentTimeMillisUnsafe(),
            question: event.question,
            messageId: event.messageId,
            executionId: event.executionId,
            turn: current.turn,
            state: 'pending',
          })
          report(draft, 'question.pending', { question: event.question, worker_turn_seq: current.turn })
        } else if (event.type === 'question.resolved') {
          const question = draft.questions?.find(
            (q) => q.question.request_id === event.requestId && q.messageId === event.messageId,
          )
          if (!question || question.state === 'resolved' || question.state === 'cancelled') return
          const awaitingDelivery = question.state === 'queued'
          if (question.state !== 'intent') question.state = 'resolved'
          report(draft, 'question.resolved', { request_id: event.requestId, worker_turn_seq: question.turn })
          const command = question.commandId ? draft.commands[question.commandId] : undefined
          if (command && awaitingDelivery)
            finish(draft, command, 'cancelled', 'Agent closed the question before answer delivery')
        } else if (event.type === 'item') {
          if (current.turn === undefined) return reject('invalid_state', 'Item has no Worker turn')
          if (
            draft.outbox.some(
              (entry) =>
                entry.report.kind === 'turn.item' &&
                entry.report.worker_turn_seq === current.turn &&
                (entry.itemId ?? entry.report.item?.id) ===
                  (draft.config?.agent_type === 'shell' ? `shell:${current.turn}` : event.item.id),
            )
          )
            return
          report(draft, 'turn.item', {
            client_message_id: event.messageId,
            worker_turn_seq: current.turn,
            item: draft.config?.agent_type === 'shell' ? { ...event.item, id: `shell:${current.turn}` } : event.item,
            truncated: event.truncated ?? false,
            original_bytes: event.original_bytes ?? Buffer.byteLength(JSON.stringify(event.item.data)),
            ...(event.metadata ? { metadata: event.metadata } : {}),
          })
        } else if (event.type === 'reply') {
          if (
            draft.outbox.some(
              (entry) =>
                entry.report.kind === 'reply' &&
                (entry.replyEvidence?.id ?? entry.report.metadata?.reply_id) === event.id &&
                entry.report.client_message_id === event.messageId,
            )
          )
            return
          if (current.turn === undefined) return reject('invalid_state', 'Reply has no Worker turn')
          // 保留映射前缀，避免原生 ID 与映射结果占用同一个展示 ID。
          const id = safeReplyId(event.id)
          const text = displayText(event.text)
          const repaired = id !== event.id || text !== event.text
          report(
            draft,
            'reply',
            {
              client_message_id: event.messageId,
              worker_turn_seq: current.turn,
              content: text,
              ...(event.attachments ? { attachments: event.attachments } : {}),
              metadata: {
                ...event.metadata,
                reply_id: id,
                ...(id === event.id ? {} : { reply_id_mapped: true }),
                ...(text === event.text ? {} : { reply_text_sanitized: true }),
                ...(repaired ? { reply_evidence: 'worker_ledger_json' } : {}),
              },
              ...(event.original_bytes === undefined ? {} : { original_bytes: event.original_bytes }),
              ...(event.truncated === undefined ? {} : { truncated: event.truncated }),
            },
            repaired ? event : undefined,
          )
        } else {
          cancelQuestions(draft, 'Current reply ended')
          current.ended = true
          if (event.tokenUsage !== undefined) current.tokenUsage = event.tokenUsage
          report(draft, 'turn.ended', {
            worker_turn_seq: current.turn!,
            client_message_id: event.messageId,
            reason:
              draft.phase === 'stopping'
                ? (draft.stopReason ?? 'stopped')
                : event.outcome === 'cancelled'
                  ? 'stopped'
                  : event.outcome === 'failed'
                    ? 'failed'
                    : 'completed',
            ...(event.outcome === 'failed' ? { content: event.reason } : {}),
            ...(event.tokenUsage === undefined ? {} : { token_usage: event.tokenUsage }),
          })
          delete draft.activeMessage
          if (draft.phase !== 'stopping') {
            if (draft.config?.agent_type === 'shell') {
              draft.phase = 'stopped'
              draft.processTreeStopped = true
              report(draft, 'thread.stopped', { reason: 'completed' })
            } else draft.phase = 'idle'
          }
        }
      })
      if (event.type === 'end' && state.phase === 'stopping' && stopEvidence)
        yield* Deferred.succeed(stopEvidence, undefined)
    })
  }
  /** Called only by I/O fibers; the state queue supplies a fresh durable-record snapshot. */
  function recoverPersistedProcesses(): Effect.Effect<boolean> {
    return Effect.gen(function* () {
      const records = yield* submit(Effect.sync(() => structuredClone(Object.values(state.processes))))
      if (records.length === 0) return true
      if (!options.recoverProcesses) return false
      return (yield* options.recoverProcesses(records)).processTreeStopped
    }).pipe(Effect.catch(() => Effect.succeed(false)))
  }
  function recoverInput(current: ThreadAgent, message: Message, timeoutMs = sendMs) {
    return Effect.gen(function* () {
      // A snapshot proves text presence, but not the native turn that received a steer.
      if (!message.preparation || message.input.mode === 'steer') return undefined
      yield* current.restoreInput(message.input, message.preparation)
      return yield* current.sent(message.input, message.preparation)
    }).pipe(
      Effect.timeout(timeoutMs),
      Effect.catch(() => Effect.succeed(undefined)),
    )
  }
  function recoverWithFreshAgent(
    config: NonNullable<State['config']>,
    pending: readonly Message[],
    remaining: () => number,
  ) {
    if (pending.length === 0) return Effect.succeed<ReadonlyArray<readonly [string, InputAcceptance | undefined]>>([])
    return Effect.acquireUseRelease(
      Effect.sync(() => options.agentFactory(config)),
      (reader) =>
        Effect.forEach(pending, (message) =>
          (remaining() <= 0
            ? Effect.succeed(undefined)
            : recoverInput(reader, message, Math.min(sendMs, remaining()))
          ).pipe(Effect.map((acceptance) => [message.input.id, acceptance] as const)),
        ),
      (reader) =>
        reader
          .close()
          .pipe(
            Effect.timeout(Math.max(1, remaining())),
            Effect.ignore,
            Effect.andThen(reader.reap().pipe(Effect.timeout(Math.max(1, remaining())), Effect.ignore)),
          ),
    ).pipe(Effect.catchCause(() => Effect.succeed(pending.map((message) => [message.input.id, undefined] as const))))
  }
  function cleanupAgent(current: ThreadAgent) {
    const started = process.hrtime.bigint()
    const remaining = () => Math.max(1, stopMs - Number(process.hrtime.bigint() - started) / 1_000_000)
    return Effect.gen(function* () {
      yield* current.close().pipe(Effect.timeout(Math.min(5000, Math.max(1, stopMs / 2))), Effect.ignore)
      return yield* current.reap().pipe(Effect.timeout(remaining()))
    })
  }
  function startStop(): Effect.Effect<void, WorkerFailure> {
    return Effect.gen(function* () {
      if (stopFiber) return
      recovering = false
      const current = yield* ensureAgent()
      const interrupted = operation?.fiber
      operation = undefined
      stopEvidence = yield* Deferred.make<void>()
      const evidence = stopEvidence
      const epoch = state.epoch
      const started = state.stopStartedNs === undefined ? process.hrtime.bigint() : BigInt(state.stopStartedNs)
      const remaining = () => Math.max(0, stopMs - Math.max(0, Number(process.hrtime.bigint() - started) / 1_000_000))
      const graceMs = Math.max(1, remaining() - Math.min(5000, stopMs / 10))
      const active = state.activeMessage ? state.messages[state.activeMessage] : undefined
      const graceful = Effect.gen(function* () {
        // Cancellation has a separate path even when open/send is still pending.
        yield* current.abort().pipe(Effect.timeout(Math.min(5000, stopMs)), Effect.ignore)
        if (interrupted) yield* Fiber.interrupt(interrupted)
        if (state.config?.agent_type === 'shell') return (yield* current.reap()).processTreeStopped
        if (reclaimedOnRecovery) return true
        if (!active || active.state === 'queued') return true
        yield* Deferred.await(evidence)
        return true
      }).pipe(
        Effect.timeout(graceMs),
        Effect.catch(() => Effect.succeed(true)),
      )
      const config = state.config!
      const pending = Object.values(state.messages).filter((message) => message.state === 'intent')
      stopFiber = yield* Effect.forkIn(
        Effect.gen(function* () {
          let stopped = yield* graceful
          // Wait outside jobs: the event consumer posts the durable barrier back onto jobs.
          const flushed = yield* (active ? (current.flushEvents?.() ?? Effect.void) : Effect.void).pipe(
            Effect.timeout(Math.max(1, remaining())),
            Effect.exit,
          )
          // A stopped execution instance is never reused for resume or read-only recovery.
          const reaped = yield* current.reap().pipe(
            Effect.timeout(Math.max(1, remaining())),
            Effect.catch(() => Effect.succeed({ processTreeStopped: false })),
          )
          const recordsReaped = yield* recoverPersistedProcesses().pipe(
            Effect.timeout(Math.max(1, remaining())),
            Effect.catch(() => Effect.succeed(false)),
          )
          stopped &&= reaped.processTreeStopped && recordsReaped
          if (Exit.isFailure(flushed)) {
            yield* post(
              Effect.fail(
                new WorkerFailure(
                  'agent_event_flush_failed',
                  'Agent control events could not be durably drained before stop',
                ),
              ),
            )
            return
          }
          const recovered = yield* recoverWithFreshAgent(config, pending, remaining)
          yield* post(
            Effect.gen(function* () {
              stopFiber = undefined
              if (state.epoch !== epoch) return
              yield* commit((draft) => {
                for (const [id, acceptance] of recovered) {
                  const message = draft.messages[id]!
                  if (message.state !== 'intent') continue
                  if (acceptance) accepted(draft, id, acceptance)
                  else settleMessage(draft, message, 'unknown', 'Input acceptance could not be established after stop')
                }
              })
              yield* flushBuffered()
              if (reaped.processTreeStopped) yield* retireAgent(current)
              yield* commit((draft) => {
                const unknown =
                  (config.agent_type === 'shell' &&
                    !!active &&
                    active.state !== 'queued' &&
                    !draft.messages[active.input.id]?.ended) ||
                  !stopped ||
                  draft.phase === 'unknown' ||
                  Object.values(draft.messages).some((message) => message.state === 'unknown')
                if (unknown) markUnknown(draft, 'Stop could not establish the execution outcome')
                else {
                  draft.phase = 'stopped'
                  draft.resumeRequested = false
                  draft.processTreeStopped = true
                  endActive(draft, draft.stopReason ?? 'stopped')
                  report(draft, 'thread.stopped', { reason: draft.stopReason ?? 'stopped' })
                }
                for (const command of Object.values(draft.commands)) {
                  if (command.receipt.action === 'stop')
                    finish(
                      draft,
                      command,
                      unknown ? 'unknown' : 'succeeded',
                      unknown ? 'Execution outcome unknown' : '',
                    )
                }
              })
            }),
          )
        }),
        scope,
      )
    })
  }
  function drive(): Effect.Effect<void, WorkerFailure> {
    return Effect.gen(function* () {
      if (closed || closing || frozen || !state.config) return
      yield* syncTurnTimer()
      if (state.phase === 'stopping') {
        yield* startStop()
        return
      }
      if (recovering) return
      if (state.phase === 'unknown' && (!state.processTreeStopped || !state.resumeRequested)) {
        if ((!uncertaintyCleanup || state.resumeRequested) && !unknownRecoveryRunning && !state.processTreeStopped) {
          uncertaintyCleanup = true
          unknownRecoveryRunning = true
          const current = yield* ensureAgent()
          const config = state.config
          const pending = Object.values(state.messages).filter((message) => message.state === 'intent')
          const previous = operation?.fiber
          operation = undefined
          const active = state.activeMessage ? state.messages[state.activeMessage] : undefined
          yield* Effect.forkIn(
            Effect.gen(function* () {
              yield* current.abort().pipe(Effect.timeout(5000), Effect.ignore)
              if (previous) yield* Fiber.interrupt(previous).pipe(Effect.timeout(stopMs), Effect.ignore)
              const flushed = yield* (active ? (current.flushEvents?.() ?? Effect.void) : Effect.void).pipe(
                Effect.timeout(stopMs),
                Effect.exit,
              )
              const reaped = yield* current.reap().pipe(
                Effect.timeout(stopMs),
                Effect.catch(() => Effect.succeed({ processTreeStopped: false })),
              )
              const recordsReaped = yield* recoverPersistedProcesses().pipe(
                Effect.timeout(stopMs),
                Effect.catch(() => Effect.succeed(false)),
              )
              if (Exit.isFailure(flushed)) {
                yield* post(
                  Effect.fail(
                    new WorkerFailure(
                      'agent_event_flush_failed',
                      'Agent control events could not be durably drained during unknown cleanup',
                    ),
                  ),
                )
                return
              }
              const recovered = yield* recoverWithFreshAgent(config, pending, () => sendMs)
              yield* post(
                Effect.gen(function* () {
                  unknownRecoveryRunning = false
                  yield* commit((draft) => {
                    draft.processTreeStopped = reaped.processTreeStopped && recordsReaped
                    for (const [id, acceptance] of recovered) {
                      const message = draft.messages[id]!
                      if (message.state !== 'intent') continue
                      if (acceptance) accepted(draft, id, acceptance, true)
                      else
                        settleMessage(
                          draft,
                          message,
                          'unknown',
                          'Native acceptance could not be established after execution became uncertain',
                        )
                    }
                  })
                  yield* flushBuffered()
                  if (reaped.processTreeStopped) yield* retireAgent(current)
                  yield* commit((draft) => {
                    finishUnknown(draft)
                    if (
                      reaped.processTreeStopped &&
                      draft.activeMessage &&
                      draft.messages[draft.activeMessage]?.state === 'unknown'
                    )
                      delete draft.activeMessage
                    if (!draft.processTreeStopped && draft.resumeRequested) {
                      draft.resumeRequested = false
                      withdrawQueued(draft, 'Cannot resume: previous execution process tree is not confirmed stopped')
                      for (const command of Object.values(draft.commands)) {
                        if (command.receipt.action === 'resume')
                          finish(draft, command, 'failed', 'Previous execution process tree is not confirmed stopped')
                      }
                    }
                  })
                }),
              )
            }),
            scope,
          )
        }
        return
      }
      if (yield* paused) return
      if (operation || state.phase === 'failed' || state.phase === 'empty') return
      const current = yield* ensureAgent()
      const intent = Object.values(state.messages).find((message) => message.state === 'intent')
      if (intent) {
        yield* launch(newOperation('recover', intent.input.id), recoverInput(current, intent), (result) =>
          Effect.gen(function* () {
            yield* commit((draft) => {
              const acceptance = Exit.isSuccess(result) ? result.value : undefined
              if (acceptance) {
                accepted(draft, intent.input.id, acceptance)
                if (draft.phase === 'stopped' && draft.messages[intent.input.id]!.state === 'sent') {
                  draft.messages[intent.input.id]!.ended = true
                  report(draft, 'turn.ended', {
                    client_message_id: intent.input.id,
                    worker_turn_seq: intent.turn!,
                    reason: 'Process tree reclaimed during recovery',
                  })
                  delete draft.activeMessage
                  if (Object.values(draft.messages).some((message) => message.state === 'queued'))
                    draft.resumeRequested = true
                }
              } else markUnknown(draft, 'Persisted input has no conclusive native acceptance evidence')
            })
            yield* flushBuffered()
          }),
        )
        return
      }
      const opening = Object.values(state.commands).find(
        (command) => isPending(command) && command.receipt.action === 'open',
      )
      const resuming = Object.values(state.commands).some(
        (command) => isPending(command) && command.receipt.action === 'resume',
      )
      if (opening || state.resumeRequested || resuming) {
        if (!opening && !state.nativeId) {
          yield* uncertain('Cannot resume without a durable native session identity')
          return
        }
        yield* commit((draft) => {
          if (!opening) draft.phase = 'opening'
          draft.processTreeStopped = false
          for (const command of Object.values(draft.commands)) {
            if (isPending(command) && (command.receipt.action === 'open' || command.receipt.action === 'resume'))
              command.status = { ...command.status, state: 'running' }
          }
        })
        reclaimedOnRecovery = false
        uncertaintyCleanup = false
        const resumeConfig = modelConfig(state.config, Object.values(state.messages))
        yield* launch(
          newOperation(opening ? 'open' : 'resume'),
          (opening ? current.open(state.config) : current.resume(state.nativeId!, resumeConfig)).pipe(
            Effect.timeout(openMs),
          ),
          (result) =>
            Effect.gen(function* () {
              if (Exit.isFailure(result)) {
                // 原因会展示给用户和项目助手，只保留错误信息；调用栈写入日志。
                const reason = reasonOf(Cause.squash(result.cause))
                yield* Effect.logWarning('Agent open failed', result.cause)
                yield* launch(newOperation('cleanup'), cleanupAgent(current), (cleanup) =>
                  Effect.gen(function* () {
                    const reaped = Exit.isSuccess(cleanup) && cleanup.value.processTreeStopped
                    yield* commit((draft) => {
                      draft.phase = opening ? 'failed' : 'stopped'
                      draft.resumeRequested = false
                      draft.processTreeStopped = reaped
                      if (opening) report(draft, 'thread.open_failed', { reason })
                      for (const command of Object.values(draft.commands)) {
                        if (command.receipt.action === 'open' || command.receipt.action === 'resume')
                          finish(draft, command, 'failed', reason)
                      }
                      withdrawQueued(draft, reason)
                      if (!reaped) markUnknown(draft, 'Failed Agent startup could not be reclaimed')
                    })
                    if (reaped) yield* retireAgent(current)
                  }),
                )
                return
              }
              yield* commit((draft) => {
                if (
                  !result.value.nativeSessionId ||
                  !Schema.is(boundedText(4096))(result.value.nativeSessionId) ||
                  (!opening && draft.nativeId !== result.value.nativeSessionId)
                ) {
                  markUnknown(draft, 'Native session identity changed during resume')
                  return
                }
                draft.nativeId = result.value.nativeSessionId
                draft.opened = true
                draft.resumeRequested = false
                delete draft.stopReason
                draft.phase = 'idle'
                report(draft, opening ? 'thread.opened' : 'thread.resumed', { native_session_id: draft.nativeId })
                for (const command of Object.values(draft.commands)) {
                  if (command.receipt.action === 'open' || command.receipt.action === 'resume')
                    finish(draft, command, 'succeeded')
                }
              })
            }),
        )
        return
      }
      if (state.phase !== 'idle' && state.phase !== 'busy') return
      const question = state.questions?.find((q) => q.state === 'queued')
      if (question?.answer && question.commandId) {
        const answer = question.answer
        const commandId = question.commandId
        yield* commit((draft) => {
          const pending = draft.questions?.find((q) => q.commandId === commandId)
          const command = draft.commands[commandId]
          if (pending) pending.state = 'intent'
          if (command) command.status = { ...command.status, state: 'running' }
        })
        yield* launch(
          newOperation('answer'),
          (current.answer ? current.answer(answer) : Effect.fail(new Error('Agent does not support questions'))).pipe(
            Effect.timeout(sendMs),
          ),
          (result) =>
            commit((draft) => {
              const pending = draft.questions?.find((q) => q.commandId === commandId)
              const command = draft.commands[commandId]
              if (!pending || !command || !isPending(command) || pending.state === 'cancelled') return
              pending.state = Exit.isSuccess(result) ? 'resolved' : 'cancelled'
              const reason = Exit.isSuccess(result)
                ? ''
                : 'Answer delivery could not be confirmed; check the current reply'
              report(draft, 'question.resolved', {
                request_id: answer.request_id,
                worker_turn_seq: pending.turn,
                reason,
              })
              finish(draft, command, Exit.isSuccess(result) ? 'succeeded' : 'unknown', reason)
            }),
        )
        return
      }
      const active = state.activeMessage ? state.messages[state.activeMessage] : undefined
      const queued = Object.values(state.messages).filter((item) => item.state === 'queued')
      const stale = queued.find(
        (item) => item.input.mode === 'steer' && (!active || active.ended || item.input.targetTurn !== active.turn),
      )
      if (stale) {
        yield* commit((draft) => {
          const next = draft.messages[stale.input.id]
          if (next) settleMessage(draft, next, 'cancelled', 'Target turn ended before steering input intent')
        })
        yield* drive()
        return
      }
      const message = queued.find((item) => state.phase === 'idle' || item.input.mode === 'steer')
      if (!message) return
      const inherited = modelConfig(state.config, Object.values(state.messages))
      const model = message.input.model ?? inherited.model ?? inherited.adapter_config.model
      const input = message.input.mode === 'steer' || model === undefined ? message.input : { ...message.input, model }
      yield* launch(
        newOperation('prepare', message.input.id),
        Effect.suspend(() => {
          // The ledger knows how many inputs the native Agent already accepted.
          const confirmedSends = Object.values(state.messages).filter((item) => item.state === 'sent').length
          return current.prepareInput(input, confirmedSends).pipe(Effect.timeout(prepareMs))
        }),
        (result) =>
          Effect.gen(function* () {
            if (Exit.isFailure(result)) {
              yield* commit((draft) =>
                settleMessage(
                  draft,
                  draft.messages[message.input.id]!,
                  'cancelled',
                  reasonOf(Cause.squash(result.cause)),
                ),
              )
              return
            }
            if (yield* paused) return
            const preparation = result.value
            if (state.messages[message.input.id]?.state !== 'queued') return
            if (message.input.mode === 'steer') {
              const target = state.activeMessage ? state.messages[state.activeMessage] : undefined
              if (!target || target.ended || target.turn !== message.input.targetTurn) {
                yield* commit((draft) => {
                  const next = draft.messages[message.input.id]
                  if (next) settleMessage(draft, next, 'cancelled', 'Target turn ended before steering input intent')
                })
                return
              }
            }
            if (
              preparation.nativeSessionId !== state.nativeId ||
              Buffer.byteLength(JSON.stringify(preparation)) > 4096 ||
              !preparation.preparationId ||
              !Number.isSafeInteger(preparation.confirmedSends) ||
              preparation.confirmedSends < 0
            ) {
              yield* commit((draft) =>
                settleMessage(draft, draft.messages[message.input.id]!, 'cancelled', 'Invalid input preparation'),
              )
              return
            }
            yield* commit((draft) => {
              const next = draft.messages[message.input.id]!
              next.input = input
              next.state = 'intent'
              draft.processTreeStopped = false
              next.preparation = preparation
              if (next.input.mode === 'steer') {
                if (next.input.targetTurn === undefined)
                  return reject('invalid_state', 'Steering input has no durable target turn')
                next.turn = next.input.targetTurn
              } else {
                next.turn = ++draft.turn
                draft.activeMessage = next.input.id
                draft.phase = 'busy'
              }
              for (const command of Object.values(draft.commands)) {
                if (command.messageId === next.input.id && isPending(command))
                  command.status = { ...command.status, state: 'running' }
              }
            })
            yield* launch(
              newOperation('send', message.input.id),
              current.send(input, preparation).pipe(Effect.timeout(sendMs)),
              (sent) =>
                Effect.gen(function* () {
                  if (Exit.isSuccess(sent)) {
                    yield* commit((draft) => accepted(draft, message.input.id, sent.value))
                    yield* flushBuffered()
                  } else {
                    const rejection = sent.cause.reasons.find(
                      (reason) =>
                        reason._tag === 'Fail' && reason.error instanceof AgentError && reason.error.modelRejected,
                    )
                    if (rejection?._tag !== 'Fail' || !(rejection.error instanceof AgentError)) return
                    const reason = rejection.error.message
                    yield* commit((draft) => {
                      const rejected = draft.messages[input.id]
                      if (!rejected || rejected.state !== 'intent') return
                      if (rejected.input.mode === 'queue' && rejected.turn === draft.turn) {
                        draft.turn -= 1
                        delete rejected.turn
                      }
                      settleMessage(draft, rejected, 'cancelled', reason)
                      rejected.ended = true
                      if (draft.activeMessage === input.id) {
                        delete draft.activeMessage
                        if (draft.phase === 'busy') draft.phase = 'idle'
                      }
                    })
                  }
                }),
            )
          }),
      )
    })
  }

  function receiptResult(command: Command): WorkerIPCMessage {
    return {
      type: 'result',
      ok: true,
      receipt: command.receipt,
      command_status: command.status,
      session_id: command.receipt.thread_id,
      storage_generation: command.receipt.storage_generation,
    }
  }
  function acceptCommand(request: WorkerRequest): Effect.Effect<WorkerIPCMessage, WorkerFailure> {
    return commit((draft) => {
      if (!request.command_id || !request.thread_id || !request.storage_generation)
        return reject('invalid_request', 'Missing command execution identity')
      const action = commandAction(request.type)!
      const content = {
        action,
        thread: request.thread_id,
        generation: request.storage_generation,
        ...(action === 'open' ? { config: request.open_config } : {}),
        ...(action === 'message'
          ? {
              id: request.client_message_id,
              text: request.payload,
              mode: request.mode ?? 'queue',
              model: request.model ?? null,
              thinking: request.thinking ?? null,
            }
          : {}),
        ...(action === 'withdraw' ? { id: request.client_message_id } : {}),
        ...(action === 'stop' ? { reason: request.stop_reason ?? '' } : {}),
        ...(action === 'answer' ? { answer: request.answer } : {}),
        ...(action === 'settings' ? { execution_timeout_seconds: request.execution_timeout_seconds } : {}),
      }
      const contentDigest = digest(content)
      const existing = draft.commands[request.command_id]
      if (existing) {
        if (existing.digest !== contentDigest)
          return reject('command_conflict', 'Command ID is already bound to different content')
        return receiptResult(existing)
      }
      if (
        action !== 'open' &&
        (!draft.config ||
          draft.config.thread_id !== request.thread_id ||
          draft.config.storage_generation !== request.storage_generation)
      )
        return reject('identity_mismatch', 'Thread or storage generation does not match the Worker ledger')
      const receipt: WorkerCommandReceipt = {
        command_id: request.command_id,
        thread_id: request.thread_id,
        storage_generation: request.storage_generation,
        action,
      }
      const command: Command = {
        ...(request.trace_context ? { trace_context: request.trace_context } : {}),
        receipt,
        digest: contentDigest,
        status: { command_id: request.command_id, state: 'accepted' },
      }
      draft.commands[request.command_id] = command
      switch (action) {
        case 'open': {
          if (draft.config || !request.open_config) return reject('invalid_state', 'Thread already has an open command')
          const config = request.open_config
          if (
            config.agent_type === 'shell' &&
            (!config.project_id ||
              !config.origin_conversation_id ||
              !config.origin_tool_call_id ||
              config.model ||
              config.adapter_config.model)
          )
            return reject(
              'invalid_shell_origin',
              'shell commands require a Project tool origin and do not accept models',
            )
          draft.config = request.open_config
          draft.phase = 'opening'
          break
        }
        case 'message': {
          if (!request.client_message_id || !request.payload)
            return reject('invalid_request', 'Message ID and content are required')
          command.messageId = request.client_message_id
          const messageDigest = digest({
            text: request.payload,
            mode: request.mode ?? 'queue',
            model: request.model ?? null,
            thinking: request.thinking ?? null,
          })
          const existingMessage = Object.hasOwn(draft.messages, request.client_message_id)
            ? draft.messages[request.client_message_id]
            : undefined
          if (existingMessage) {
            if (existingMessage.digest !== messageDigest)
              return reject('message_conflict', 'Message ID is already bound to different content')
            const outcome = terminalMessage(existingMessage)
            if (outcome) finish(draft, command, outcome, existingMessage.reason ?? '')
            break
          }
          const target = draft.activeMessage ? draft.messages[draft.activeMessage] : undefined
          if (request.mode === 'steer') {
            if (
              !draft.config ||
              !Object.hasOwn(agentCatalog, draft.config.agent_type) ||
              !agentCatalog[draft.config.agent_type as keyof typeof agentCatalog].capabilities.steer
            )
              return reject('unsupported', 'This Agent does not support steer')
            if (request.model) return reject('model_with_steer', 'Steering cannot change the model')
            if (request.thinking) return reject('model_with_steer', 'Steering cannot change thinking')
            if (draft.phase !== 'busy' || !target || target.ended || target.turn === undefined)
              return reject('invalid_state', 'Steering requires an active target turn')
          }
          if (draft.config?.agent_type === 'shell' && Object.keys(draft.messages).length > 0)
            return reject('unsupported', 'shell Thread accepts only one command')
          if (draft.phase === 'stopped' || draft.phase === 'unknown') {
            if (!draft.opened || !draft.nativeId)
              return reject('invalid_state', 'Cannot resume a Thread without a successfully opened native mapping')
            draft.resumeRequested = true
          } else if (draft.phase !== 'opening' && draft.phase !== 'idle' && draft.phase !== 'busy')
            return reject('invalid_state', 'Thread is not accepting new messages')
          Object.defineProperty(draft.messages, request.client_message_id, {
            enumerable: true,
            writable: true,
            configurable: true,
            value: {
              state: 'queued',
              receivedAtMs: clock.currentTimeMillisUnsafe(),
              ...(request.trace_context ? { trace_context: request.trace_context } : {}),
              digest: messageDigest,
              input: {
                id: request.client_message_id,
                text: request.payload,
                epoch: draft.epoch,
                operationId: randomUUID(),
                mode: request.mode ?? 'queue',
                ...(request.mode === 'steer' && target?.turn !== undefined ? { targetTurn: target.turn } : {}),
                ...(request.model === undefined ? {} : { model: request.model }),
                ...(request.thinking === undefined ? {} : { thinking: request.thinking }),
              },
            } satisfies Message,
          })
          report(draft, 'message.queued', { client_message_id: request.client_message_id, content: request.payload })
          break
        }
        case 'withdraw': {
          const message = request.client_message_id ? draft.messages[request.client_message_id] : undefined
          if (!message || message.state !== 'queued')
            return reject('not_queued', 'Only a queued message can be withdrawn')
          settleMessage(draft, message, 'cancelled', 'Withdrawn')
          finish(draft, command, 'succeeded')
          break
        }
        case 'resume': {
          if (draft.config?.agent_type === 'shell') return reject('unsupported', 'shell Thread cannot be resumed')
          if (
            !draft.opened ||
            !draft.nativeId ||
            (draft.phase !== 'stopped' &&
              draft.phase !== 'unknown' &&
              !(recovering && (draft.phase === 'idle' || draft.phase === 'busy')))
          )
            return reject('invalid_state', 'Only a previously opened Thread with a native mapping can resume')
          draft.resumeRequested = true
          break
        }
        case 'answer': {
          const answer = request.answer
          const question = answer
            ? draft.questions?.find((q) => q.question.request_id === answer.request_id)
            : undefined
          const active = draft.activeMessage ? draft.messages[draft.activeMessage] : undefined
          if (
            !answer ||
            !question ||
            question.state !== 'pending' ||
            recovering ||
            draft.phase !== 'busy' ||
            !active ||
            active.ended ||
            question.messageId !== active.input.id ||
            question.executionId !== active.executionId
          )
            return reject('invalid_state', 'Question is no longer pending')
          question.answer = answer
          question.commandId = request.command_id
          question.state = 'queued'
          break
        }
        case 'settings': {
          if (!draft.config || request.execution_timeout_seconds === undefined)
            return reject('invalid_request', 'Execution timeout is required')
          draft.config = { ...draft.config, execution_timeout_seconds: request.execution_timeout_seconds }
          finish(draft, command, 'succeeded')
          break
        }
        case 'stop': {
          requestStop(draft, request.stop_reason === 'timeout' ? 'timeout' : 'stopped')
          if (draft.phase === 'unknown') finish(draft, command, 'unknown', 'Thread execution is unknown')
          break
        }
      }
      return receiptResult(command)
    })
  }
  function shortRequest(request: WorkerRequest): Effect.Effect<WorkerIPCMessage, WorkerFailure> {
    if (commandAction(request.type)) return acceptCommand(request)
    return Effect.gen(function* () {
      if (request.type === 'status') {
        const active = state.activeMessage ? state.messages[state.activeMessage] : undefined
        return {
          ...(request.activity_check_seq !== undefined ? { activity_check_seq: request.activity_check_seq } : {}),
          ...(!recovering && state.phase === 'busy' && active?.state === 'sent' && !active.ended && active.executionId
            ? { active_turn: { worker_turn_seq: active.turn!, execution_id: active.executionId } }
            : {}),
          type: 'result',
          ok: true,
          worker_ready: true,
          agent_ready: !recovering && (state.phase === 'idle' || state.phase === 'busy'),
          ...(state.config
            ? { session_id: state.config.thread_id, storage_generation: state.config.storage_generation }
            : {}),
        }
      }
      if (request.type === 'thread_command_status') {
        if (
          !state.config ||
          request.thread_id !== state.config.thread_id ||
          request.storage_generation !== state.config.storage_generation
        )
          return { type: 'result', ok: false, code: 'identity_mismatch' }
        const command = state.commands[request.command_id]
        return command ? receiptResult(command) : { type: 'result', ok: false, code: 'command_not_found' }
      }
      if (request.type === 'thread_pending') return pendingResult(state.outbox, request.after_worker_seq ?? 0)
      if (request.type === 'thread_ack')
        return yield* commit((draft) => {
          const entry = draft.outbox.find(
            (item) => item.report.worker_seq === request.worker_seq && item.report.event_id === request.event_id,
          )
          if (!entry) return reject('invalid_ack', 'Report sequence and event ID do not match')
          entry.acked = true
          return { type: 'result', ok: true } as const
        })
      return {
        type: 'result',
        ok: false,
        code: 'unsupported',
        message: 'Request is handled outside the Worker execution core',
      }
    })
  }
  function submit<A>(task: Effect.Effect<A, WorkerFailure>): Effect.Effect<A, WorkerFailure> {
    return Effect.gen(function* () {
      if (closed) return yield* Effect.fail(new WorkerFailure('worker_closed', 'Worker scope has closed'))
      if (frozen) return yield* Effect.fail(frozen)
      const response = yield* Deferred.make<A, WorkerFailure>()
      const fail = (failure: WorkerFailure) => Deferred.fail(response, failure).pipe(Effect.asVoid)
      waiting.add(fail)
      yield* Queue.offer(
        jobs,
        Effect.gen(function* () {
          const result = yield* Effect.exit(frozen ? Effect.fail(frozen) : task)
          yield* Deferred.done(response, result)
          waiting.delete(fail)
          if (!frozen && !closed) yield* drive().pipe(Effect.catch((cause) => freeze(cause)))
        }),
      )
      return yield* Deferred.await(response)
    })
  }

  const queueFiber = yield* Effect.forkIn(
    Effect.forever(
      Effect.gen(function* () {
        yield* (yield* Queue.take(jobs)).pipe(
          Effect.catchCause((cause) => freeze(new WorkerFailure('worker_defect', Cause.pretty(cause), cause))),
        )
        // FULL commits must yield between transactions so IPC and cancellation can run.
        yield* Effect.yieldNow
      }),
    ),
    parentScope,
  )

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closing = true
      // Keep the ledger queue alive while adapter finalizers remove process records.
      yield* Scope.close(scope, Exit.void)
      for (const current of ownedAgents) {
        yield* current.close().pipe(Effect.timeout(stopMs), Effect.ignore)
        yield* current.reap().pipe(Effect.timeout(stopMs), Effect.ignore)
      }
      closed = true
      for (const fail of waiting) yield* fail(new WorkerFailure('worker_closed', 'Worker scope has closed'))
      yield* Fiber.interrupt(queueFiber)
      yield* Queue.shutdown(jobs)
    }),
  )

  // Startup reconciliation runs after construction and never submits a persisted intent.
  yield* post(
    Effect.gen(function* () {
      if (!state.config) {
        recovering = false
        return
      }
      if (yield* paused) {
        recovering = false
        return
      }
      yield* commit((draft) => cancelQuestions(draft, 'Agent restarted; question is no longer available'))
      const current = yield* ensureAgent()
      if (state.config.agent_type === 'shell' && state.opened && state.nativeId && state.phase !== 'unknown') {
        const active = state.activeMessage ? structuredClone(state.messages[state.activeMessage]) : undefined
        const config = state.config
        const nativeId = state.nativeId
        const restoreQueued = state.phase === 'idle' && state.turn === 0
        yield* launch(
          newOperation('recover'),
          Effect.gen(function* () {
            if (!(yield* recoverPersistedProcesses())) return { processTreeStopped: false }
            if (active && !active.ended && (active.state === 'intent' || active.state === 'sent')) {
              return { processTreeStopped: true, acceptance: yield* recoverInput(current, active) }
            }
            if (restoreQueued) yield* current.resume(nativeId, config).pipe(Effect.timeout(openMs))
            return { processTreeStopped: true }
          }).pipe(Effect.timeout(stopMs)),
          (result) =>
            Effect.gen(function* () {
              yield* commit((draft) => {
                if (Exit.isFailure(result) || !result.value.processTreeStopped) {
                  markUnknown(draft, 'shell execution or previous process-tree termination could not be verified')
                  return
                }
                draft.processTreeStopped = true
                if (active && !active.ended && (active.state === 'intent' || active.state === 'sent')) {
                  const acceptance = 'acceptance' in result.value ? result.value.acceptance : undefined
                  if (
                    !acceptance ||
                    acceptance.nativeSessionId !== draft.nativeId ||
                    (active.executionId && acceptance.executionId !== active.executionId)
                  ) {
                    markUnknown(draft, 'shell completion evidence is missing or does not match the persisted command')
                    return
                  }
                  draft.phase = 'busy'
                  if (active.state === 'intent') accepted(draft, active.input.id, acceptance)
                }
              })
              recovering = false
              yield* flushBuffered()
            }),
        )
        return
      }
      const recoveryTask = Effect.gen(function* () {
        if (!(yield* recoverPersistedProcesses())) return { processTreeStopped: false }
        return yield* current.reap()
      })
      yield* launch(newOperation('recover'), recoveryTask.pipe(Effect.timeout(stopMs)), (result) =>
        Effect.gen(function* () {
          yield* commit((draft) => {
            const interruptedOpen = Object.values(draft.commands).find(
              (command) => command.receipt.action === 'open' && command.status.state === 'running',
            )
            if (interruptedOpen) {
              report(draft, 'thread.open_failed', {
                reason: 'Startup was interrupted before its durable mapping completed',
              })
              markUnknown(draft, 'Startup outcome is unknown; automatic create is prohibited')
              withdrawQueued(draft, 'Startup outcome is unknown')
            } else if (Exit.isFailure(result) || !result.value.processTreeStopped)
              markUnknown(draft, 'Previous Agent process tree could not be reclaimed')
            else {
              reclaimedOnRecovery = true
              draft.processTreeStopped = !Object.values(draft.messages).some((message) => message.state === 'intent')
              if (draft.phase === 'unknown' && draft.processTreeStopped) finishUnknown(draft)
              if (draft.phase === 'idle' || draft.phase === 'busy') {
                draft.phase = 'stopped'
                const active = draft.activeMessage ? draft.messages[draft.activeMessage] : undefined
                if (active?.state === 'sent' && !active.ended) {
                  active.ended = true
                  report(draft, 'turn.ended', {
                    client_message_id: active.input.id,
                    worker_turn_seq: active.turn!,
                    reason: 'Process tree reclaimed during recovery',
                  })
                  delete draft.activeMessage
                }
                if (
                  Object.values(draft.messages).some((message) => message.state === 'queued') &&
                  !Object.values(draft.messages).some((message) => message.state === 'intent')
                )
                  draft.resumeRequested = true
              }
            }
          })
          if (Exit.isSuccess(result) && result.value.processTreeStopped) yield* retireAgent(current)
          recovering = false
        }),
      )
    }),
  )

  const handle: Worker['handle'] = (input) =>
    Effect.gen(function* (): Effect.fn.Return<WorkerIPCMessage, WorkerFailure> {
      if (closed || closing) return yield* Effect.fail(new WorkerFailure('worker_closed', 'Worker scope has closed'))
      const decoded = yield* Schema.decodeUnknownEffect(WorkerRequest)(input).pipe(
        Effect.mapError((cause) => new WorkerFailure('invalid_request', 'Invalid Worker request', cause)),
      )
      if (decoded.type === 'session_request') {
        const request = decoded.session_request
        const stateName = state.phase === 'busy' ? 'running' : state.phase
        const result = {
          type: 'session.result' as const,
          operation_id: request.operation_id,
          session_id: request.session_id,
          state: stateName,
          ...(state.activeMessage && state.messages[state.activeMessage]?.turn !== undefined
            ? { worker_turn_seq: state.messages[state.activeMessage]!.turn }
            : {}),
          ...(!state.config || frozen || recovering
            ? { ok: false, code: 'unavailable', gap: false }
            : request.session_id !== state.config.thread_id ||
                (decoded.thread_id !== undefined && decoded.thread_id !== state.config.thread_id) ||
                (decoded.storage_generation !== undefined &&
                  decoded.storage_generation !== state.config.storage_generation)
              ? { ok: false, code: 'invalid_request', gap: false }
              : {
                  ...output.read(request.cursor),
                  ...(outputReplyId === undefined ? {} : { reply_id: outputReplyId }),
                }),
        }
        return { type: 'result', ok: result.ok, session_result: result }
      }
      if (
        commandAction(decoded.type) &&
        options.dataDirectory &&
        upgradeOffline(
          yield* Effect.tryPromise({
            try: () => readUpgradeState(options.dataDirectory!),
            catch: (cause) => new WorkerFailure('upgrade_state_invalid', '无法读取升级状态', cause),
          }),
        )
      )
        return { type: 'result', ok: false, code: 'node_upgrading' }
      const trace = commandAction(decoded.type) ? yield* captureTrace : undefined
      return yield* submit(shortRequest({ ...decoded, ...(trace ? { trace_context: trace } : {}) })).pipe(
        Effect.catch((error) =>
          error.code === 'storage_error' || error.code === 'commit_unknown' || error.code === 'worker_closed'
            ? Effect.fail(error)
            : Effect.succeed({ type: 'result' as const, ok: false, code: error.code, message: error.message }),
        ),
      )
    }).pipe((effect) => {
      if (!commandAction(input.type)) return effect
      const original = traceParent(state.commands[input.command_id ?? '']?.trace_context)
      return withTraceSpan(effect, 'baton.worker.receive', input.trace_context, {
        kind: 'server',
        links: original ? [{ span: original, attributes: {} }] : [],
        attributes: { 'baton.command.id': input.command_id ?? '', 'baton.thread.id': input.thread_id ?? '' },
      })
    })
  const records: Worker['records'] = {
    add: (record) =>
      submit(
        commit((draft) => {
          if (!Number.isSafeInteger(record.pid) || record.pid <= 1 || !record.creationTime || !record.role)
            return reject('invalid_process_record', 'Process identity and role are required')
          const previous = draft.processes[String(record.pid)]
          if (previous && (previous.creationTime !== record.creationTime || previous.role !== record.role))
            return reject('process_record_conflict', 'PID already has a different durable process identity')
          draft.processes[String(record.pid)] = record
        }),
      ),
    remove: (record) =>
      submit(
        commit((draft) => {
          const previous = draft.processes[String(record.pid)]
          if (previous?.creationTime === record.creationTime && previous.role === record.role)
            delete draft.processes[String(record.pid)]
        }),
      ),
    list: () => submit(Effect.sync(() => structuredClone(Object.values(state.processes)))),
  }
  const drain = submit(
    Effect.gen(function* () {
      if (
        !(yield* paused) ||
        operation ||
        stopFiber ||
        recovering ||
        state.activeMessage ||
        ['busy', 'stopping', 'unknown'].includes(state.phase)
      )
        return false
      // 与 intent 共用串行队列；取消准备后也不会在关闭过程中启动下一回合。
      closing = true
      return true
    }),
  )
  return { handle, records, drain, failed: Deferred.await(fatal) } satisfies Worker
})
