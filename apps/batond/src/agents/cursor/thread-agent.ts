import { randomUUID } from 'node:crypto'
import { Effect, Exit, Queue, Scope, Stream } from 'effect'
import type { WorkerOpenConfig } from '@baton/protocol'
import {
  AgentError,
  type AgentEvent,
  type AgentFactory,
  type AgentMessage,
  type InputPreparation,
  type ThreadAgent,
} from '../../worker/agent.ts'
import { findSent, messageBinding, prepare, validatePreparation } from './evidence.ts'
import { loadMapping, persistMapping, statePath } from './mapping.ts'
import type { NativeMapping, HostEvent } from './protocol.ts'
import { connectCursorHost, type CursorHostConnection, type CursorProcessOptions } from './transport.ts'

export interface CursorDelta {
  readonly type: 'delta'
  readonly nativeSessionId: string
  readonly messageId: string
  readonly executionId: string
  readonly id: string
  readonly text: string
}

export interface CursorAgentOptions extends CursorProcessOptions {
  /** Receives validated live text. The sink must return immediately. */
  readonly onDelta?: (event: CursorDelta) => void
  readonly connect?: (signal: AbortSignal) => Effect.Effect<CursorHostConnection, AgentError>
  readonly eventCapacity?: number
}

export const makeCursorAgentFactory =
  (options: CursorAgentOptions): AgentFactory =>
  (config) =>
    makeCursorAgent(config, options)

