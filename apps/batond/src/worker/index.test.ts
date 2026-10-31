import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { join, dirname } from 'node:path'
import { saveUpgradeState } from '../daemon/upgrade.ts'
import { DatabaseSync } from 'node:sqlite'
import {
  WorkerIPCMessage as WorkerIPCMessageSchema,
  ThreadReport as ThreadReportSchema,
  type ThreadAnswerInput,
  type ThreadReport,
  type WorkerOpenConfig,
  type WorkerRequest,
} from '@baton/protocol'
import { Clock, Deferred, Effect, Exit, Fiber, Logger, Option, Queue, References, Schema, Stream, Tracer } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { vi } from 'vite-plus/test'
import { TestClock } from 'effect/testing'
import { openWorkerLedger } from './ledger.ts'
import { makeOutputMailbox } from './output.ts'
import {
  AgentError,
  makeWorker,
  type AgentEvent,
  type AgentMessage,
  type InputAcceptance,
  type InputPreparation,
  type ThreadAgent,
  type Worker,
} from './index.ts'

const config = (): WorkerOpenConfig => ({
  thread_id: randomUUID(),
  node_id: randomUUID(),
  storage_generation: randomUUID(),
  agent_type: 'cursor',
  runtime_mode: 'full-access',
  working_directory: '/tmp',
  execution_timeout_seconds: 60,
  adapter_config: {},
})
const request = (
  cfg: WorkerOpenConfig,
  type: 'thread_open' | 'thread_message' | 'thread_stop' | 'thread_resume' | 'thread_answer',
  fields: Partial<WorkerRequest> = {},
): WorkerRequest =>
  ({
    type,
    ok: true,
    thread_id: cfg.thread_id,
    storage_generation: cfg.storage_generation,
    command_id: randomUUID(),
    ...(type === 'thread_open' ? { open_config: cfg } : {}),
    ...fields,
  }) as WorkerRequest
const message = (cfg: WorkerOpenConfig, text = 'hello') =>
  request(cfg, 'thread_message', { client_message_id: randomUUID(), payload: text })
const reports = (worker: Worker) =>
  worker.handle({ type: 'thread_pending', ok: true }).pipe(Effect.map((result) => result.thread_reports ?? []))
// 只等待内存替身和同步 SQLite 产生的状态；调用前释放 Deferred 或推进 TestClock。
const until = <A, E>(read: Effect.Effect<A, E>, predicate: (value: A) => boolean): Effect.Effect<A, E | AgentError> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 500; attempt++) {
      const value = yield* read
      if (predicate(value)) return value
      yield* Effect.yieldNow
    }
    return yield* Effect.fail(new AgentError('Condition did not become true'))
  })
const completed = (worker: Worker, id: string) =>
  until(reports(worker), (items) => items.some((item) => item.kind === 'command.completed' && item.command_id === id))
const opened = (worker: Worker) =>
  until(worker.handle({ type: 'status', ok: true }), (result) => result.agent_ready === true)
const findCompletion = (items: readonly ThreadReport[], id: string) =>
  items.find((item) => item.kind === 'command.completed' && item.command_id === id)

interface Fake {
  readonly agent: ThreadAgent
  readonly events: Queue.Queue<AgentEvent>
  readonly output: ReturnType<typeof makeOutputMailbox>
  readonly callEvents: Queue.Queue<string>
  readonly calls: string[]
  readonly sentInputs: AgentMessage[]
  readonly restored: InputPreparation[]
  readonly evidence: Map<string, InputAcceptance>
  openTask?: Effect.Effect<void, AgentError>
  prepareTask?: Effect.Effect<void, AgentError>
  sendTask?: Effect.Effect<void, AgentError>
  reapTask?: Effect.Effect<void, AgentError>
  duringSend?: (input: AgentMessage) => Effect.Effect<void, AgentError>
}
const fake = Effect.gen(function* () {
  const events = yield* Queue.unbounded<AgentEvent>()
  const output = makeOutputMailbox()
  const calls: string[] = []
  const callEvents = yield* Queue.unbounded<string>()
  const record = (call: string) => {
    calls.push(call)
    Queue.offerUnsafe(callEvents, call)
  }
  const sentInputs: AgentMessage[] = []
  const restored: InputPreparation[] = []
  const evidence = new Map<string, InputAcceptance>()
  const result: Fake = {
    events,
    output,
    calls,
    callEvents,
    sentInputs,
    restored,
    evidence,
    agent: {
      open: () =>
        Effect.gen(function* () {
          record('open')
          if (result.openTask) yield* result.openTask
          return { nativeSessionId: 'native' }
        }),
      resume: () =>
        Effect.sync(() => {
          record('resume')
          return { nativeSessionId: 'native' }
        }),
      prepareInput: (input) =>
        Effect.gen(function* () {
          record(`prepare:${input.id}`)
          if (result.prepareTask) yield* result.prepareTask
          return { nativeSessionId: 'native', preparationId: `prep:${input.id}`, confirmedSends: 0 }
        }),
      restoreInput: (_, preparation) =>
        Effect.sync(() => {
          restored.push(preparation)
        }),
      send: (input) =>
        Effect.gen(function* () {
          record(`send:${input.id}`)
          sentInputs.push(input)
          if (result.duringSend) yield* result.duringSend(input)
          if (result.sendTask) yield* result.sendTask
          const acceptance = { nativeSessionId: 'native', executionId: `exec:${input.id}` }
          evidence.set(input.id, acceptance)
          return acceptance
        }),
      sent: (input) =>
        Effect.sync(() => {
          record(`sent:${input.id}`)
          return evidence.get(input.id)
        }),
      events: Stream.fromQueue(events),
      output: output.stream,
      abort: () =>
        Effect.sync(() => {
          record('abort')
        }),
      close: () =>
        Effect.sync(() => {
          record('close')
        }),
      reap: () =>
        Effect.gen(function* () {
          record('reap')
          if (result.reapTask) yield* result.reapTask
          return { processTreeStopped: true }
        }),
    },
  }
  return result
})
const called = (fixture: Fake, call: string) =>
  Stream.runHead(Stream.fromQueue(fixture.callEvents).pipe(Stream.filter((value) => value === call)))
