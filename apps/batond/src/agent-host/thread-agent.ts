import { randomUUID } from 'node:crypto'
import { Effect, Exit, Queue, Scope, Stream } from 'effect'
import type { RuntimeAgent, WorkerOpenConfig } from '@baton/protocol'
import { dirname, isAbsolute } from 'node:path'
import {
  AgentError,
  type AgentEvent,
  type AgentFactory,
  type AgentMessage,
  type InputPreparation,
  type ThreadAgent,
} from '../worker/agent.ts'
import { makeOutputMailbox } from '../worker/output.ts'
import type { AgentHostPaths } from './paths.ts'
import { preparationFor, samePreparation } from './preparation.ts'
import type { Preparation } from './protocol.ts'
import { connectAgentHost, type AgentHostConnection, type AgentHostProcessOptions } from './transport.ts'

interface AgentDelta {
  readonly type: 'delta'
  readonly nativeSessionId: string
  readonly messageId: string
  readonly executionId: string
  readonly id: string
  readonly text: string
  readonly gap?: boolean
}

export interface HostedAgentOptions extends Omit<AgentHostProcessOptions, 'paths'> {
  /** Receives validated live text. The sink must return immediately. */
  readonly onDelta?: (event: AgentDelta) => void
  readonly connect?: (
    options: AgentHostProcessOptions,
    signal: AbortSignal,
  ) => Effect.Effect<AgentHostConnection, AgentError>
  readonly eventCapacity?: number
  readonly capabilities: Pick<RuntimeAgent['capabilities'], 'steer' | 'switch_model'>
}

const fixedModel = (config: WorkerOpenConfig) => config.model ?? config.adapter_config.model ?? 'default'

export const makeAgentHostFactory =
  (options: HostedAgentOptions): AgentFactory =>
  (config) =>
    makeAgent(config, options)