function makeCursorAgent(config: WorkerOpenConfig, options: CursorAgentOptions): ThreadAgent {
  // These allocations only establish local state; host and filesystem work starts inside Effects.
  const scope = Scope.makeUnsafe()
  const queue = Effect.runSync(Queue.dropping<AgentEvent>(options.eventCapacity ?? 256))
  const controller = new AbortController()
  const connections = new Set<CursorHostConnection>()
  const pending = new Set<Promise<CursorHostConnection>>()
  let live: CursorHostConnection | undefined
  let mapping: NativeMapping | undefined
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
        cause instanceof AgentError ? cause : new AgentError('Cursor native state operation failed', cause),
    })
  const readerOwners = new WeakMap<CursorHostConnection, AbortController>()
  const connect = (readOnly = false) =>
    Effect.gen(function* () {
      if ((stopped && !readOnly) || reaping) return yield* Effect.fail(new AgentError('Cursor agent is stopped'))
      // Track startup separately so reap cannot report success while a host is still being registered.
      const readerController = readOnly ? new AbortController() : undefined
      if (readerController) readers.add(readerController)
      const signal = readerController?.signal ?? controller.signal
      const promise = Effect.runPromise(
        options.connect ? options.connect(signal) : connectCursorHost(options, signal),
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
        return yield* Effect.fail(new AgentError('Cursor startup was cancelled'))
      }
      return host
    })
  const emit = (event: AgentEvent): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (!(yield* Queue.offer(queue, event))) {
        broken = true
        yield* Queue.clear(queue)
        yield* Queue.offer(queue, { type: 'uncertain', reason: 'Cursor event buffer overflow' })
        if (live) yield* live.disconnect
      }
    })
  const uncertain = (reason: string) =>
    Effect.gen(function* () {
      if (broken) return
      broken = true
      yield* emit({ type: 'uncertain', reason })
      if (live) yield* live.disconnect
    })
  const receive = (frame: HostEvent) =>
    Effect.gen(function* () {
      if (broken) return
      if (frame.generation !== generation || frame.sequence !== sequence + 1)
        return yield* uncertain('Cursor event generation or sequence mismatch')
      sequence = frame.sequence
      const event = frame.event
      if (event.type === 'uncertain') return yield* uncertain(event.reason)
      if (
        !mapping ||
        !active ||
        active.ended ||
        event.nativeSessionId !== mapping.nativeSessionId ||
        event.messageId !== active.messageId ||
        (active.executionId !== undefined && event.executionId !== active.executionId)
      )
        return yield* uncertain('Cursor event execution identity mismatch')
      active.executionId ??= event.executionId
      if (event.type === 'end') active.ended = true
      if (event.type === 'delta') {
        yield* Effect.try({
          try: () => options.onDelta?.(event),
          catch: () => new AgentError('Cursor live text sink failed'),
        }).pipe(Effect.catch(() => uncertain('Cursor live text sink failed')))
      } else yield* emit(event)
    })
  const nativeMapping = () =>
    Effect.gen(function* () {
      if (config.agent_type !== 'cursor')
        return yield* Effect.fail(new AgentError('Cursor factory requires agent_type cursor'))
      mapping ??= yield* io(() => loadMapping(config))
      return mapping
    })
  const readonlyHistory = () =>
    Effect.gen(function* () {
      const native = yield* nativeMapping()
      const host = yield* connect(true)
      return yield* host.history(native).pipe(
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
    })
  const start = (openConfig: WorkerOpenConfig, nativeSessionId?: string) =>
    Effect.gen(function* () {
      if (
        config.agent_type !== 'cursor' ||
        openConfig.agent_type !== 'cursor' ||
        opening ||
        live ||
        stopped ||
        config.thread_id !== openConfig.thread_id ||
        statePath(config) !== statePath(openConfig)
      )
        return yield* Effect.fail(new AgentError('Cursor lifecycle or configuration mismatch'))
      opening = true
      return yield* Effect.gen(function* () {
        const existing = nativeSessionId ? yield* io(() => loadMapping(config, nativeSessionId)) : undefined
        if (!nativeSessionId) {
          const existingFile = yield* io(async () => {
            try {
              await loadMapping(config)
              return true
            } catch (error) {
              if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false
              throw error
            }
          })
          if (existingFile)
            return yield* Effect.fail(new AgentError('Cursor mapping already exists; resume explicitly'))
        }
        const host = yield* connect()
        live = host
        generation = randomUUID()
        sequence = 0
        mapping = yield* host.open(config, generation, existing)
        if (stopped) return yield* Effect.fail(new AgentError('Cursor startup was cancelled'))
        yield* io(() => persistMapping(mapping!))
        yield* Stream.runForEach(host.events, receive).pipe(
          Effect.catch((error) => (reaping ? Effect.void : uncertain(error.message))),
          Effect.forkIn(scope),
        )
        yield* host.exited.pipe(
          Effect.andThen(emit({ type: 'exited', reason: 'Cursor host exited', processTreeStopped: false })),
          Effect.ignore,
          Effect.forkIn(scope),
        )
        return { nativeSessionId: mapping.nativeSessionId }
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
    resume: (nativeSessionId, openConfig) => start(openConfig, nativeSessionId),
    prepareInput: (message) =>
      Effect.gen(function* () {
        if (!live || broken || stopped || (active && !active.ended))
          return yield* Effect.fail(new AgentError('Cursor cannot prepare an input in its current state'))
        if (message.model !== undefined && message.model !== (config.model ?? config.adapter_config.model ?? 'default'))
          return yield* Effect.fail(new AgentError('Cursor does not support changing the model of an open Thread'))
        const native = yield* nativeMapping()
        if (
          prepared?.message.id === message.id &&
          prepared.preparation.preparationId === messageBinding(message, native)
        )
          return prepared.preparation
        if (message.mode === 'steer') return yield* Effect.fail(new AgentError('Cursor does not support steer'))
        const history = yield* readonlyHistory().pipe(
          Effect.timeout('10 seconds'),
          Effect.mapError((cause) => new AgentError('Cursor input preparation failed', cause)),
        )
        if (stopped) return yield* Effect.fail(new AgentError('Cursor input preparation was cancelled'))
        const preparation = prepare(message, native, history)
        prepared = { message, preparation }
        return preparation
      }),
    restoreInput: (message, preparation) =>
      Effect.try({
        try: () => {
          // Restoring does not read mapping or history. Full mapping validation occurs in sent/send.
          if (Buffer.byteLength(JSON.stringify(preparation)) > 4096)
            throw new AgentError('Cursor preparation exceeds size limit')
          prepared = { message, preparation }
        },
        catch: (cause) => (cause instanceof AgentError ? cause : new AgentError('Invalid Cursor preparation', cause)),
      }),
    send: (message, preparation) =>
      Effect.gen(function* () {
        if (!live || broken || stopped || (active && !active.ended))
          return yield* Effect.fail(new AgentError('Cursor execution channel is not available'))
        const native = yield* nativeMapping()
        yield* Effect.try({
          try: () => validatePreparation(message, native, preparation),
          catch: (cause) => new AgentError('Cursor preparation identity mismatch', cause),
        })
        if (
          prepared?.preparation.preparationId !== preparation.preparationId ||
          JSON.stringify(prepared.preparation) !== JSON.stringify(preparation)
        )
          return yield* Effect.fail(new AgentError('Cursor input was not prepared or restored'))
        active = { messageId: message.id, ended: false }
        const accepted = yield* live
          .send(message, preparation)
          .pipe(Effect.tapError((error) => uncertain(error.message)))
        if (
          accepted.nativeSessionId !== native.nativeSessionId ||
          (active.executionId && active.executionId !== accepted.executionId)
        )
          return yield* Effect.fail(new AgentError('Cursor acceptance identity mismatch'))
        active.executionId = accepted.executionId
        prepared = undefined
        return accepted
      }),
    sent: (message, preparation) =>
      Effect.gen(function* () {
        const native = yield* nativeMapping()
        const history = yield* readonlyHistory()
        return yield* Effect.try({
          try: () => findSent(message, native, preparation, history),
          catch: (cause) => new AgentError('Cursor input evidence is invalid', cause),
        })
      }),
    events: Stream.fromQueue(queue),
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
        yield* io(() => Promise.allSettled([...pending]))
        let processTreeStopped = true
        for (const host of connections) {
          yield* host.disconnect
          const result = yield* host.reap
          processTreeStopped &&= result.processTreeStopped
        }
        yield* Scope.close(scope, Exit.void)
        return { processTreeStopped }
      }),
    readHistory: (cursor) =>
      Effect.gen(function* () {
        if (cursor !== undefined) return yield* Effect.fail(new AgentError('Cursor history cursor is not supported'))
        const history = yield* readonlyHistory()
        return { native_session_id: mapping!.nativeSessionId, messages: history.map((entry) => ({ ...entry })) }
      }),
  }
  return agent
}