const fixture = <A, E, R>(body: (filename: string) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.acquireRelease(
      Effect.promise(() => makePrivateTempDirectory('baton-worker-')),
      (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
    ).pipe(Effect.flatMap((directory) => body(join(directory, 'thread.db')))),
  )
const event = (id: string, type: 'end' | 'reply'): AgentEvent =>
  type === 'end'
    ? { type, nativeSessionId: 'native', messageId: id, executionId: `exec:${id}`, outcome: 'completed' }
    : { type, nativeSessionId: 'native', messageId: id, executionId: `exec:${id}`, id: `reply:${id}`, text: 'answer' }

const readOutput = (worker: Worker, cfg: WorkerOpenConfig, cursor?: string) =>
  worker
    .handle({
      type: 'session_request',
      ok: true,
      session_request: {
        type: 'session.request',
        operation_id: randomUUID(),
        session_id: cfg.thread_id,
        action: 'output',
        ...(cursor === undefined ? {} : { cursor }),
      },
    })
    .pipe(
      Effect.map((response) => {
        expect(Schema.is(WorkerIPCMessageSchema)(response)).toBe(true)
        return response.session_result!
      }),
    )
const delta = (id: string, text: string) => ({
  nativeSessionId: 'native',
  messageId: id,
  executionId: `exec:${id}`,
  text,
})

const readyWorker = Effect.fnUntraced(function* (dbPath: string) {
  const cfg = config()
  const f = yield* fake
  const worker = yield* makeWorker({ dbPath, agentFactory: () => f.agent })
  yield* worker.handle(request(cfg, 'thread_open'))
  yield* opened(worker)
  return { cfg, f, worker }
})

describe('reliable Worker', () => {
  it.effect('reports bound identity and idle state for adaptive report polling', () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { cfg, f, worker } = yield* readyWorker(dbPath)
        const pending = () => worker.handle({ type: 'thread_pending', ok: false })
        yield* until(pending(), (reply) => reply.worker_idle === true)
        expect(Schema.is(WorkerIPCMessageSchema)(yield* pending())).toBe(true)
        expect(yield* pending()).toMatchObject({
          worker_ready: true,
          worker_idle: true,
          session_id: cfg.thread_id,
          storage_generation: cfg.storage_generation,
          runtime_mode: cfg.runtime_mode,
        })
        const input = message(cfg)
        yield* worker.handle(input)
        yield* completed(worker, input.command_id!)
        expect((yield* pending()).worker_idle).toBe(false)
        const stop = request(cfg, 'thread_stop')
        yield* worker.handle(stop)
        yield* Queue.offer(f.events, event(input.client_message_id!, 'end'))
        yield* completed(worker, stop.command_id!)
        yield* until(pending(), (reply) => reply.worker_idle === true)
      }),
    ),
  )

  it.effect('keeps the Turn span open through output and ends it with reported usage', () =>
    fixture((dbPath) => {
      const spans: Tracer.NativeSpan[] = []
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        },
      })
      return Effect.gen(function* () {
        const { cfg, f, worker } = yield* readyWorker(dbPath)
        const input = message(cfg)
        yield* worker.handle(input)
        yield* completed(worker, input.command_id!)
        const turn = spans.find((span) => span.name === 'baton.turn')!
        expect(turn.status._tag).toBe('Started')
        const reply = event(input.client_message_id!, 'reply')
        if (reply.type !== 'reply') throw new Error('Expected reply')
        yield* Queue.offer(f.events, { ...reply, truncated: true, original_bytes: 512 })
        yield* Queue.offer(f.events, {
          ...delta(input.client_message_id!, ''),
          type: 'end',
          outcome: 'completed',
          tokenUsage: { inputTokens: 0, outputTokens: 3 },
        })
        yield* until(reports(worker), (items) => items.some((item) => item.kind === 'turn.ended'))
        expect(turn.status._tag).toBe('Ended')
        expect(turn.attributes.get('baton.turn.seq')).toBe(1)
        expect(turn.attributes.get('baton.turn.result')).toBe('completed')
        expect(turn.attributes.get('baton.turn.first_output_ms')).toEqual(expect.any(Number))
        expect(turn.attributes.get('baton.usage.reported')).toBe(true)
        expect(turn.attributes.get('gen_ai.usage.input_tokens')).toBe(0)
        const output = spans.find((span) => span.name === 'baton.output')!
        expect(output.attributes.get('baton.output.truncated')).toBe(true)
        expect(output.attributes.get('baton.output.bytes')).toBe(512)
      }).pipe(Effect.provideService(Tracer.Tracer, tracer))
    }),
  )

  it.effect('records the confirmed stop result on the command trace', () =>
    fixture((dbPath) => {
      const spans: Tracer.NativeSpan[] = []
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        },
      })
      return Effect.gen(function* () {
        const { cfg, worker } = yield* readyWorker(dbPath)
        const stopping = request(cfg, 'thread_stop')
        yield* worker.handle(stopping)
        yield* completed(worker, stopping.command_id!)
        expect(spans.find((span) => span.name === 'baton.worker.stop')?.attributes.get('baton.stop.result')).toBe(
          'stopped',
        )
      }).pipe(Effect.provideService(Tracer.Tracer, tracer))
    }),
  )

  it.effect('records an unknown stop outcome without inventing confirmation', () =>
    fixture((dbPath) => {
      const spans: Tracer.NativeSpan[] = []
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        },
      })
      return Effect.gen(function* () {
        const cfg = config()
        const f = yield* fake
        f.sendTask = Effect.never
        const worker = yield* makeWorker({ dbPath, agentFactory: () => f.agent, stopTimeoutMs: 200 })
        yield* worker.handle(request(cfg, 'thread_open'))
        yield* opened(worker)
        const input = message(cfg)
        yield* worker.handle(input)
        yield* called(f, `send:${input.client_message_id}`)
        const stopping = request(cfg, 'thread_stop')
        yield* worker.handle(stopping)
        yield* Queue.offer(f.events, {
          type: 'exited',
          reason: 'Process tree termination confirmed',
          processTreeStopped: true,
        })
        yield* completed(worker, stopping.command_id!)
        expect(spans.find((span) => span.name === 'baton.worker.stop')?.attributes.get('baton.stop.result')).toBe(
          'unknown',
        )
      }).pipe(Effect.provideService(Tracer.Tracer, tracer))
    }),
  )

  it.effect('marks a failed Turn without exporting the provider error text', () =>
    fixture((dbPath) => {
      const spans: Tracer.NativeSpan[] = []
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        },
      })
      return Effect.gen(function* () {
        const { cfg, f, worker } = yield* readyWorker(dbPath)
        const input = message(cfg)
        yield* worker.handle(input)
        yield* completed(worker, input.command_id!)
        yield* Queue.offer(f.events, {
          ...delta(input.client_message_id!, ''),
          type: 'end',
          outcome: 'failed',
          reason: 'private provider error',
        })
        yield* until(reports(worker), (items) => items.some((item) => item.kind === 'turn.ended'))
        const turn = spans.find((span) => span.name === 'baton.turn')!
        expect(turn.attributes.get('baton.turn.result')).toBe('failed')
        expect(turn.attributes.get('baton.error.code')).toBe('turn_failed')
        expect(turn.attributes.get('baton.usage.reported')).toBe(false)
        expect(turn.status._tag === 'Ended' && Exit.isFailure(turn.status.exit)).toBe(true)
        expect(JSON.stringify([...turn.attributes])).not.toContain('private provider error')
      }).pipe(Effect.provideService(Tracer.Tracer, tracer))
    }),
  )

  it.effect('starts the Turn timing at message receipt after a queued wait', () =>
    fixture((dbPath) => {
      const spans: Tracer.NativeSpan[] = []
      const logs: Array<{ message: unknown; attributes: Readonly<Record<string, unknown>>; traceId?: string }> = []
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        },
      })
      return Effect.gen(function* () {
        const { cfg, f, worker } = yield* readyWorker(dbPath)
        const release = yield* Deferred.make<void>()
        f.prepareTask = Deferred.await(release)
        const clock = yield* Clock.Clock
        const before = clock.currentTimeMillisUnsafe()
        const input = { ...message(cfg), trace_context: { traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01` } }
        yield* worker.handle(input)
        yield* called(f, `prepare:${input.client_message_id}`)
        expect(spans.some((span) => span.name === 'baton.turn')).toBe(false)
        yield* TestClock.adjust('5 seconds')
        yield* Deferred.succeed(release, undefined)
        yield* completed(worker, input.command_id!)
        const turn = spans.find((span) => span.name === 'baton.turn')!
        expect(turn.status.startTime).toBe(BigInt(before) * 1_000_000n)
        const waits = logs.filter(
          (entry) => Array.isArray(entry.message) && String(entry.message[0]).startsWith('baton.wait.'),
        )
        expect(waits.map((entry) => entry.message)).toEqual([['baton.wait.start'], ['baton.wait.end']])
        expect(waits[1]!.attributes['baton.wait.duration_ms']).toBe(5000)
        expect(
          waits.every((entry) => entry.attributes['baton.wait.reason'] === 'queue' && entry.traceId === 'a'.repeat(32)),
        ).toBe(true)
      }).pipe(
        Effect.provideService(Tracer.Tracer, tracer),
        Effect.provideService(
          Logger.CurrentLoggers,
          new Set([
            Logger.make(({ message, fiber }) =>
              logs.push({
                message,
                attributes: fiber.getRef(References.CurrentLogAnnotations),
                ...(fiber.cache.span ? { traceId: fiber.cache.span.traceId } : {}),
              }),
            ),
          ]),
        ),
      )
    }),
  )
  it.effect('returns the current execution identity only while a freshly queried turn is active', () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { cfg, f, worker } = yield* readyWorker(dbPath)
        expect((yield* worker.handle({ type: 'status', ok: false, activity_check_seq: 1 })).active_turn).toBeUndefined()
        const input = message(cfg)
        yield* worker.handle(input)
        const items = yield* completed(worker, input.command_id!)
        const started = items.find((item) => item.kind === 'turn.started')!
        expect(started.execution_id).toBe(`exec:${input.client_message_id}`)
        expect(yield* worker.handle({ type: 'status', ok: false, activity_check_seq: 2 })).toMatchObject({
          activity_check_seq: 2,
          active_turn: { worker_turn_seq: 1, execution_id: started.execution_id },
        })
        yield* Queue.offer(f.events, event(input.client_message_id!, 'end'))
        yield* until(reports(worker), (reports) => reports.some((item) => item.kind === 'turn.ended'))
        const ended = yield* worker.handle({ type: 'status', ok: false, activity_check_seq: 3 })
        expect(ended.activity_check_seq).toBe(3)
        expect(ended.active_turn).toBeUndefined()
      }),
    ),
  )

  it.effect('waits for the active turn before retiring a Worker for an environment change', () =>
    fixture((dbPath) =>
      Effect.scoped(
        Effect.gen(function* () {
          const cfg = config()
          const f = yield* fake
          const worker = yield* makeWorker({ dbPath, dataDirectory: dirname(dbPath), agentFactory: () => f.agent })
          yield* worker.handle(request(cfg, 'thread_open'))
          yield* opened(worker)
          const input = message(cfg)
          yield* worker.handle(input)
          yield* completed(worker, input.command_id!)
          expect(yield* worker.drainForEnvironment).toBe(false)
          yield* Queue.offer(f.events, event(input.client_message_id!, 'end'))
          yield* until(reports(worker), (rows) => rows.some((row) => row.kind === 'turn.ended'))
          expect(yield* until(worker.drainForEnvironment, Boolean)).toBe(true)
        }),
      ),
    ),
  )

  it.effect('recovers queued input after retiring a Worker for an environment change', () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const cfg = config()
        const first = message(cfg)
        const queued = message(cfg, 'queued')
        const upgrade = {
          operation_id: randomUUID(),
          source_version: 'development',
          target_version: 'v1',
          target_path: '/tmp/package',
          phase: 'draining' as const,
        }
        yield* Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fake
            const worker = yield* makeWorker({ dbPath, dataDirectory: dirname(dbPath), agentFactory: () => f.agent })
            yield* worker.handle(request(cfg, 'thread_open'))
            yield* opened(worker)
            yield* worker.handle(first)
            yield* completed(worker, first.command_id!)
            yield* Effect.promise(() => saveUpgradeState(dirname(dbPath), upgrade))
            yield* worker.handle(queued)
            expect(yield* worker.drainForEnvironment).toBe(false)
            yield* Queue.offer(f.events, event(first.client_message_id!, 'end'))
            yield* until(reports(worker), (rows) => rows.some((row) => row.kind === 'turn.ended'))
            expect(yield* until(worker.drainForEnvironment, Boolean)).toBe(true)
          }),
        )
        yield* Effect.promise(() => saveUpgradeState(dirname(dbPath), { ...upgrade, phase: 'cancelled' }))
        yield* Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fake
            const worker = yield* makeWorker({ dbPath, dataDirectory: dirname(dbPath), agentFactory: () => f.agent })
            yield* completed(worker, queued.command_id!)
            expect(f.sentInputs.map((input) => input.id)).toContain(queued.client_message_id)
            yield* Queue.offer(f.events, event(queued.client_message_id!, 'end'))
          }),
        )
      }),
    ),
  )

  it.effect(
    'preserves queued inputs while draining, finishes the active turn and resumes only after cancellation',
    () =>
      fixture((dbPath) =>
        Effect.scoped(
          Effect.gen(function* () {
            const cfg = config()
            const f = yield* fake
            const worker = yield* makeWorker({ dbPath, dataDirectory: dirname(dbPath), agentFactory: () => f.agent })
            yield* worker.handle(request(cfg, 'thread_open'))
            yield* opened(worker)
            const first = message(cfg)
            const second = message(cfg, 'queued before prepare')
            const third = message(cfg, 'queued during prepare')
            yield* worker.handle(first)
            yield* completed(worker, first.command_id!)
            yield* worker.handle(second)
            const state = {
              operation_id: randomUUID(),
              source_version: 'development',
              target_version: 'v1',
              target_path: '/tmp/package',
              phase: 'draining' as const,
            }
            yield* Effect.promise(() => saveUpgradeState(dirname(dbPath), state))
            expect((yield* worker.handle(third)).ok).toBe(true)
            const withdrawn = message(cfg, 'withdraw during prepare')
            yield* worker.handle(withdrawn)
            yield* worker.handle({
              type: 'thread_withdraw',
              ok: true,
              command_id: randomUUID(),
              thread_id: cfg.thread_id,
              storage_generation: cfg.storage_generation,
              client_message_id: withdrawn.client_message_id!,
            })
            const cancelled = yield* completed(worker, withdrawn.command_id!)
            expect(findCompletion(cancelled, withdrawn.command_id!)?.command_outcome).toBe('cancelled')
            expect(yield* worker.drain).toBe(false)
            yield* Queue.offer(f.events, event(first.client_message_id!, 'end'))
            yield* until(reports(worker), (rows) => rows.some((row) => row.kind === 'turn.ended'))
            expect(f.sentInputs.map((input) => input.id)).toEqual([first.client_message_id])
            const db = new DatabaseSync(dbPath, { readOnly: true })
            try {
              const queued = db
                .prepare('SELECT payload FROM thread_messages WHERE id IN (?,?)')
                .all(second.client_message_id!, third.client_message_id!)
              expect(queued.map((row) => JSON.parse(String(row.payload)).state)).toEqual(['queued', 'queued'])
            } finally {
              db.close()
            }
            yield* Effect.promise(() => saveUpgradeState(dirname(dbPath), { ...state, phase: 'cancelled' }))
            expect(yield* worker.drain).toBe(false)
            yield* until(
              Effect.sync(() => f.sentInputs.some((input) => input.id === second.client_message_id)),
              Boolean,
            )
            yield* completed(worker, second.command_id!)
            yield* Queue.offer(f.events, event(second.client_message_id!, 'end'))
            yield* completed(worker, third.command_id!)
            expect(f.sentInputs.map((input) => input.id)).toEqual([
              first.client_message_id,
              second.client_message_id,
              third.client_message_id,
            ])
            yield* Queue.offer(f.events, event(third.client_message_id!, 'end'))
          }),
        ),
      ),
  )

  it.effect(
    'persists accepted models across rejection, omitted selections and Worker restart without replaying input',
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const cfg = { ...config(), model: 'initial-model' }
          const rejected = request(cfg, 'thread_message', {
            client_message_id: 'model-rejected',
            payload: 'rejected',
            model: 'bad-model',
          })
          yield* Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fake
              f.duringSend = (input) =>
                input.model === 'bad-model'
                  ? Effect.fail(new AgentError('Selected model rejected before input', undefined, true))
                  : Effect.void
              const worker = yield* makeWorker({ dbPath, agentFactory: () => f.agent })
              yield* worker.handle(request(cfg, 'thread_open'))
              yield* opened(worker)
              const first = request(cfg, 'thread_message', {
                client_message_id: 'model-first',
                payload: 'first',
                model: 'selected-model',
                thinking: { id: 'reasoningEffort', value: 'high' },
              })
              yield* worker.handle(first)
              yield* completed(worker, first.command_id ?? '')
              expect(f.sentInputs[0]?.thinking).toEqual({ id: 'reasoningEffort', value: 'high' })
              yield* Queue.offer(f.events, event('model-first', 'end'))
              const next = request(cfg, 'thread_message', { client_message_id: 'model-next', payload: 'next' })
              yield* worker.handle(rejected)
              yield* worker.handle(next)
              const items = yield* completed(worker, next.command_id ?? '')
              expect(findCompletion(items, rejected.command_id ?? '')?.command_outcome).toBe('cancelled')
              expect(items.some((item) => item.kind === 'thread.unknown')).toBe(false)
              expect(items.filter((item) => item.kind === 'turn.started').map((item) => item.worker_turn_seq)).toEqual([
                1, 2,
              ])
              expect(f.sentInputs.map((input) => [input.id, input.model])).toEqual([
                ['model-first', 'selected-model'],
                ['model-rejected', 'bad-model'],
                ['model-next', 'selected-model'],
              ])
              yield* Queue.offer(f.events, event('model-next', 'end'))
              yield* until(reports(worker), (items) =>
                items.some((item) => item.kind === 'turn.ended' && item.client_message_id === 'model-next'),
              )
              const stopping = request(cfg, 'thread_stop')
              yield* worker.handle(stopping)
              yield* completed(worker, stopping.command_id ?? '')
            }),
          )
          yield* Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fake
              const worker = yield* makeWorker({
                dbPath,
                agentFactory: () => ({
                  ...f.agent,
                  resume: (native, resumedConfig) => {
                    expect(resumedConfig.model).toBe('selected-model')
                    return f.agent.resume(native, resumedConfig)
                  },
                }),
              })
              const resuming = request(cfg, 'thread_resume')
              yield* worker.handle(resuming)
              yield* completed(worker, resuming.command_id ?? '')
              const next = request(cfg, 'thread_message', {
                client_message_id: 'model-after-restart',
                payload: 'after restart',
                thinking: { id: 'reasoningEffort', value: 'medium' },
              })
              yield* worker.handle(next)
              yield* completed(worker, next.command_id ?? '')
              expect(f.sentInputs.map((input) => [input.id, input.model])).toEqual([
                ['model-after-restart', 'selected-model'],
              ])
              expect(f.sentInputs[0]?.thinking).toEqual({ id: 'reasoningEffort', value: 'medium' })
              expect((yield* worker.handle(rejected)).command_status?.command_outcome).toBe('cancelled')
            }),
          )
        }),
      ),
  )

  describe('Agent questions', () => {
    it.effect('persists questions and answers once, rejects changed or stale answers, and cancels on stop', () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const cfg = config()
          yield* Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fake
              const answers: ThreadAnswerInput[] = []
              const worker = yield* makeWorker({
                dbPath,
                agentFactory: () => ({
                  ...f.agent,
                  answer: (answer) =>
                    Effect.sync(() => {
                      answers.push(answer)
                    }),
                }),
              })
              yield* worker.handle(request(cfg, 'thread_open'))
              yield* opened(worker)
              const input = message(cfg)
              yield* worker.handle(input)
              yield* completed(worker, input.command_id ?? '')
              const identity = {
                nativeSessionId: 'native',
                messageId: input.client_message_id ?? '',
                executionId: `exec:${input.client_message_id}`,
              }
              const question = {
                request_id: 'question-1',
                kind: 'user_input',
                questions: [{ id: 'choice', header: 'Choice', question: 'Which folder?', options: [] }],
              } satisfies import('@baton/protocol').ThreadQuestion
              yield* Queue.offer(f.events, { ...identity, type: 'question', question })
              yield* until(reports(worker), (items) => items.some((r) => r.kind === 'question.pending'))
              const answer = request(cfg, 'thread_answer', {
                answer: { request_id: question.request_id, decision: 'accept', answers: { choice: 'src' } },
              })
              const receipt = yield* worker.handle(answer)
              yield* completed(worker, answer.command_id ?? '')
              expect((yield* worker.handle(answer)).receipt).toEqual(receipt.receipt)
              expect(
                (yield* worker.handle({ ...answer, answer: { request_id: question.request_id, decision: 'cancel' } }))
                  .code,
              ).toBe('command_conflict')
              expect(answers).toEqual([answer.answer])
              const pending = { ...question, request_id: 'question-2' }
              yield* Queue.offer(f.events, { ...identity, type: 'question', question: pending })
              yield* until(reports(worker), (items) => items.some((r) => r.question?.request_id === pending.request_id))
              const stop = request(cfg, 'thread_stop')
              yield* worker.handle(stop)
              expect(
                (yield* worker.handle(
                  request(cfg, 'thread_answer', { answer: { request_id: pending.request_id, decision: 'cancel' } }),
                )).code,
              ).toBe('invalid_state')
              yield* Queue.offer(f.events, event(identity.messageId, 'end'))
              yield* completed(worker, stop.command_id ?? '')
              expect(f.sentInputs).toHaveLength(1)
            }),
          )
          const saved = (yield* openWorkerLedger({ dbPath })).initial
          expect(saved.questions?.map((q) => [q.question.request_id, q.state])).toEqual([
            ['question-1', 'resolved'],
            ['question-2', 'cancelled'],
          ])
        }),
      ),
    )
    it.effect('keeps answer failure when the native question closes before the response returns', () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const cfg = config()
          const f = yield* fake
          const release = yield* Deferred.make<void>()
          const input = message(cfg)
          const worker = yield* makeWorker({
            dbPath,
            agentFactory: () => ({
              ...f.agent,
              answer: () =>
                Effect.gen(function* () {
                  yield* Queue.offer(f.events, {
                    type: 'question.resolved',
                    requestId: 'expiring-question',
                    nativeSessionId: 'native',
                    messageId: input.client_message_id ?? '',
                    executionId: `exec:${input.client_message_id}`,
                  })
                  yield* Deferred.await(release)
                  return yield* Effect.fail(new AgentError('Native request expired'))
                }),
            }),
          })
          yield* worker.handle(request(cfg, 'thread_open'))
          yield* opened(worker)
          yield* worker.handle(input)
          yield* completed(worker, input.command_id ?? '')
          yield* Queue.offer(f.events, {
            type: 'question',
            nativeSessionId: 'native',
            messageId: input.client_message_id ?? '',
            executionId: `exec:${input.client_message_id}`,
            question: { request_id: 'expiring-question', kind: 'user_input', questions: [] },
          })
          yield* until(reports(worker), (items) => items.some((r) => r.kind === 'question.pending'))
          const answer = request(cfg, 'thread_answer', {
            answer: { request_id: 'expiring-question', decision: 'accept', answers: {} },
          })
          yield* worker.handle(answer)
          yield* until(reports(worker), (items) => items.some((r) => r.kind === 'question.resolved'))
          yield* Deferred.succeed(release, undefined)
          const items = yield* completed(worker, answer.command_id ?? '')
          expect(findCompletion(items, answer.command_id ?? '')?.command_outcome).toBe('unknown')
          expect((yield* worker.handle(answer)).command_status?.command_outcome).toBe('unknown')
          expect(f.sentInputs).toHaveLength(1)
        }),
      ),
    )
    it.effect('never replays an answer whose delivery was interrupted by Worker restart', () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const cfg = config()
          const answer = request(cfg, 'thread_answer', {
            answer: { request_id: 'interrupted-question', decision: 'accept', answers: { choice: 'src' } },
          })
          let answered = 0
          yield* Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fake
              const started = yield* Deferred.make<void>()
              const worker = yield* makeWorker({
                dbPath,
                agentFactory: () => ({
                  ...f.agent,
                  answer: () =>
                    Effect.gen(function* () {
                      answered++
                      yield* Deferred.succeed(started, undefined)
                      yield* Effect.never
                    }),
                }),
              })
              yield* worker.handle(request(cfg, 'thread_open'))
              yield* opened(worker)
              const input = message(cfg)
              yield* worker.handle(input)
              yield* completed(worker, input.command_id ?? '')
              yield* Queue.offer(f.events, {
                type: 'question',
                nativeSessionId: 'native',
                messageId: input.client_message_id ?? '',
                executionId: `exec:${input.client_message_id}`,
                question: { request_id: 'interrupted-question', kind: 'user_input', questions: [] },
              })
              yield* until(reports(worker), (items) => items.some((r) => r.kind === 'question.pending'))
              yield* worker.handle(answer)
              yield* Deferred.await(started)
            }),
          )
          const f = yield* fake
          const worker = yield* makeWorker({
            dbPath,
            agentFactory: () => ({
              ...f.agent,
              answer: () =>
                Effect.sync(() => {
                  answered++
                }),
            }),
          })
          const items = yield* completed(worker, answer.command_id ?? '')
          expect(findCompletion(items, answer.command_id ?? '')?.command_outcome).toBe('unknown')
          expect((yield* worker.handle(answer)).command_status?.command_outcome).toBe('unknown')
          expect(answered).toBe(1)
          expect(f.sentInputs).toHaveLength(0)
        }),
      ),
    )
  })

  describe('attachments and live output', () => {
    it.effect.each([false, true])('delivers the reply and logs failed attachment extraction (timeout: %s)', (timeout) =>
      fixture((dbPath) => {
        const diagnostics: unknown[] = []
        return Effect.gen(function* () {
          const cfg = config()
          const f = yield* fake
          const started = yield* Deferred.make<void>()
          const worker = yield* makeWorker({
            dbPath,
            agentFactory: () => f.agent,
            attachments: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined)
                if (timeout) return yield* Effect.never
                return yield* Effect.fail(new AgentError('private attachment error'))
              }),
          })
          yield* worker.handle(request(cfg, 'thread_open'))
          yield* opened(worker)
          const input = message(cfg)
          yield* worker.handle(input)
          yield* completed(worker, input.command_id!)
          yield* Queue.offer(f.events, event(input.client_message_id!, 'reply'))
          yield* Deferred.await(started)
          if (timeout) yield* TestClock.adjust('1 second')
          const output = yield* until(reports(worker), (rows) => rows.some((row) => row.kind === 'reply'))
          expect(output.find((row) => row.kind === 'reply')?.content).toBe('answer')
          expect(
            diagnostics.filter((message) => Array.isArray(message) && message[0] === 'Attachment extraction failed'),
          ).toEqual([
            [
              'Attachment extraction failed',
              { thread_id: cfg.thread_id, code: timeout ? 'TimeoutError' : 'AgentError' },
            ],
          ])
        }).pipe(
          Effect.provideService(
            Logger.CurrentLoggers,
            new Set([Logger.make(({ message }) => diagnostics.push(message))]),
          ),
        )
      }),
    )
    it.effect('persists attachment references while parsing outside the command queue', () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const attachments = [
            {
              kind: 'file',
              node_id: randomUUID(),
              root_id: 'workspace',
              path: 'artifact.log',
              access_status: 'available',
            },
          ]
          yield* Effect.scoped(
            Effect.gen(function* () {
              const cfg = config(),
                f = yield* fake
              const started = yield* Deferred.make<void>()
              const release = yield* Deferred.make<void>()
              const worker = yield* makeWorker({
                dbPath,
                agentFactory: () => f.agent,
                attachments: () =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(started, undefined)
                    yield* Deferred.await(release)
                    return attachments
                  }),
              })
              yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
              yield* worker.handle(request(cfg, 'thread_open'))
              yield* opened(worker)
              const input = message(cfg)
              yield* worker.handle(input)
              yield* completed(worker, input.command_id!)
              yield* Queue.offer(f.events, event(input.client_message_id!, 'reply'))
              yield* Deferred.await(started)
              expect((yield* worker.handle({ type: 'status', ok: true }).pipe(Effect.timeout(1000))).ok).toBe(true)
              yield* Deferred.succeed(release, undefined)
              const output = yield* until(reports(worker), (rows) => rows.some((row) => row.kind === 'reply'))
              expect(output.find((row) => row.kind === 'reply')?.attachments).toEqual(attachments)
            }),
          )
          const reader = new DatabaseSync(dbPath, { readOnly: true })
          try {
            const row = reader
              .prepare("SELECT payload FROM thread_outbox WHERE json_extract(payload,'$.report.kind')='reply'")
              .get()
            expect(typeof row?.payload).toBe('string')
            if (typeof row?.payload !== 'string') throw new Error('Expected a persisted reply')
            const saved = Schema.decodeUnknownSync(Schema.Struct({ report: ThreadReportSchema }))(
              JSON.parse(row.payload),
            )
            expect(saved.report.attachments).toEqual(attachments)
          } finally {
            reader.close()
          }
        }),
      ),
    )
    it.effect('serves fresh output before acceptance without ledger writes and clears it between turns', () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const cfg = config()
              const f = yield* fake
              const gate = yield* Deferred.make<void>()
              f.sendTask = Deferred.await(gate)
              const worker = yield* makeWorker({ dbPath, agentFactory: () => f.agent })
              yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined))
              yield* worker.handle(request(cfg, 'thread_open'))
              yield* opened(worker)
              const first = message(cfg)
              yield* worker.handle(first)
              yield* called(f, `send:${first.client_message_id}`)
              const initial = yield* readOutput(worker, cfg)
              const db = new DatabaseSync(dbPath, { readOnly: true })
              const runningStep = {
                item_id: 'step',
                type: 'dynamic_tool',
                status: 'running',
                ordinal: 0,
                data: { input: 'read' },
                truncated: false,
                original_bytes: 16,
              }
              try {
                const token = db.prepare('SELECT commit_token FROM worker_commit').get()?.commit_token
                f.output.offer({
                  ...delta(first.client_message_id!, ''),
                  runningSteps: [runningStep],
                  runningStepsTruncated: false,
                })
                const steps = yield* until(readOutput(worker, cfg), (result) => result.running_steps?.length === 1)
                expect(steps.running_steps).toEqual([runningStep])
                f.output.offer(delta(first.client_message_id!, 'live 😀'))
                const live = yield* until(
                  readOutput(worker, cfg, initial.cursor),
                  (result) => result.text === 'live 😀',
                )
                expect(live.state).toBe('running')
                expect(live.gap).toBe(false)
                expect(live.running_steps).toEqual([runningStep])
                f.output.offer({ ...delta(first.client_message_id!, 'lost'), gap: true })
                const lost = yield* until(readOutput(worker, cfg, live.cursor), (result) => result.gap)
                expect(lost.text).toBe('lost')
                f.output.offer({ ...delta(first.client_message_id!, 'first reply'), replyId: 'reply-one' })
                const reply = yield* until(readOutput(worker, cfg), (result) => result.reply_id === 'reply-one')
                expect(reply).toMatchObject({ text: 'first reply', reply_id: 'reply-one', worker_turn_seq: 1 })
                f.output.offer({ ...delta(first.client_message_id!, 'second reply'), replyId: 'reply-two' })
                const nextReply = yield* until(
                  readOutput(worker, cfg, reply.cursor),
                  (result) => result.reply_id === 'reply-two',
                )
                expect(nextReply.text).toBe('second reply')
                expect(db.prepare('SELECT commit_token FROM worker_commit').get()?.commit_token).toBe(token)
              } finally {
                db.close()
              }
              yield* Deferred.succeed(gate, undefined)
              yield* completed(worker, first.command_id!)
              yield* Queue.offer(f.events, {
                ...delta(first.client_message_id!, ''),
                type: 'item',
                item: { id: 'step', type: 'dynamic_tool', status: 'completed', ordinal: 0, data: { output: 'done' } },
              })
              yield* until(reports(worker), (rows) => rows.some((row) => row.kind === 'turn.item'))
              expect((yield* readOutput(worker, cfg)).running_steps).toEqual([])
              f.output.offer({ ...delta(first.client_message_id!, ''), runningSteps: [runningStep] })
              f.output.offer(delta(first.client_message_id!, 'late snapshot processed'))
              const afterLateSnapshot = yield* until(
                readOutput(worker, cfg),
                (result) => result.text?.includes('late snapshot processed') === true,
              )
              expect(afterLateSnapshot.running_steps).toEqual([])
              const old = yield* readOutput(worker, cfg)
              yield* Queue.offer(f.events, event(first.client_message_id!, 'reply'))
              yield* Queue.offer(f.events, event(first.client_message_id!, 'end'))
              yield* Effect.promise(() =>
                vi.waitFor(async () => {
                  expect((await Effect.runPromise(readOutput(worker, cfg, old.cursor))).state).toBe('idle')
                }),
              )
              expect(yield* readOutput(worker, cfg, old.cursor)).toMatchObject({
                text: '',
                gap: true,
                running_steps: [],
              })
              const second = message(cfg)
              yield* worker.handle(second)
              yield* completed(worker, second.command_id!)
              f.output.offer(delta(first.client_message_id!, 'old turn'))
              f.output.offer({ ...delta(second.client_message_id!, 'wrong execution'), executionId: 'foreign' })
              yield* Effect.yieldNow
              expect((yield* readOutput(worker, cfg)).text).toBe('')
              f.output.offer(delta(second.client_message_id!, 'second'))
              expect((yield* until(readOutput(worker, cfg), (result) => result.text === 'second')).text).toBe('second')
              expect((yield* readOutput(worker, cfg, 'bad')).code).toBe('invalid_cursor')
              expect((yield* readOutput(worker, { ...cfg, thread_id: randomUUID() })).code).toBe('invalid_request')
              expect((yield* reports(worker)).filter((item) => item.kind === 'reply')).toHaveLength(1)
            }),
          )
        }),
      ),
    )

    it.effect('keeps stop responsive during output floods and excludes a retired Agent instance', () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const cfg = config()
              const firstAgent = yield* fake
              const secondAgent = yield* fake
              let instances = 0
              const worker = yield* makeWorker({
                dbPath,
                agentFactory: () => (instances++ === 0 ? firstAgent.agent : secondAgent.agent),
                stopTimeoutMs: 100,
              })
              yield* worker.handle(request(cfg, 'thread_open'))
              yield* opened(worker)
              const first = message(cfg)
              yield* worker.handle(first)
              yield* completed(worker, first.command_id!)
              const flooding = yield* Deferred.make<void>()
              const flood = yield* Effect.forkScoped(
                Effect.forever(
                  Effect.gen(function* () {
                    for (let index = 0; index < 100; index++)
                      firstAgent.output.offer(delta(first.client_message_id!, 'output'.repeat(100)))
                    yield* Deferred.succeed(flooding, undefined)
                    yield* Effect.yieldNow
                  }),
                ),
              )
              yield* Deferred.await(flooding)
              const stop = request(cfg, 'thread_stop')
              yield* worker.handle(stop).pipe(Effect.timeout(1000))
              yield* Queue.offer(firstAgent.events, event(first.client_message_id!, 'end'))
              yield* completed(worker, stop.command_id!).pipe(Effect.timeout(1000))
              yield* Fiber.interrupt(flood)
              expect(firstAgent.calls).toContain('abort')
              expect(yield* readOutput(worker, cfg)).toMatchObject({ state: 'stopped', text: '' })
              const second = message(cfg)
              yield* worker.handle(second)
              yield* completed(worker, second.command_id!)
              firstAgent.output.offer(delta(second.client_message_id!, 'retired instance'))
              yield* Effect.yieldNow
              expect((yield* readOutput(worker, cfg)).text).toBe('')
              secondAgent.output.offer(delta(second.client_message_id!, 'fresh instance'))
              yield* until(readOutput(worker, cfg), (result) => result.text === 'fresh instance')
              expect((yield* reports(worker)).some((item) => item.kind === 'reply')).toBe(false)
            }),
          )
        }),
      ),
    )
  })

  describe('receipts and message identity', () => {
    it.effect('persists receipts and returns the same receipt after reopening', () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const cfg = config()
          const opening = request(cfg, 'thread_open')
          const receipt = yield* Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fake
              const worker = yield* makeWorker({ dbPath, agentFactory: () => f.agent })
              const response = yield* worker.handle(opening)
              expect(response.ok).toBe(true)
              expect((yield* worker.handle(opening)).receipt).toEqual(response.receipt)
              yield* opened(worker)
              return response.receipt
            }),
          )
          yield* Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fake
              const worker = yield* makeWorker({ dbPath, agentFactory: () => f.agent })
              expect((yield* worker.handle(opening)).receipt).toEqual(receipt)
              expect(f.calls).not.toContain('open')
            }),
          )
          const db = new DatabaseSync(dbPath, { readOnly: true })
          try {
            expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal')
            expect(db.prepare('SELECT commit_token FROM worker_commit').get()?.commit_token).toEqual(expect.any(String))
            expect(db.prepare('SELECT count(*) AS count FROM thread_commands').get()?.count).toBe(1)
          } finally {
            db.close()
          }
        }),
      ),
    )

    it.effect('rejects changed content for an existing command or message ID', () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { cfg, worker } = yield* readyWorker(dbPath)
          const input = message(cfg)
          yield* worker.handle(input)
          expect((yield* worker.handle({ ...input, payload: 'different' })).code).toBe('command_conflict')
          expect((yield* worker.handle({ ...input, command_id: randomUUID(), payload: 'different' })).code).toBe(
            'message_conflict',
          )
          yield* completed(worker, input.command_id!)
        }),
      ),
    )

    it.effect('deduplicates message IDs across commands and completes both receipts', () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { cfg, f, worker } = yield* readyWorker(dbPath)
          const input = { ...message(cfg), client_message_id: '__proto__' }
          const alias = { ...input, command_id: randomUUID() }
          yield* worker.handle(input)
          yield* worker.handle(alias)
          const items = yield* completed(worker, alias.command_id!)
          expect(findCompletion(items, input.command_id!)?.command_outcome).toBe('succeeded')
          expect(findCompletion(items, alias.command_id!)?.command_outcome).toBe('succeeded')
          expect(f.sentInputs.map((sent) => sent.id)).toEqual([input.client_message_id])
        }),
      ),
    )
  })

  describe('turn ordering and outbox delivery', () => {
    it.effect('runs sequential turns and records send before command completion', () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { cfg, f, worker } = yield* readyWorker(dbPath)
          const first = message(cfg)
          const second = message(cfg, 'second')
          yield* worker.handle(first)
          yield* worker.handle(second)
          yield* completed(worker, first.command_id!)
          expect(f.sentInputs.map((input) => input.id)).toEqual([first.client_message_id])
          yield* Queue.offer(f.events, event(first.client_message_id!, 'end'))
          const items = yield* completed(worker, second.command_id!)
          expect(f.sentInputs.map((input) => input.id)).toEqual([first.client_message_id, second.client_message_id])
          expect(f.calls.filter((call) => call === 'open')).toHaveLength(1)
          const sent = items.findIndex(
            (item) => item.kind === 'message.sent' && item.client_message_id === first.client_message_id,
          )
          const completion = items.findIndex(
            (item) => item.kind === 'command.completed' && item.command_id === first.command_id,
          )
          expect(sent).toBeGreaterThanOrEqual(0)
          expect(sent).toBeLessThan(completion)
          expect(items.map((item) => item.worker_seq)).toEqual(items.map((_, index) => index + 1))
        }),
      ),
    )

    it.effect('deduplicates replies and rejects replies from a completed turn', () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { cfg, f, worker } = yield* readyWorker(dbPath)
          const input = message(cfg)
          yield* worker.handle(input)
          yield* completed(worker, input.command_id!)
          yield* Queue.offer(f.events, event(input.client_message_id!, 'reply'))
          yield* Queue.offer(f.events, event(input.client_message_id!, 'reply'))
          yield* Queue.offer(f.events, event(input.client_message_id!, 'end'))
          yield* until(reports(worker), (items) => items.some((item) => item.kind === 'turn.ended'))
          yield* Queue.offer(f.events, { ...event(input.client_message_id!, 'reply'), id: 'late-reply' } as AgentEvent)
          const next = message(cfg, 'next')
          yield* worker.handle(next)
          const items = yield* completed(worker, next.command_id!)
          expect(items.filter((item) => item.kind === 'reply')).toHaveLength(1)
        }),
      ),
    )

    it.effect(
      'retains exact reply evidence and stable IDs while deduplicating, ending turns and advancing the queue',
      () =>
        fixture((dbPath) =>
          Effect.gen(function* () {
            const rawId = 'reply:长🙂'.repeat(100)
            const rawText = 'before\0middle\uD800after\uDC00 😀 �'
            const display = 'before�middle�after� 😀 �'
            const firstId = randomUUID()
            const secondId = randomUUID()
            const mappedId = yield* Effect.scoped(
              Effect.gen(function* () {
                const { cfg, f, worker } = yield* readyWorker(dbPath)
                const firstCommand = randomUUID()
                yield* worker.handle(
                  request(cfg, 'thread_message', {
                    command_id: firstCommand,
                    client_message_id: firstId,
                    payload: 'first',
                  }),
                )
                yield* completed(worker, firstCommand)
                const secondCommand = randomUUID()
                yield* worker.handle(
                  request(cfg, 'thread_message', {
                    command_id: secondCommand,
                    client_message_id: secondId,
                    payload: 'second',
                  }),
                )
                const reply: AgentEvent = {
                  type: 'reply',
                  nativeSessionId: 'native',
                  messageId: firstId,
                  executionId: `exec:${firstId}`,
                  id: rawId,
                  text: rawText,
                }
                f.output.offer(delta(firstId, rawText))
                expect((yield* until(readOutput(worker, cfg), (result) => result.text === display)).text).toBe(display)
                yield* Queue.offer(f.events, reply)
                const items = yield* until(reports(worker), (rows) => rows.some((row) => row.kind === 'reply'))
                const saved = items.find((row) => row.kind === 'reply')
                const mapped = saved?.metadata?.reply_id
                if (!saved || typeof mapped !== 'string') throw new Error('Expected a mapped reply')
                expect(mapped).toMatch(/^baton:reply:sha256:[0-9a-f]{64}$/)
                expect(saved.content).toBe(display)
                expect(Schema.is(ThreadReportSchema)(saved)).toBe(true)
                expect(saved.metadata).toMatchObject({
                  reply_id_mapped: true,
                  reply_text_sanitized: true,
                  reply_evidence: 'worker_ledger_json',
                })
                yield* worker.handle({
                  type: 'thread_ack',
                  ok: true,
                  event_id: saved.event_id,
                  worker_seq: saved.worker_seq,
                })
                yield* Queue.offer(f.events, reply)
                yield* Queue.offer(f.events, { ...reply, id: mapped, text: 'native ID matching the mapped ID' })
                yield* Queue.offer(f.events, event(firstId, 'end'))
                yield* completed(worker, secondCommand)
                yield* Queue.offer(f.events, reply)
                yield* Queue.offer(f.events, {
                  ...reply,
                  messageId: secondId,
                  executionId: `exec:${secondId}`,
                  text: 'second turn',
                })
                yield* Queue.offer(f.events, {
                  ...reply,
                  messageId: secondId,
                  executionId: `exec:${secondId}`,
                  id: rawId + ':other',
                  text: 'distinct reply',
                })
                yield* Queue.offer(f.events, event(secondId, 'end'))
                const result = yield* until(
                  reports(worker),
                  (rows) => rows.filter((row) => row.kind === 'turn.ended').length === 2,
                )
                expect(result.every((row) => Schema.is(ThreadReportSchema)(row))).toBe(true)
                expect(result.some((row) => row.kind === 'thread.unknown' || row.kind === 'message.withdrawn')).toBe(
                  false,
                )
                const replies = result.filter((row) => row.kind === 'reply')
                expect(replies).toHaveLength(3)
                expect(new Set(replies.map((row) => row.metadata?.reply_id)).size).toBe(3)
                expect(replies.find((row) => row.content === 'second turn')?.metadata?.reply_id).toBe(mapped)
                expect(
                  result.filter((row) => row.kind === 'turn.ended').map((row) => [row.client_message_id, row.reason]),
                ).toEqual([
                  [firstId, 'completed'],
                  [secondId, 'completed'],
                ])
                expect(f.sentInputs.map((input) => input.id)).toEqual([firstId, secondId])
                expect(f.calls).not.toContain('reap')
                return mapped
              }),
            )
            const persisted = (yield* openWorkerLedger({ dbPath })).initial
            const replies = persisted.outbox.filter((entry) => entry.report.kind === 'reply')
            expect(replies).toHaveLength(4)
            const first = replies.find(
              (entry) => entry.report.client_message_id === firstId && entry.report.metadata?.reply_id === mappedId,
            )
            expect(first?.acked).toBe(true)
            expect(first?.replyEvidence).toMatchObject({
              id: rawId,
              text: rawText,
              nativeSessionId: 'native',
              messageId: firstId,
              executionId: `exec:${firstId}`,
            })
            expect(first?.report.content).toBe(display)
            expect(persisted.messages[firstId]?.ended).toBe(true)
            expect(persisted.messages[secondId]?.ended).toBe(true)
            expect(persisted.phase).toBe('idle')
          }),
        ),
    )

    it.effect('keeps identity mismatches unknown even when reply display fields need repair', () =>
      Effect.forEach(['nativeSessionId', 'messageId', 'executionId'], (field) =>
        fixture((dbPath) =>
          Effect.gen(function* () {
            const { cfg, f, worker } = yield* readyWorker(dbPath)
            const inputId = randomUUID()
            const commandId = randomUUID()
            yield* worker.handle(
              request(cfg, 'thread_message', { command_id: commandId, client_message_id: inputId, payload: 'first' }),
            )
            yield* completed(worker, commandId)
            const queuedId = randomUUID()
            yield* worker.handle(request(cfg, 'thread_message', { client_message_id: queuedId, payload: 'queued' }))
            const reply: AgentEvent = {
              type: 'reply',
              nativeSessionId: 'native',
              messageId: inputId,
              executionId: `exec:${inputId}`,
              id: 'long-id'.repeat(100),
              text: 'bad\0\uD800',
              [field]: 'foreign',
            }
            yield* Queue.offer(f.events, reply)
            yield* Queue.offer(f.events, event(inputId, 'end'))
            const items = yield* until(reports(worker), (rows) => rows.some((row) => row.kind === 'thread.unknown'))
            expect(items.find((row) => row.kind === 'thread.unknown')?.reason).toMatch(/identity mismatch/)
            expect(items.some((row) => row.kind === 'reply')).toBe(false)
            expect(items.find((row) => row.kind === 'message.withdrawn')?.client_message_id).toBe(queuedId)
            expect(f.sentInputs.map((input) => input.id)).toEqual([inputId])
          }),
        ),
      ),
    )

    it.effect('requires matching event identity before removing acknowledged reports', () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { worker } = yield* readyWorker(dbPath)
          const items = yield* reports(worker)
          const ack = items[0]!
          expect(
            (yield* worker.handle({ type: 'thread_ack', ok: true, event_id: randomUUID(), worker_seq: ack.worker_seq }))
              .ok,
          ).toBe(false)
          expect((yield* reports(worker)).some((item) => item.event_id === ack.event_id)).toBe(true)
          yield* worker.handle({ type: 'thread_ack', ok: true, event_id: ack.event_id, worker_seq: ack.worker_seq })
          const remaining = yield* reports(worker)
          expect(remaining.some((item) => item.event_id === ack.event_id)).toBe(false)
          expect(remaining.map((item) => item.event_id)).toEqual(items.slice(1).map((item) => item.event_id))
        }),
      ),
    )
  })

  describe('stop during pending work', () => {
    it.effect('accepts stop during slow open and never publishes a cancelled opened result', () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const cfg = config()
              const f = yield* fake
              const gate = yield* Deferred.make<void>()
              f.openTask = Deferred.await(gate).pipe(Effect.uninterruptible)
              const worker = yield* makeWorker({ dbPath, agentFactory: () => f.agent, stopTimeoutMs: 100 })
              yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined))
              const opening = request(cfg, 'thread_open')
              yield* worker.handle(opening)
              yield* called(f, 'open')
              const stopping = request(cfg, 'thread_stop')
              expect((yield* worker.handle(stopping)).receipt?.action).toBe('stop')
              yield* Deferred.succeed(gate, undefined)
              const items = yield* completed(worker, stopping.command_id!)
              expect(items.some((item) => item.kind === 'thread.opened')).toBe(false)
              expect(findCompletion(items, opening.command_id!)?.command_outcome).toBe('cancelled')
              expect(findCompletion(items, stopping.command_id!)?.command_outcome).toBe('succeeded')
              expect((yield* worker.handle(request(cfg, 'thread_resume'))).ok).toBe(false)
            }),
          )
        }),
      ),
    )

    it.effect('withdraws before intent while prepare is blocked; a late preparation cannot send', () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const cfg = config()
              const f = yield* fake
              f.prepareTask = Effect.never
              const worker = yield* makeWorker({ dbPath, agentFactory: () => f.agent, stopTimeoutMs: 50 })
              yield* worker.handle(request(cfg, 'thread_open'))
              yield* opened(worker)
              const input = message(cfg)
              yield* worker.handle(input)
              yield* called(f, `prepare:${input.client_message_id}`)
              const stopping = request(cfg, 'thread_stop')
              yield* worker.handle(stopping)
              const items = yield* completed(worker, stopping.command_id!)
              expect(findCompletion(items, input.command_id!)?.command_outcome).toBe('cancelled')
              expect(items.some((item) => item.kind === 'message.withdrawn')).toBe(true)
              expect(f.sentInputs).toHaveLength(0)
            }),
          )
        }),
      ),
    )
  })

  it.effect('preserves unknown after Uncertain followed by Exited and does not start the next input', () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const cfg = config()
            const f = yield* fake
            const worker = yield* makeWorker({ dbPath, agentFactory: () => f.agent })
            yield* worker.handle(request(cfg, 'thread_open'))
            yield* opened(worker)
            const first = message(cfg)
            yield* worker.handle(first)
            yield* completed(worker, first.command_id!)
            const next = message(cfg, 'later')
            yield* worker.handle(next)
            yield* Queue.offer(f.events, { type: 'uncertain', reason: 'event sequence gap' })
            yield* Queue.offer(f.events, { type: 'exited', reason: 'closed', processTreeStopped: true })
            const items = yield* until(reports(worker), (items) => items.some((item) => item.kind === 'thread.unknown'))
            expect(items.some((item) => item.kind === 'thread.stopped')).toBe(false)
            expect((yield* worker.handle({ type: 'status', ok: true })).agent_ready).toBe(false)
            expect(f.sentInputs).toHaveLength(1)
          }),
        )
      }),
    ),
  )

  it.effect(
    'persists and deduplicates items before reply/end and preserves token usage across early acceptance events',
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const cfg = config()
              const f = yield* fake
              f.duringSend = (input) =>
                Effect.gen(function* () {
                  const item: AgentEvent = {
                    ...delta(input.id, ''),
                    type: 'item',
                    item: {
                      id: 'native\\0',
                      type: 'command_execution',
                      status: 'completed',
                      ordinal: 0,
                      data: { output: 'first' },
                    },
                  }
                  yield* Queue.offer(f.events, item)
                  yield* Queue.offer(f.events, { ...item, item: { ...item.item, data: { output: 'duplicate' } } })
                  yield* Queue.offer(f.events, event(input.id, 'reply'))
                  yield* Queue.offer(f.events, {
                    ...delta(input.id, ''),
                    type: 'end',
                    outcome: 'completed',
                    tokenUsage: { usedTokens: 42, outputTokens: 12 },
                  })
                  yield* Effect.yieldNow
                })
              const worker = yield* makeWorker({ dbPath, agentFactory: () => f.agent })
              yield* worker.handle(request(cfg, 'thread_open'))
              yield* opened(worker)
              const input = message(cfg)
              yield* worker.handle(input)
              const items = yield* until(reports(worker), (items) => items.some((item) => item.kind === 'turn.ended'))
              expect(
                items
                  .filter((item) => ['turn.started', 'turn.item', 'reply', 'turn.ended'].includes(item.kind))
                  .map((item) => item.kind),
              ).toEqual(['turn.started', 'turn.item', 'reply', 'turn.ended'])
              expect(items.find((item) => item.kind === 'turn.item')?.item?.data).toEqual({ output: 'first' })
              expect(items.find((item) => item.kind === 'turn.ended')?.token_usage).toEqual({
                usedTokens: 42,
                outputTokens: 12,
              })
              expect(items.some((item) => item.kind === 'thread.unknown')).toBe(false)
            }),
          )
        }),
      ),
  )

  describe('recovery after reopening', () => {
    it.effect.each([false, true])(
      'reopens an intent with read-only evidence, never a second send (evidence: %s)',
      (known) =>
        fixture((dbPath) =>
          Effect.gen(function* () {
            const cfg = config()
            const input = message(cfg)
            let savedPreparation: InputPreparation | undefined
            yield* Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fake
                f.sendTask = Effect.never
                const worker = yield* makeWorker({ dbPath, agentFactory: () => f.agent })
                yield* worker.handle(request(cfg, 'thread_open'))
                yield* opened(worker)
                yield* worker.handle(input)
                yield* called(f, `send:${input.client_message_id}`)
              }),
            )
            const db = new DatabaseSync(dbPath, { readOnly: true })
            try {
              const row = db.prepare('SELECT payload FROM thread_messages WHERE id = ?').get(input.client_message_id!)
              savedPreparation = (JSON.parse(String(row?.payload)) as { preparation: InputPreparation }).preparation
            } finally {
              db.close()
            }
            yield* Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fake
                if (known)
                  f.evidence.set(input.client_message_id!, {
                    nativeSessionId: 'native',
                    executionId: `exec:${input.client_message_id}`,
                  })
                const worker = yield* makeWorker({ dbPath, agentFactory: () => f.agent })
                const items = yield* completed(worker, input.command_id!)
                expect(findCompletion(items, input.command_id!)?.command_outcome).toBe(known ? 'succeeded' : 'unknown')
                expect(f.restored).toEqual([savedPreparation])
                expect(f.sentInputs).toHaveLength(0)
                expect(f.calls.includes('open')).toBe(false)
                expect(f.calls.includes('resume')).toBe(false)
              }),
            )
          }),
        ),
    )

    it.effect('restores a persistent queued input and its trace after Scope exit without changing retry identity', () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const cfg = config()
          const input = {
            ...message(cfg),
            trace_context: { traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01` },
          } as WorkerRequest
          const spans: Tracer.NativeSpan[] = []
          const tracer = Tracer.make({
            span(options) {
              const span = new Tracer.NativeSpan(options)
              spans.push(span)
              return span
            },
          })
          let durableSpan: string | undefined
          yield* Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fake
              f.prepareTask = Effect.never
              const worker = yield* makeWorker({ dbPath, agentFactory: () => f.agent })
              yield* worker.handle(request(cfg, 'thread_open'))
              yield* opened(worker)
              const receipt = yield* worker.handle(input)
              const retry = yield* worker.handle({
                ...input,
                trace_context: { traceparent: `00-${'c'.repeat(32)}-${'d'.repeat(16)}-01` },
              })
              expect(retry.receipt).toEqual(receipt.receipt)
              yield* called(f, `prepare:${input.client_message_id}`)
            }).pipe(Effect.provideService(Tracer.Tracer, tracer)),
          )
          const db = new DatabaseSync(dbPath, { readOnly: true })
          try {
            const row = db.prepare('SELECT payload FROM thread_messages WHERE id = ?').get(input.client_message_id!)
            const saved = JSON.parse(String(row?.payload)) as { trace_context: { traceparent: string } }
            expect(saved.trace_context.traceparent.split('-')[1]).toBe('a'.repeat(32))
            durableSpan = saved.trace_context.traceparent.split('-')[2]
          } finally {
            db.close()
          }
          yield* Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fake
              const worker = yield* makeWorker({ dbPath, agentFactory: () => f.agent })
              yield* completed(worker, input.command_id!)
              expect(f.calls.includes('resume')).toBe(true)
              expect(f.sentInputs.map((message) => message.id)).toEqual([input.client_message_id])
            }).pipe(Effect.provideService(Tracer.Tracer, tracer)),
          )
          const sent = spans.find((span) => span.name === 'baton.worker.send')
          expect(sent?.traceId).toBe('a'.repeat(32))
          const turn = spans.find((span) => span.name === 'baton.turn')
          expect(turn && Option.getOrUndefined(turn.parent)?.spanId).toBe(durableSpan)
          expect(sent && Option.getOrUndefined(sent.parent)?.spanId).toBe(turn?.spanId)
          const retried = spans.find((span) => span.name === 'baton.worker.receive' && span.traceId === 'c'.repeat(32))
          expect(retried?.links[0]?.span.spanId).toBe(durableSpan)
        }),
      ),
    )

    it.effect('keeps recovery I/O outside construction and the command queue', () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const cfg = config()
          yield* Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fake
              const worker = yield* makeWorker({ dbPath, agentFactory: () => f.agent })
              yield* worker.handle(request(cfg, 'thread_open'))
              yield* opened(worker)
            }),
          )
          yield* Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fake
              const gate = yield* Deferred.make<void>()
              f.reapTask = Deferred.await(gate)
              const worker = yield* makeWorker({ dbPath, agentFactory: () => f.agent })
              yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined))
              const status = yield* worker.handle({ type: 'status', ok: true }).pipe(Effect.timeout(100))
              expect(status.worker_ready).toBe(true)
              expect(status.agent_ready).toBe(false)
              yield* Deferred.succeed(gate, undefined)
            }),
          )
        }),
      ),
    )
  })

  it.effect('resumes with a fresh Agent after stop and accepts process exit while tree reaping is in progress', () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const cfg = config()
            const first = yield* fake
            const second = yield* fake
            first.reapTask = Effect.gen(function* () {
              yield* Queue.offer(first.events, {
                type: 'exited',
                reason: 'root exited during tree cleanup',
                processTreeStopped: false,
              })
              yield* Effect.yieldNow
            })
            let factories = 0
            const worker = yield* makeWorker({
              dbPath,
              agentFactory: () => (++factories === 1 ? first.agent : second.agent),
            })
            yield* worker.handle(request(cfg, 'thread_open'))
            yield* opened(worker)
            const stopping = request(cfg, 'thread_stop')
            yield* worker.handle(stopping)
            const items = yield* completed(worker, stopping.command_id!)
            expect(findCompletion(items, stopping.command_id!)?.command_outcome).toBe('succeeded')
            expect(items.some((item) => item.kind === 'thread.unknown')).toBe(false)
            const resuming = request(cfg, 'thread_resume')
            const receipt = yield* worker.handle(resuming)
            expect(receipt.command_status?.state).toBe('accepted')
            yield* completed(worker, resuming.command_id!)
            expect(first.calls.includes('resume')).toBe(false)
            expect(second.calls.includes('resume')).toBe(true)
            const input = message(cfg)
            yield* worker.handle(input)
            yield* completed(worker, input.command_id!)
            expect(second.sentInputs).toHaveLength(1)
            expect(first.sentInputs).toHaveLength(0)
          }),
        )
      }),
    ),
  )

  it.effect('accepts stop while send is pending and preserves intent as unknown without resubmission', () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const cfg = config()
            const f = yield* fake
            f.sendTask = Effect.never
            const aborted = yield* Deferred.make<void>()
            const agent: ThreadAgent = {
              ...f.agent,
              abort: () => f.agent.abort().pipe(Effect.andThen(Deferred.succeed(aborted, undefined)), Effect.asVoid),
            }
            const worker = yield* makeWorker({ dbPath, agentFactory: () => agent, stopTimeoutMs: 200 })
            yield* worker.handle(request(cfg, 'thread_open'))
            yield* opened(worker)
            const input = message(cfg)
            yield* worker.handle(input)
            yield* called(f, `send:${input.client_message_id}`)
            const stopping = request(cfg, 'thread_stop')
            expect((yield* worker.handle(stopping)).ok).toBe(true)
            yield* Deferred.await(aborted)
            yield* Queue.offer(f.events, {
              type: 'exited',
              reason: 'Process tree termination confirmed',
              processTreeStopped: true,
            })
            const items = yield* completed(worker, stopping.command_id!)
            expect(findCompletion(items, input.command_id!)?.command_outcome).toBe('unknown')
            expect(findCompletion(items, stopping.command_id!)?.command_outcome).toBe('unknown')
            expect(items.some((item) => item.kind === 'message.withdrawn')).toBe(false)
            expect(f.sentInputs).toHaveLength(1)
            expect(f.calls.includes(`sent:${input.client_message_id}`)).toBe(true)
          }),
        )
      }),
    ),
  )

  it.effect('keeps process records in Worker transactions and blocks Agent startup until recovery completes', () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const cfg = config()
        const record = { pid: 43210, creationTime: 'old-created-at', role: 'cursor-host' }
        yield* Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fake
            const worker = yield* makeWorker({ dbPath, agentFactory: () => f.agent })
            yield* worker.handle(request(cfg, 'thread_open'))
            yield* opened(worker)
            yield* worker.records.add(record)
            yield* worker.records.add(record)
            yield* worker.records.remove({ ...record, creationTime: 'reused-pid' })
            expect(yield* worker.records.list()).toEqual([record])
          }),
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fake
            const gate = yield* Deferred.make<void>()
            const started = yield* Deferred.make<void>()
            const worker: Worker = yield* makeWorker({
              dbPath,
              agentFactory: () => f.agent,
              recoverProcesses: (records) =>
                Effect.gen(function* () {
                  expect(records).toEqual([record])
                  yield* Deferred.succeed(started, undefined)
                  yield* Deferred.await(gate)
                  yield* worker.records
                    .remove(record)
                    .pipe(Effect.mapError((cause) => new AgentError('Cannot remove recovered process', cause)))
                  return { processTreeStopped: true }
                }),
            })
            yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined))
            yield* Deferred.await(started)
            yield* worker.handle(request(cfg, 'thread_resume'))
            expect(f.calls.includes('resume')).toBe(false)
            expect((yield* worker.handle({ type: 'status', ok: true })).worker_ready).toBe(true)
            yield* Deferred.succeed(gate, undefined)
            yield* opened(worker)
            expect(yield* worker.records.list()).toEqual([])
            expect(f.calls.includes('resume')).toBe(true)
          }),
        )
      }),
    ),
  )

  it.effect('takes over durable process recovery when stop interrupts startup reconciliation', () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const cfg = config()
        const record = { pid: 54321, creationTime: 'previous-worker', role: 'cursor-host' }
        yield* Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fake
            const worker = yield* makeWorker({ dbPath, agentFactory: () => f.agent })
            yield* worker.handle(request(cfg, 'thread_open'))
            yield* opened(worker)
            yield* worker.records.add(record)
          }),
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fake
            const gate = yield* Deferred.make<void>()
            const recoveryAttempts = yield* Queue.unbounded<void>()
            let attempts = 0
            const worker: Worker = yield* makeWorker({
              dbPath,
              agentFactory: () => f.agent,
              stopTimeoutMs: 1000,
              recoverProcesses: (records) =>
                Effect.gen(function* () {
                  attempts++
                  yield* Queue.offer(recoveryAttempts, undefined)
                  expect(records).toEqual([record])
                  yield* Deferred.await(gate)
                  yield* worker.records
                    .remove(record)
                    .pipe(Effect.mapError((cause) => new AgentError('Process record removal failed', cause)))
                  return { processTreeStopped: true }
                }),
            })
            yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined))
            yield* Queue.take(recoveryAttempts)
            const stopping = request(cfg, 'thread_stop')
            yield* worker.handle(stopping)
            const query = {
              type: 'thread_command_status' as const,
              ok: true,
              command_id: stopping.command_id!,
              thread_id: cfg.thread_id,
              storage_generation: cfg.storage_generation,
            }
            yield* Queue.take(recoveryAttempts)
            const status = yield* worker.handle(query)
            expect(status.command_status?.state).toBe('accepted')
            expect(attempts).toBe(2)
            expect(yield* worker.records.list()).toEqual([record])
            expect((yield* reports(worker)).some((item) => item.kind === 'thread.stopped')).toBe(false)
            yield* Deferred.succeed(gate, undefined)
            const items = yield* completed(worker, stopping.command_id!)
            expect(findCompletion(items, stopping.command_id!)?.command_outcome).toBe('succeeded')
            expect(yield* worker.records.list()).toEqual([])
          }),
        )
      }),
    ),
  )

  it.effect.each(['open', 'resume'] as const)(
    'cleans and retires an Agent after %s fails with a live connection',
    (action) =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const cfg = config()
          if (action === 'resume')
            yield* Effect.scoped(
              Effect.gen(function* () {
                const f = yield* fake
                const worker = yield* makeWorker({ dbPath, agentFactory: () => f.agent })
                yield* worker.handle(request(cfg, 'thread_open'))
                yield* opened(worker)
              }),
            )
          yield* Effect.scoped(
            Effect.gen(function* () {
              const recovery = yield* fake
              const failed = yield* fake
              const fresh = yield* fake
              const gate = yield* Deferred.make<void>()
              failed.reapTask = Deferred.await(gate).pipe(
                Effect.timeout(1000),
                Effect.mapError((cause) => new AgentError('Cleanup gate timed out', cause)),
              )
              const failure = () =>
                Effect.suspend(() => {
                  failed.calls.push(action)
                  return Effect.fail(new AgentError('Native start failed after connection creation'))
                })
              const failedAgent: ThreadAgent = { ...failed.agent, [action]: failure }
              const instances =
                action === 'resume' ? [recovery.agent, failedAgent, fresh.agent] : [failedAgent, fresh.agent]
              let factories = 0
              const worker = yield* makeWorker({
                dbPath,
                agentFactory: () => instances[factories++]!,
                stopTimeoutMs: 500,
              })
              yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined))
              const command = request(cfg, action === 'open' ? 'thread_open' : 'thread_resume')
              yield* worker.handle(command)
              const query = {
                type: 'thread_command_status' as const,
                ok: true,
                command_id: command.command_id!,
                thread_id: cfg.thread_id,
                storage_generation: cfg.storage_generation,
              }
              yield* called(failed, 'reap')
              const status = yield* worker.handle(query)
              expect(failed.calls.includes('close')).toBe(true)
              expect(failed.calls.includes('reap')).toBe(true)
              expect(status.command_status?.state).toBe('running')
              expect((yield* worker.handle({ type: 'status', ok: true })).agent_ready).toBe(false)
              yield* Deferred.succeed(gate, undefined)
              const items = yield* completed(worker, command.command_id!)
              expect(findCompletion(items, command.command_id!)?.command_outcome).toBe('failed')
              if (action === 'resume') {
                const retry = request(cfg, 'thread_resume')
                yield* worker.handle(retry)
                yield* completed(worker, retry.command_id!)
                expect(fresh.calls.includes('resume')).toBe(true)
                expect(failed.calls.filter((call) => call === 'resume')).toHaveLength(1)
              } else {
                expect((yield* worker.handle(request(cfg, 'thread_resume'))).ok).toBe(false)
                expect(failed.calls.filter((call) => call === 'open')).toHaveLength(1)
              }
            }),
          )
        }),
      ),
  )

  it.effect('pages large outbox replies by encoded bytes and preserves UTF-8 truncation metadata', () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const cfg = config()
            const f = yield* fake
            const worker = yield* makeWorker({ dbPath, agentFactory: () => f.agent })
            yield* worker.handle(request(cfg, 'thread_open'))
            yield* opened(worker)
            const input = message(cfg)
            yield* worker.handle(input)
            yield* completed(worker, input.command_id!)
            const text = `BEGIN🙂\n"\\${'🙂\n"\\\x01\x02\x03'.repeat(80_000)}TAIL🙂終わり`
            for (let index = 0; index < 4; index++) {
              yield* Queue.offer(f.events, {
                type: 'reply',
                nativeSessionId: 'native',
                messageId: input.client_message_id!,
                executionId: `exec:${input.client_message_id}`,
                id: `large:${index}`,
                text,
              })
            }
            yield* Queue.offer(f.events, event(input.client_message_id!, 'end'))
            let cursor = 0
            const delivered: ThreadReport[] = []
            for (let page = 0; page < 8; page++) {
              const response = yield* until(
                worker.handle({ type: 'thread_pending', ok: true, after_worker_seq: cursor }),
                (result) => (result.thread_reports?.length ?? 0) > 0,
              )
              expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(240 * 1024)
              expect(Schema.is(WorkerIPCMessageSchema)(response)).toBe(true)
              const items = response.thread_reports ?? []
              delivered.push(...items)
              cursor = items.at(-1)?.worker_seq ?? cursor
              if (delivered.some((item) => item.kind === 'turn.ended')) break
            }
            const replies = delivered.filter((item) => item.kind === 'reply')
            expect(replies).toHaveLength(4)
            for (const reply of replies) {
              expect(reply.truncated).toBe(true)
              expect(reply.original_bytes).toBe(Buffer.byteLength(text))
              const content = reply.content!
              expect(content.startsWith(text.slice(0, 64))).toBe(true)
              expect(content.endsWith(text.slice(-64))).toBe(true)
              expect(content.includes('\uFFFD')).toBe(false)
              expect(Buffer.byteLength(content)).toBeLessThanOrEqual(32 * 1024)
              expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThanOrEqual(120 * 1024)
            }
            expect(delivered.some((item) => item.kind === 'turn.ended')).toBe(true)
          }),
        )
      }),
    ),
  )

  it.effect('durably drains forced-stop items behind reply attachment extraction before retiring the Agent', () =>
    fixture((dbPath) =>
      Effect.scoped(
        Effect.gen(function* () {
          const clock = yield* TestClock.testClockWith(Effect.succeed)
          // 停止预算和 Effect 超时共用测试时钟，避免机器负载耗尽真实预算。
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => clock.monotonicTimeNanosUnsafe()),
            ),
            (spy) => Effect.sync(() => spy.mockRestore()),
          )
          const cfg = config()
          const f = yield* fake
          const extracting = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const barrierOffered = yield* Deferred.make<void>()
          const input = message(cfg)
          const agent: ThreadAgent = {
            ...f.agent,
            abort: () =>
              Effect.gen(function* () {
                yield* f.agent.abort()
                yield* Queue.offer(f.events, {
                  ...delta(input.client_message_id!, ''),
                  type: 'item',
                  item: {
                    id: 'unfinished',
                    type: 'command_execution',
                    status: 'running',
                    ordinal: 0,
                    data: { output: 'retained' },
                  },
                })
              }),
            flushEvents: () =>
              Effect.gen(function* () {
                const done = yield* Deferred.make<void>()
                yield* Queue.offer(f.events, {
                  type: 'barrier',
                  acknowledge: Deferred.succeed(done, undefined).pipe(Effect.asVoid),
                })
                yield* Deferred.succeed(barrierOffered, undefined)
                yield* Deferred.await(done)
              }),
          }
          const worker = yield* makeWorker({
            dbPath,
            agentFactory: () => agent,
            stopTimeoutMs: 10,
            attachments: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(extracting, undefined)
                yield* Deferred.await(release)
                return []
              }),
          })
          yield* worker.handle(request(cfg, 'thread_open'))
          yield* opened(worker)
          yield* worker.handle(input)
          yield* completed(worker, input.command_id!)
          yield* Queue.offer(f.events, event(input.client_message_id!, 'reply'))
          yield* Deferred.await(extracting)
          const stop = request(cfg, 'thread_stop')
          yield* worker.handle(stop)
          yield* called(f, 'abort')
          // 推进 9 ms 宽限期，为 flush 留 1 ms，且不触发附件提取的 1 秒超时。
          yield* TestClock.adjust(9)
          yield* Deferred.await(barrierOffered)
          expect((yield* reports(worker)).some((item) => item.kind === 'turn.ended')).toBe(false)
          expect(f.calls.includes('reap')).toBe(false)
          yield* Deferred.succeed(release, undefined)
          const items = yield* completed(worker, stop.command_id!)
          expect(
            items.filter((item) => ['reply', 'turn.item', 'turn.ended'].includes(item.kind)).map((item) => item.kind),
          ).toEqual(['reply', 'turn.item', 'turn.ended'])
          expect(findCompletion(items, stop.command_id!)?.command_outcome).toBe('succeeded')
          expect(items.find((item) => item.kind === 'turn.item')?.item?.data).toEqual({ output: 'retained' })
        }),
      ),
    ),
  )

  it.effect.each([false, true])(
    'drains unknown cleanup items before ending an accepted Turn (native end: %s)',
    (nativeEnd) =>
      fixture((dbPath) =>
        Effect.scoped(
          Effect.gen(function* () {
            const cfg = config()
            const f = yield* fake
            const aborted = yield* Deferred.make<void>()
            const flushing = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            const input = message(cfg)
            const agent: ThreadAgent = {
              ...f.agent,
              abort: () =>
                Effect.gen(function* () {
                  yield* f.agent.abort()
                  yield* Queue.offer(f.events, {
                    ...delta(input.client_message_id!, ''),
                    type: 'item',
                    item: {
                      id: 'pending-on-unknown',
                      type: 'command_execution',
                      status: 'running',
                      ordinal: 0,
                      data: { output: 'preserved during cleanup' },
                    },
                  })
                  if (nativeEnd)
                    yield* Queue.offer(f.events, {
                      ...delta(input.client_message_id!, ''),
                      type: 'end',
                      outcome: 'cancelled',
                      tokenUsage: { usedTokens: 27 },
                    })
                  yield* Deferred.succeed(aborted, undefined)
                }),
              flushEvents: () =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(flushing, undefined)
                  yield* Deferred.await(release)
                  const done = yield* Deferred.make<void>()
                  yield* Queue.offer(f.events, {
                    type: 'barrier',
                    acknowledge: Deferred.succeed(done, undefined).pipe(Effect.asVoid),
                  })
                  yield* Deferred.await(done)
                }),
            }
            const worker = yield* makeWorker({ dbPath, agentFactory: () => agent })
            yield* worker.handle(request(cfg, 'thread_open'))
            yield* opened(worker)
            yield* worker.handle(input)
            yield* completed(worker, input.command_id!)
            yield* Queue.offer(f.events, { type: 'uncertain', reason: 'provider transport became uncertain' })
            yield* Deferred.await(aborted)
            expect((yield* reports(worker)).some((row) => row.kind === 'turn.ended')).toBe(false)
            yield* Deferred.await(flushing)
            const draining = yield* until(reports(worker), (rows) => rows.some((row) => row.kind === 'turn.item'))
            expect(draining.some((row) => row.kind === 'turn.ended' || row.kind === 'thread.unknown')).toBe(false)
            expect(f.calls.includes('reap')).toBe(false)
            const db = new DatabaseSync(dbPath, { readOnly: true })
            try {
              const stored = JSON.parse(
                String(
                  db.prepare('SELECT payload FROM thread_messages WHERE id=?').get(input.client_message_id!)?.payload,
                ),
              )
              expect(stored.state).toBe('sent')
              expect(stored.ended).not.toBe(true)
              const meta = JSON.parse(String(db.prepare('SELECT payload FROM thread_meta WHERE id=1').get()?.payload))
              expect(meta.phase).toBe('unknown')
              expect(meta.unknownReason).toBe('provider transport became uncertain')
            } finally {
              db.close()
            }
            yield* Deferred.succeed(release, undefined)
            const result = yield* until(reports(worker), (rows) => rows.some((row) => row.kind === 'thread.unknown'))
            expect(
              result
                .filter((row) => ['turn.item', 'turn.ended', 'thread.unknown'].includes(row.kind))
                .map((row) => row.kind),
            ).toEqual(['turn.item', 'turn.ended', 'thread.unknown'])
            expect(result.find((row) => row.kind === 'turn.item')?.item?.data).toEqual({
              output: 'preserved during cleanup',
            })
            expect(result.find((row) => row.kind === 'turn.ended')).toMatchObject({
              reason: 'agent_exited',
              ...(nativeEnd ? { token_usage: { usedTokens: 27 } } : {}),
            })
            expect((yield* worker.handle({ type: 'status', ok: true })).agent_ready).toBe(false)
            expect(f.calls.includes('reap')).toBe(true)
          }),
        ),
      ),
  )

  it.effect('finishes a pending unknown Turn after restart without replaying input or returning to idle', () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const cfg = config()
        const input = message(cfg)
        const nativeEnd = {
          ...delta(input.client_message_id!, ''),
          type: 'end' as const,
          outcome: 'cancelled' as const,
          tokenUsage: { usedTokens: 31 },
        }
        yield* Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fake
            const drained = yield* Deferred.make<void>()
            const agent: ThreadAgent = {
              ...f.agent,
              abort: () =>
                Effect.gen(function* () {
                  yield* f.agent.abort()
                  yield* Queue.offer(f.events, {
                    ...delta(input.client_message_id!, ''),
                    type: 'item',
                    item: {
                      id: 'before-restart',
                      type: 'command_execution',
                      status: 'running',
                      ordinal: 0,
                      data: { output: 'durable' },
                    },
                  })
                  yield* Queue.offer(f.events, nativeEnd)
                }),
              flushEvents: () =>
                Effect.gen(function* () {
                  const done = yield* Deferred.make<void>()
                  yield* Queue.offer(f.events, {
                    type: 'barrier',
                    acknowledge: Deferred.succeed(done, undefined).pipe(Effect.asVoid),
                  })
                  yield* Deferred.await(done)
                  yield* Deferred.succeed(drained, undefined)
                  yield* Effect.never
                }),
            }
            const worker = yield* makeWorker({ dbPath, agentFactory: () => agent })
            yield* worker.handle(request(cfg, 'thread_open'))
            yield* opened(worker)
            yield* worker.handle(input)
            yield* completed(worker, input.command_id!)
            yield* Queue.offer(f.events, { type: 'uncertain', reason: 'unknown cleanup interrupted by restart' })
            yield* Deferred.await(drained)
            expect((yield* reports(worker)).some((row) => row.kind === 'turn.ended')).toBe(false)
          }),
        )
        const saved = yield* Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fake
            const worker = yield* makeWorker({ dbPath, agentFactory: () => f.agent })
            const rows = yield* until(reports(worker), (items) => items.some((row) => row.kind === 'thread.unknown'))
            expect(
              rows
                .filter((row) => ['turn.item', 'turn.ended', 'thread.unknown'].includes(row.kind))
                .map((row) => row.kind),
            ).toEqual(['turn.item', 'turn.ended', 'thread.unknown'])
            expect(rows.find((row) => row.kind === 'turn.ended')).toMatchObject({
              reason: 'agent_exited',
              token_usage: { usedTokens: 31 },
            })
            expect(rows.find((row) => row.kind === 'thread.unknown')?.reason).toBe(
              'unknown cleanup interrupted by restart',
            )
            expect(f.calls).toEqual(['reap'])
            const db = new DatabaseSync(dbPath, { readOnly: true })
            try {
              const meta = JSON.parse(String(db.prepare('SELECT payload FROM thread_meta WHERE id=1').get()?.payload))
              expect(meta.phase).toBe('unknown')
              expect(meta.unknownReason).toBeUndefined()
              expect(meta.activeMessage).toBeUndefined()
              expect(meta.processTreeStopped).toBe(true)
              const message = JSON.parse(
                String(
                  db.prepare('SELECT payload FROM thread_messages WHERE id=?').get(input.client_message_id!)?.payload,
                ),
              )
              expect(message.ended).toBe(true)
            } finally {
              db.close()
            }
            return rows
          }),
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fake
            const worker = yield* makeWorker({ dbPath, agentFactory: () => f.agent })
            yield* called(f, 'reap')
            expect(yield* reports(worker)).toEqual(saved)
            expect(f.sentInputs).toHaveLength(0)
          }),
        )
      }),
    ),
  )

  it.effect('persists an idempotent budget extension and times out from the original Turn start', () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const cfg = { ...config(), execution_timeout_seconds: 1 }
        const settings: WorkerRequest = {
          type: 'thread_settings',
          ok: false,
          command_id: randomUUID(),
          thread_id: cfg.thread_id,
          storage_generation: cfg.storage_generation,
          execution_timeout_seconds: 2,
        }
        let wall = Date.now()
        yield* Effect.acquireRelease(
          Effect.sync(() => vi.spyOn(Date, 'now').mockImplementation(() => wall)),
          (spy) => Effect.sync(() => spy.mockRestore()),
        )
        const receipt = yield* Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fake
            const worker = yield* makeWorker({ dbPath, agentFactory: () => f.agent, stopTimeoutMs: 10 })
            yield* worker.handle(request(cfg, 'thread_open'))
            yield* opened(worker)
            const input = message(cfg)
            yield* worker.handle(input)
            yield* completed(worker, input.command_id ?? '')
            wall += 500
            yield* TestClock.adjust(500)
            const first = yield* worker.handle(settings)
            expect(first.command_status?.state).toBe('succeeded')
            expect(yield* worker.handle(settings)).toEqual(first)
            expect((yield* worker.handle({ ...settings, execution_timeout_seconds: 3 })).code).toBe('command_conflict')
            wall += 600
            yield* TestClock.adjust(600)
            expect(f.calls.includes('abort')).toBe(false)
            expect((yield* worker.handle({ type: 'status', ok: true })).agent_ready).toBe(true)
            wall += 901
            yield* TestClock.adjust(901)
            yield* TestClock.adjust(10)
            const items = yield* until(reports(worker), (items) => items.some((item) => item.kind === 'turn.ended'))
            expect(items.find((item) => item.kind === 'turn.ended')?.reason).toBe('timeout')
            expect(f.calls.includes('abort')).toBe(true)
            return first
          }),
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            const f = yield* fake
            const worker = yield* makeWorker({
              dbPath,
              agentFactory: (restored) => {
                expect(restored.execution_timeout_seconds).toBe(2)
                return f.agent
              },
            })
            expect(yield* worker.handle(settings)).toEqual(receipt)
            const items = yield* reports(worker)
            expect(
              items.filter((item) => item.kind === 'command.completed' && item.command_id === settings.command_id),
            ).toHaveLength(1)
          }),
        )
      }),
    ),
  )

  it.effect('times out a Turn through stop and records timeout even when process-tree termination is unknown', () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const cfg = { ...config(), execution_timeout_seconds: 1 }
            const f = yield* fake
            let wall = Date.now()
            yield* Effect.acquireRelease(
              Effect.sync(() => vi.spyOn(Date, 'now').mockImplementation(() => wall)),
              (spy) => Effect.sync(() => spy.mockRestore()),
            )
            const agent: ThreadAgent = { ...f.agent, reap: () => Effect.succeed({ processTreeStopped: false }) }
            const worker = yield* makeWorker({ dbPath, agentFactory: () => agent, stopTimeoutMs: 10 })
            yield* worker.handle(request(cfg, 'thread_open'))
            yield* opened(worker)
            const input = message(cfg)
            yield* worker.handle(input)
            yield* completed(worker, input.command_id!)
            wall += 1001
            yield* TestClock.adjust(1000)
            yield* TestClock.adjust(10)
            const items = yield* until(reports(worker), (items) => items.some((item) => item.kind === 'thread.unknown'))
            expect(f.calls.includes('abort')).toBe(true)
            expect(items.filter((item) => item.kind === 'turn.ended').map((item) => item.reason)).toEqual(['timeout'])
            expect((yield* worker.handle({ type: 'status', ok: true })).agent_ready).toBe(false)
          }),
        )
      }),
    ),
  )

  it.effect('recovers on an explicit new message or resume after unknown without reviving an old intent or queue', () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const cfg = config()
            const old = yield* fake
            const reader = yield* fake
            const next = yield* fake
            const resumed = yield* fake
            old.sendTask = Effect.never
            const instances = [old, reader, next, resumed]
            let factories = 0
            const worker = yield* makeWorker({ dbPath, agentFactory: () => instances[factories++]!.agent })
            yield* worker.handle(request(cfg, 'thread_open'))
            yield* opened(worker)
            const uncertainInput = { ...message(cfg), model: 'uncertain-model' }
            const oldQueued = message(cfg, 'old queued')
            yield* worker.handle(uncertainInput)
            yield* worker.handle(oldQueued)
            yield* called(old, `send:${uncertainInput.client_message_id}`)
            yield* Queue.offer(old.events, { type: 'uncertain', reason: 'broken execution channel' })
            yield* Queue.offer(old.events, { type: 'exited', reason: 'root exited', processTreeStopped: true })
            const items = yield* completed(worker, uncertainInput.command_id!)
            expect(findCompletion(items, uncertainInput.command_id!)?.command_outcome).toBe('unknown')
            expect(findCompletion(items, oldQueued.command_id!)?.command_outcome).toBe('cancelled')
            expect(factories).toBe(2)
            expect(reader.calls.includes(`sent:${uncertainInput.client_message_id}`)).toBe(true)
            const explicitNew = { ...message(cfg, 'continue after review'), model: 'corrected-model' }
            expect((yield* worker.handle(explicitNew)).ok).toBe(true)
            yield* completed(worker, explicitNew.command_id!)
            expect(next.calls.includes('resume')).toBe(true)
            expect(next.sentInputs.map((input) => input.id)).toEqual([explicitNew.client_message_id])
            yield* Queue.offer(next.events, { type: 'uncertain', reason: 'another execution disconnected' })
            yield* Queue.offer(next.events, { type: 'exited', reason: 'root exited', processTreeStopped: true })
            yield* called(next, 'reap')
            const resume = request(cfg, 'thread_resume')
            yield* worker.handle(resume)
            yield* completed(worker, resume.command_id!)
            expect(resumed.calls.includes('resume')).toBe(true)
            expect(resumed.sentInputs).toHaveLength(0)
            const status = yield* worker.handle({
              type: 'thread_command_status',
              ok: true,
              command_id: uncertainInput.command_id!,
              thread_id: cfg.thread_id,
              storage_generation: cfg.storage_generation,
            })
            expect(status.command_status?.state).toBe('unknown')
            expect(old.sentInputs).toHaveLength(1)
            expect(old.sentInputs[0]?.model).toBe('uncertain-model')
            expect(next.sentInputs[0]?.model).toBe('corrected-model')
            expect(reader.sentInputs).toHaveLength(0)
          }),
        )
      }),
    ),
  )

  it.effect('freezes on CommitUnknown before send, retaining the real committed intent', () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const cfg = config()
            const f = yield* fake
            const worker = yield* makeWorker({ dbPath, agentFactory: () => f.agent })
            yield* worker.handle(request(cfg, 'thread_open'))
            yield* opened(worker)
            // oxlint-disable-next-line typescript/unbound-method -- Save the original for prepare.call(this, query) inside the injected failure.
            const prepare = DatabaseSync.prototype.prepare
            let breakCommit = false
            let uncertainCommit = false
            const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
              this: DatabaseSync,
              query,
            ) {
              if (uncertainCommit && query === 'SELECT commit_token FROM worker_commit WHERE id = 1')
                throw new Error('verification disk failure')
              const statement = prepare.call(this, query)
              if (query.startsWith('INSERT INTO thread_messages')) {
                const nativeRun = statement.run.bind(statement)
                vi.spyOn(statement, 'run').mockImplementationOnce((...args) => {
                  if (typeof args[1] === 'string' && args[1].includes('"state":"intent"')) breakCommit = true
                  return nativeRun(...args)
                })
              }
              if (query === 'COMMIT' && breakCommit) {
                const nativeRun = statement.run.bind(statement)
                vi.spyOn(statement, 'run').mockImplementationOnce((...args) => {
                  nativeRun(...args)
                  uncertainCommit = true
                  throw new Error('commit acknowledgement lost')
                })
              }
              return statement
            })
            yield* Effect.gen(function* () {
              const input = message(cfg)
              yield* worker.handle(input)
              const failure = yield* worker.failed.pipe(Effect.flip)
              expect(failure.code).toBe('commit_unknown')
              expect(yield* worker.handle({ type: 'status', ok: true }).pipe(Effect.flip)).toBe(failure)
              expect(f.sentInputs).toHaveLength(0)
              const reader = new DatabaseSync(dbPath, { readOnly: true })
              try {
                const row = reader.prepare('SELECT payload FROM thread_messages').get()
                expect(JSON.parse(String(row?.payload)).state).toBe('intent')
                const commands = reader.prepare('SELECT payload FROM thread_commands').all()
                expect(commands.map((row) => JSON.parse(String(row.payload)).status.state)).toContain('running')
              } finally {
                reader.close()
              }
            }).pipe(Effect.ensuring(Effect.sync(() => spy.mockRestore())))
          }),
        )
      }),
    ),
  )
})