function makeAgent(config: WorkerOpenConfig, options: HostedAgentOptions): ThreadAgent {
  const statePath = config.adapter_config.state_path
  if (!statePath || !isAbsolute(statePath) || !isAbsolute(config.working_directory))
    throw new AgentError('Agent host requires absolute working_directory and private state_path')
  const paths: AgentHostPaths = { workingDirectory: config.working_directory, privateDirectory: dirname(statePath) }
  // These allocations only establish local state; host and filesystem work starts inside Effects.
  const scope = Scope.makeUnsafe()
  const queue = Effect.runSync(Queue.bounded<AgentEvent>(options.eventCapacity ?? 256))
  const output = makeOutputMailbox()
  const controller = new AbortController()
  const connections = new Set<AgentHostConnection>()
  const pending = new Set<Promise<AgentHostConnection>>()
  let live: AgentHostConnection | undefined
  let nativeSessionId: string | undefined
  let prepared: { message: AgentMessage; preparation: InputPreparation } | undefined
  let active: { messageId: string; executionId?: string; ended: boolean } | undefined
  let stopped = false
  let broken = false
  let opening = false
  let reaping = false
  const readers = new Set<AbortController>()
  let generation = ''
  let sequence = 0
  const io = <A>(work: () => Promise<A>) =>
    Effect.tryPromise({
      try: work,
      catch: (cause) =>
        cause instanceof AgentError ? cause : new AgentError('Agent native state operation failed', cause),
    })
  const readerOwners = new WeakMap<AgentHostConnection, AbortController>()
  const hostOptions = (): AgentHostProcessOptions => ({
    command: options.command,
    agentType: options.agentType,
    paths,
    ...(options.watchdog ? { watchdog: options.watchdog } : {}),
    ...(options.records ? { records: options.records } : {}),
    ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
  })
  const connect = (readOnly = false) =>
    Effect.gen(function* () {
      if ((stopped && !readOnly) || reaping) return yield* Effect.fail(new AgentError('Agent is stopped'))
      // Track startup separately so reap cannot report success while a host is still being registered.
      const readerController = readOnly ? new AbortController() : undefined
      if (readerController) readers.add(readerController)
      const signal = readerController?.signal ?? controller.signal
      const hostProcess = yield* Effect.try({
        try: () => hostOptions(),
        catch: (cause) => (cause instanceof AgentError ? cause : new AgentError('Agent host paths are invalid', cause)),
      })
      const promise = Effect.runPromise(
        options.connect ? options.connect(hostProcess, signal) : connectAgentHost(hostProcess, signal),
        { signal },
      )
      pending.add(promise)
      void promise.then(
        (host) => {
          connections.add(host)
          pending.delete(promise)
        },
        () => {
          pending.delete(promise)
        },
      )
      const host = yield* io(() => promise).pipe(
        Effect.onError(() =>
          Effect.uninterruptible(
            Effect.gen(function* () {
              if (readerController) readerController.abort()
              else controller.abort()
              const result = yield* Effect.promise(() =>
                promise.then(
                  (host) => ({ host }),
                  () => undefined,
                ),
              )
              if (result) {
                yield* result.host.disconnect
                const stopped = yield* result.host.reap.pipe(
                  Effect.catch(() => Effect.succeed({ processTreeStopped: false })),
                )
                if (stopped.processTreeStopped) connections.delete(result.host)
              }
              if (readerController) readers.delete(readerController)
            }),
          ),
        ),
      )
      if (readerController) readerOwners.set(host, readerController)
      if (stopped && !readOnly) {
        yield* host.disconnect
        yield* host.reap
        return yield* Effect.fail(new AgentError('Agent startup was cancelled'))
      }
      return host
    })
  const emit = (event: AgentEvent): Effect.Effect<void> => Queue.offer(queue, event).pipe(Effect.asVoid)
  const uncertain = (reason: string) =>
    Effect.gen(function* () {
      if (broken) return
      broken = true
      yield* emit({ type: 'uncertain', reason })
    })
  const receive = (frame: import('./protocol.ts').HostEvent) => receiveEvent(hostState(), frame)
  const hostState = () => ({
    generation: () => generation,
    sequence: () => sequence,
    setSequence: (next: number) => {
      sequence = next
    },
    nativeSessionId: () => nativeSessionId,
    active: () => active,
    setExecutionId: (id: string) => {
      if (active) active.executionId = id
    },
    markEnded: () => {
      if (active) active.ended = true
    },
    uncertain,
    emit,
    output: (event: AgentDelta) => {
      output.offer(event)
      options.onDelta?.(event)
    },
  })
  const start = (openConfig: WorkerOpenConfig, resume?: string) =>
    Effect.gen(function* () {
      if (
        openConfig.agent_type !== options.agentType ||
        opening ||
        live ||
        stopped ||
        config.thread_id !== openConfig.thread_id
      )
        return yield* Effect.fail(new AgentError('Agent lifecycle or configuration mismatch'))
      opening = true
      return yield* Effect.gen(function* () {
        const host = yield* connect()
        live = host
        generation = randomUUID()
        sequence = 0
        nativeSessionId = resume
          ? (yield* host.resume(openConfig, generation, resume)).nativeSessionId
          : (yield* host.open(openConfig, generation)).nativeSessionId
        if (stopped) return yield* Effect.fail(new AgentError('Agent startup was cancelled'))
        yield* Stream.runForEach(host.events, (frame) => receive(frame)).pipe(
          Effect.catch((error) => (reaping ? Effect.void : uncertain(error.message))),
          Effect.forkIn(scope),
        )
        yield* host.exited.pipe(
          Effect.andThen(emit({ type: 'exited', reason: 'Agent host exited', processTreeStopped: false })),
          Effect.ignore,
          Effect.forkIn(scope),
        )
        return { nativeSessionId }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            opening = false
          }),
        ),
      )
    })
  const agent: ThreadAgent = {
    open: (openConfig) => start(openConfig),
    resume: (native, openConfig) => start(openConfig, native),
    prepareInput: (message, confirmedSends) =>
      Effect.gen(function* () {
        if (!live || broken || stopped)
          return yield* Effect.fail(new AgentError('Agent cannot prepare an input in its current state'))
        if (message.mode === 'steer') {
          if (!options.capabilities.steer) return yield* Effect.fail(new AgentError('Agent does not support steer'))
          if (!active || active.ended) return yield* Effect.fail(new AgentError('Agent has no active turn to steer'))
        } else if (active && !active.ended)
          return yield* Effect.fail(new AgentError('Agent cannot prepare an input in its current state'))
        if (message.mode === 'steer' && message.model !== undefined)
          return yield* Effect.fail(new AgentError('Steering cannot change the model'))
        if (!options.capabilities.switch_model && message.model !== undefined && message.model !== fixedModel(config))
          return yield* Effect.fail(new AgentError('Agent does not support changing the model of an open Thread'))
        if (!nativeSessionId) return yield* Effect.fail(new AgentError('Agent has no native session identity'))
        const preparation = preparationFor(config, nativeSessionId, message, confirmedSends)
        prepared = { message, preparation }
        return preparation
      }),
    restoreInput: (message, preparation) =>
      Effect.gen(function* () {
        if (nativeSessionId && nativeSessionId !== preparation.nativeSessionId)
          return yield* Effect.fail(new AgentError('Agent preparation session mismatch'))
        if (Buffer.byteLength(JSON.stringify(preparation)) > 4096)
          return yield* Effect.fail(new AgentError('Agent preparation exceeds size limit'))
        const expected = preparationFor(config, preparation.nativeSessionId, message, preparation.confirmedSends)
        if (!samePreparation(expected, preparation))
          return yield* Effect.fail(new AgentError('Agent preparation identity mismatch'))
        prepared = { message, preparation }
      }),
    send: (message, preparation) =>
      Effect.gen(function* () {
        if (!live || broken || stopped)
          return yield* Effect.fail(new AgentError('Agent execution channel is not available'))
        if (message.mode === 'steer') {
          if (!options.capabilities.steer) return yield* Effect.fail(new AgentError('Agent does not support steer'))
          if (!active || active.ended) return yield* Effect.fail(new AgentError('Agent has no active turn to steer'))
        } else if (active && !active.ended)
          return yield* Effect.fail(new AgentError('Agent execution channel is not available'))
        if (!prepared || !samePreparation(prepared.preparation, preparation) || prepared.message.id !== message.id)
          return yield* Effect.fail(new AgentError('Agent input was not prepared or restored'))
        // Steer stays on the active turn. Upstream decides which native turn receives it.
        const turn = message.mode === 'steer' ? active : { messageId: message.id, ended: false }
        if (!turn) return yield* Effect.fail(new AgentError('Agent has no active turn to steer'))
        active = turn
        const accepted = yield* live.send(message, preparation as Preparation).pipe(
          Effect.tapError((error) =>
            error.modelRejected
              ? Effect.sync(() => {
                  turn.ended = true
                  prepared = undefined
                })
              : uncertain(error.message),
          ),
        )
        if (
          accepted.nativeSessionId !== nativeSessionId ||
          (turn.executionId && turn.executionId !== accepted.executionId)
        )
          return yield* Effect.fail(new AgentError('Agent acceptance identity mismatch'))
        turn.executionId = accepted.executionId
        prepared = undefined
        return accepted
      }),
    sent: (message, preparation) =>
      Effect.gen(function* () {
        const host = yield* connect(true)
        return yield* host.sent(config, message, preparation as Preparation).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* host.disconnect
              const result = yield* host.reap.pipe(Effect.catch(() => Effect.succeed({ processTreeStopped: false })))
              if (result.processTreeStopped) connections.delete(host)
              const owner = readerOwners.get(host)
              if (owner) readers.delete(owner)
            }),
          ),
        )
      }),
    answer: (answer) =>
      Effect.gen(function* () {
        if (!live?.answer || broken || stopped || !active || active.ended)
          return yield* Effect.fail(new AgentError('Agent question is no longer available'))
        yield* live.answer(answer)
      }),
    events: Stream.fromQueue(queue),
    output: output.stream,
    abort: () =>
      Effect.gen(function* () {
        stopped = true
        prepared = undefined
        controller.abort()
        if (live) yield* live.abort
      }),
    close: () =>
      Effect.gen(function* () {
        stopped = true
        controller.abort()
        if (live) yield* live.close
      }),
    reap: () =>
      Effect.gen(function* () {
        stopped = true
        controller.abort()
        reaping = true
        for (const reader of readers) reader.abort()
        yield* io(() => Promise.allSettled(pending))
        let processTreeStopped = true
        for (const host of connections) {
          yield* host.disconnect
          const result = yield* host.reap
          processTreeStopped &&= result.processTreeStopped
        }
        yield* Scope.close(scope, Exit.void)
        return { processTreeStopped }
      }),
  }
  return agent
}

interface HostState {
  readonly generation: () => string
  readonly sequence: () => number
  readonly setSequence: (next: number) => void
  readonly nativeSessionId: () => string | undefined
  readonly active: () => { messageId: string; executionId?: string; ended: boolean } | undefined
  readonly setExecutionId: (id: string) => void
  readonly markEnded: () => void
  readonly uncertain: (reason: string) => Effect.Effect<void>
  readonly emit: (event: AgentEvent) => Effect.Effect<void>
  readonly output: (event: AgentDelta) => void
}

/** Map one host frame onto the Worker-facing ThreadAgent events. */
function receiveEvent(state: HostState, frame: import('./protocol.ts').HostEvent): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (frame.generation !== state.generation() || frame.sequence !== state.sequence() + 1)
      return yield* state.uncertain('Agent event generation or sequence mismatch')
    state.setSequence(frame.sequence)
    const event = frame.event
    if (event.type === 'uncertain') return yield* state.uncertain(event.reason)
    const active = state.active()
    // Delayed text from a completed input cannot belong to the next turn.
    if (event.type === 'delta' && (!active || active.ended || event.messageId !== active.messageId)) return
    if (
      !state.nativeSessionId() ||
      !active ||
      active.ended ||
      event.nativeSessionId !== state.nativeSessionId() ||
      event.messageId !== active.messageId ||
      (active.executionId !== undefined && event.executionId !== active.executionId)
    )
      return yield* state.uncertain('Agent event execution identity mismatch')
    state.setExecutionId(event.executionId)
    if (event.type === 'end') state.markEnded()
    if (event.type === 'delta') {
      yield* Effect.try({
        try: () => state.output(event),
        catch: () => new AgentError('Agent live text sink failed'),
      }).pipe(Effect.catch(() => state.uncertain('Agent live text sink failed')))
    } else yield* state.emit(event)
  })
}
