import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  WorkerIPCMessage as WorkerIPCMessageSchema,
  ThreadReport as ThreadReportSchema,
  type ThreadReport,
  type WorkerOpenConfig,
  type WorkerRequest,
} from '@baton/protocol'
import { Deferred, Effect, Fiber, Option, Queue, Schema, Stream, Tracer } from 'effect'
import { describe, expect, it, vi } from 'vite-plus/test'
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
  working_directory: '/tmp',
  execution_timeout_seconds: 60,
  adapter_config: {},
})
const request = (
  cfg: WorkerOpenConfig,
  type: 'thread_open' | 'thread_message' | 'thread_stop' | 'thread_resume',
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
const until = <A, E>(read: Effect.Effect<A, E>, predicate: (value: A) => boolean): Effect.Effect<A, E | AgentError> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 500; attempt++) {
      const value = yield* read
      if (predicate(value)) return value
      yield* Effect.sleep(2)
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
  const sentInputs: AgentMessage[] = []
  const restored: InputPreparation[] = []
  const evidence = new Map<string, InputAcceptance>()
  const result: Fake = {
    events,
    output,
    calls,
    sentInputs,
    restored,
    evidence,
    agent: {
      open: () =>
        Effect.gen(function* () {
          calls.push('open')
          if (result.openTask) yield* result.openTask
          return { nativeSessionId: 'native' }
        }),
      resume: () =>
        Effect.sync(() => {
          calls.push('resume')
          return { nativeSessionId: 'native' }
        }),
      prepareInput: (input) =>
        Effect.gen(function* () {
          calls.push(`prepare:${input.id}`)
          if (result.prepareTask) yield* result.prepareTask
          return { nativeSessionId: 'native', preparationId: `prep:${input.id}`, userCount: 0, prefixDigest: 'prefix' }
        }),
      restoreInput: (_, preparation) =>
        Effect.sync(() => {
          restored.push(preparation)
        }),
      send: (input) =>
        Effect.gen(function* () {
          calls.push(`send:${input.id}`)
          sentInputs.push(input)
          if (result.duringSend) yield* result.duringSend(input)
          if (result.sendTask) yield* result.sendTask
          const acceptance = { nativeSessionId: 'native', executionId: `exec:${input.id}` }
          evidence.set(input.id, acceptance)
          return acceptance
        }),
      sent: (input) =>
        Effect.sync(() => {
          calls.push(`sent:${input.id}`)
          return evidence.get(input.id)
        }),
      events: Stream.fromQueue(events),
      output: output.stream,
      abort: () =>
        Effect.sync(() => {
          calls.push('abort')
        }),
      close: () =>
        Effect.sync(() => {
          calls.push('close')
        }),
      reap: () =>
        Effect.gen(function* () {
          calls.push('reap')
          if (result.reapTask) yield* result.reapTask
          return { processTreeStopped: true }
        }),
      readHistory: () => Effect.succeed({ entries: [] }),
    },
  }
  return result
})
const fixture = async (body: (filename: string) => Promise<void>) => {
  const directory = mkdtempSync(join(tmpdir(), 'baton-worker-'))
  try {
    await body(join(directory, 'thread.db'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
const run = <A, E>(effect: Effect.Effect<A, E, import('effect/Scope').Scope>) =>
  Effect.runPromise(Effect.scoped(effect))
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

describe('reliable Worker', () => {
  it('persists attachment references while parsing outside the command queue', async () =>
    fixture(async (dbPath) => {
      const attachments = [
        { kind: 'file', node_id: randomUUID(), root_id: 'workspace', path: 'artifact.log', access_status: 'available' },
      ]
      await run(
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
        const saved = Schema.decodeUnknownSync(Schema.Struct({ report: ThreadReportSchema }))(JSON.parse(row.payload))
        expect(saved.report.attachments).toEqual(attachments)
      } finally {
        reader.close()
      }
    }))
  it('serves fresh output before acceptance without ledger writes and clears it between turns', () =>
    fixture(async (dbPath) => {
      await run(
        Effect.gen(function* () {
          const cfg = config()
          const f = yield* fake
          const gate = yield* Deferred.make<void>()
          f.sendTask = Deferred.await(gate)
          const worker = yield* makeWorker({ dbPath, agentFactory: () => f.agent })
          yield* worker.handle(request(cfg, 'thread_open'))
          yield* opened(worker)
          const first = message(cfg)
          yield* worker.handle(first)
          yield* until(
            Effect.sync(() => f.sentInputs.length),
            (count) => count === 1,
          )
          const initial = yield* readOutput(worker, cfg)
          const db = new DatabaseSync(dbPath, { readOnly: true })
          try {
            const token = db.prepare('SELECT commit_token FROM worker_commit').get()?.commit_token
            f.output.offer(delta(first.client_message_id!, 'live 😀'))
            const live = yield* until(readOutput(worker, cfg, initial.cursor), (result) => result.text === 'live 😀')
            expect(live.state).toBe('running')
            expect(live.gap).toBe(false)
            f.output.offer({ ...delta(first.client_message_id!, 'lost'), gap: true })
            const lost = yield* until(readOutput(worker, cfg, live.cursor), (result) => result.gap)
            expect(lost.text).toBe('lost')
            expect(db.prepare('SELECT commit_token FROM worker_commit').get()?.commit_token).toBe(token)
          } finally {
            db.close()
          }
          yield* Deferred.succeed(gate, undefined)
          yield* completed(worker, first.command_id!)
          const old = yield* readOutput(worker, cfg)
          yield* Queue.offer(f.events, event(first.client_message_id!, 'reply'))
          yield* Queue.offer(f.events, event(first.client_message_id!, 'end'))
          yield* until(readOutput(worker, cfg, old.cursor), (result) => result.state === 'idle')
          expect(yield* readOutput(worker, cfg, old.cursor)).toMatchObject({ text: '', gap: true })
          const second = message(cfg)
          yield* worker.handle(second)
          yield* completed(worker, second.command_id!)
          f.output.offer(delta(first.client_message_id!, 'old turn'))
          f.output.offer({ ...delta(second.client_message_id!, 'wrong execution'), executionId: 'foreign' })
          yield* Effect.sleep(5)
          expect((yield* readOutput(worker, cfg)).text).toBe('')
          f.output.offer(delta(second.client_message_id!, 'second'))
          expect((yield* until(readOutput(worker, cfg), (result) => result.text === 'second')).text).toBe('second')
          expect((yield* readOutput(worker, cfg, 'bad')).code).toBe('invalid_cursor')
          expect((yield* readOutput(worker, { ...cfg, thread_id: randomUUID() })).code).toBe('invalid_request')
          expect((yield* reports(worker)).filter((item) => item.kind === 'reply')).toHaveLength(1)
        }),
      )
    }))

  it('keeps stop responsive during output floods and excludes a retired Agent instance', () =>
    fixture(async (dbPath) => {
      await run(
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
          const flood = yield* Effect.forkScoped(
            Effect.forever(
              Effect.gen(function* () {
                for (let index = 0; index < 100; index++)
                  firstAgent.output.offer(delta(first.client_message_id!, 'output'.repeat(100)))
                yield* Effect.yieldNow
              }),
            ),
          )
          yield* Effect.sleep(5)
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
          yield* Effect.sleep(5)
          expect((yield* readOutput(worker, cfg)).text).toBe('')
          secondAgent.output.offer(delta(second.client_message_id!, 'fresh instance'))
          yield* until(readOutput(worker, cfg), (result) => result.text === 'fresh instance')
          expect((yield* reports(worker)).some((item) => item.kind === 'reply')).toBe(false)
        }),
      )
    }))

  it('persists receipts, rejects content conflicts, deduplicates message IDs, and runs sequential turns', () =>
    fixture(async (dbPath) => {
      await run(
        Effect.gen(function* () {
          const cfg = config()
          const f = yield* fake
          const worker = yield* makeWorker({ dbPath, agentFactory: () => f.agent })
          const opening = request(cfg, 'thread_open')
          const receipt = yield* worker.handle(opening)
          expect(receipt.ok).toBe(true)
          expect((yield* worker.handle(opening)).receipt).toEqual(receipt.receipt)
          yield* opened(worker)
          const first = { ...message(cfg), client_message_id: '__proto__' }
          const second = message(cfg, 'second')
          yield* worker.handle(first)
          const alias = { ...first, command_id: randomUUID() }
          yield* worker.handle(alias)
          expect((yield* worker.handle({ ...first, payload: 'different' })).code).toBe('command_conflict')
          expect((yield* worker.handle({ ...alias, command_id: randomUUID(), payload: 'different' })).code).toBe(
            'message_conflict',
          )
          yield* worker.handle(second)
          yield* completed(worker, first.command_id!)
          expect(f.sentInputs.map((input) => input.id)).toEqual([first.client_message_id])
          yield* Queue.offer(f.events, event(first.client_message_id!, 'reply'))
          yield* Queue.offer(f.events, event(first.client_message_id!, 'reply'))
          yield* Queue.offer(f.events, event(first.client_message_id!, 'end'))
          yield* completed(worker, second.command_id!)
          yield* Queue.offer(f.events, event(first.client_message_id!, 'reply'))
          const items = yield* reports(worker)
          expect(items.filter((item) => item.kind === 'reply')).toHaveLength(1)
          expect(findCompletion(items, alias.command_id!)?.command_outcome).toBe('succeeded')
          expect(f.sentInputs.map((input) => input.id)).toEqual([first.client_message_id, second.client_message_id])
          expect(f.calls.filter((call) => call === 'open')).toHaveLength(1)
          const completion = items.findIndex(
            (item) => item.kind === 'command.completed' && item.command_id === first.command_id,
          )
          expect(
            items.findIndex(
              (item) => item.kind === 'message.sent' && item.client_message_id === first.client_message_id,
            ),
          ).toBeLessThan(completion)
          expect(items.map((item) => item.worker_seq)).toEqual(items.map((_, index) => index + 1))
          const ack = items[0]!
          expect(
            (yield* worker.handle({ type: 'thread_ack', ok: true, event_id: randomUUID(), worker_seq: ack.worker_seq }))
              .ok,
          ).toBe(false)
          yield* worker.handle({ type: 'thread_ack', ok: true, event_id: ack.event_id, worker_seq: ack.worker_seq })
          expect((yield* reports(worker)).some((item) => item.event_id === ack.event_id)).toBe(false)
        }),
      )
      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal')
        expect(db.prepare('SELECT commit_token FROM worker_commit').get()?.commit_token).toEqual(expect.any(String))
        expect(db.prepare('SELECT count(*) AS count FROM thread_commands').get()?.count).toBe(4)
      } finally {
        db.close()
      }
    }))

  it('accepts stop during slow open and never publishes a cancelled opened result', () =>
    fixture(async (dbPath) => {
      await run(
        Effect.gen(function* () {
          const cfg = config()
          const f = yield* fake
          const gate = yield* Deferred.make<void>()
          f.openTask = Deferred.await(gate).pipe(Effect.uninterruptible)
          const worker = yield* makeWorker({ dbPath, agentFactory: () => f.agent, stopTimeoutMs: 100 })
          const opening = request(cfg, 'thread_open')
          yield* worker.handle(opening)
          yield* until(
            Effect.sync(() => f.calls),
            (calls) => calls.includes('open'),
          )
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
    }))

  it('withdraws before intent while prepare is blocked; a late preparation cannot send', () =>
    fixture(async (dbPath) => {
      await run(
        Effect.gen(function* () {
          const cfg = config()
          const f = yield* fake
          f.prepareTask = Effect.never
          const worker = yield* makeWorker({ dbPath, agentFactory: () => f.agent, stopTimeoutMs: 50 })
          yield* worker.handle(request(cfg, 'thread_open'))
          yield* opened(worker)
          const input = message(cfg)
          yield* worker.handle(input)
          yield* until(
            Effect.sync(() => f.calls),
            (calls) => calls.includes(`prepare:${input.client_message_id}`),
          )
          const stopping = request(cfg, 'thread_stop')
          yield* worker.handle(stopping)
          const items = yield* completed(worker, stopping.command_id!)
          expect(findCompletion(items, input.command_id!)?.command_outcome).toBe('cancelled')
          expect(items.some((item) => item.kind === 'message.withdrawn')).toBe(true)
          expect(f.sentInputs).toHaveLength(0)
        }),
      )
    }))

  it('preserves unknown after Uncertain followed by Exited and does not start the next input', () =>
    fixture(async (dbPath) => {
      await run(
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
    }))

  it('attributes reply/end arriving before the send acceptance without losing the turn', () =>
    fixture(async (dbPath) => {
      await run(
        Effect.gen(function* () {
          const cfg = config()
          const f = yield* fake
          f.duringSend = (input) =>
            Effect.gen(function* () {
              yield* Queue.offer(f.events, event(input.id, 'reply'))
              yield* Queue.offer(f.events, event(input.id, 'end'))
              yield* Effect.sleep(5)
            })
          const worker = yield* makeWorker({ dbPath, agentFactory: () => f.agent })
          yield* worker.handle(request(cfg, 'thread_open'))
          yield* opened(worker)
          const input = message(cfg)
          yield* worker.handle(input)
          const items = yield* until(reports(worker), (items) => items.some((item) => item.kind === 'turn.ended'))
          expect(
            items
              .filter((item) => ['turn.started', 'reply', 'turn.ended'].includes(item.kind))
              .map((item) => item.kind),
          ).toEqual(['turn.started', 'reply', 'turn.ended'])
          expect(items.some((item) => item.kind === 'thread.unknown')).toBe(false)
        }),
      )
    }))

  it.each([false, true])('reopens an intent with read-only evidence, never a second send (evidence: %s)', (known) =>
    fixture(async (dbPath) => {
      const cfg = config()
      const input = message(cfg)
      let savedPreparation: InputPreparation | undefined
      await run(
        Effect.gen(function* () {
          const f = yield* fake
          f.sendTask = Effect.never
          const worker = yield* makeWorker({ dbPath, agentFactory: () => f.agent })
          yield* worker.handle(request(cfg, 'thread_open'))
          yield* opened(worker)
          yield* worker.handle(input)
          yield* until(
            Effect.sync(() => f.sentInputs.length),
            (count) => count === 1,
          )
        }),
      )
      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const row = db.prepare('SELECT payload FROM thread_messages WHERE id = ?').get(input.client_message_id!)
        savedPreparation = (JSON.parse(String(row?.payload)) as { preparation: InputPreparation }).preparation
      } finally {
        db.close()
      }
      await run(
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
  )

  it('restores a persistent queued input and its trace after Scope exit without changing retry identity', () =>
    fixture(async (dbPath) => {
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
      await run(
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
          yield* until(
            Effect.sync(() => f.calls),
            (calls) => calls.includes(`prepare:${input.client_message_id}`),
          )
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
      await run(
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
      expect(sent && Option.getOrUndefined(sent.parent)?.spanId).toBe(durableSpan)
      const retried = spans.find((span) => span.name === 'baton.worker.receive' && span.traceId === 'c'.repeat(32))
      expect(retried?.links[0]?.span.spanId).toBe(durableSpan)
    }))

  it('keeps recovery I/O outside construction and the command queue', () =>
    fixture(async (dbPath) => {
      const cfg = config()
      await run(
        Effect.gen(function* () {
          const f = yield* fake
          const worker = yield* makeWorker({ dbPath, agentFactory: () => f.agent })
          yield* worker.handle(request(cfg, 'thread_open'))
          yield* opened(worker)
        }),
      )
      await run(
        Effect.gen(function* () {
          const f = yield* fake
          const gate = yield* Deferred.make<void>()
          f.reapTask = Deferred.await(gate)
          const worker = yield* makeWorker({ dbPath, agentFactory: () => f.agent })
          const status = yield* worker.handle({ type: 'status', ok: true }).pipe(Effect.timeout(100))
          expect(status.worker_ready).toBe(true)
          expect(status.agent_ready).toBe(false)
          yield* Deferred.succeed(gate, undefined)
        }),
      )
    }))

  it('resumes with a fresh Agent after stop and accepts process exit while tree reaping is in progress', () =>
    fixture(async (dbPath) => {
      await run(
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
            yield* Effect.sleep(2)
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
    }))

  it('accepts stop while send is pending and preserves intent as unknown without resubmission', () =>
    fixture(async (dbPath) => {
      await run(
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
          yield* until(
            Effect.sync(() => f.sentInputs.length),
            (count) => count === 1,
          )
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
    }))

  it('keeps process records in Worker transactions and blocks Agent startup until recovery completes', () =>
    fixture(async (dbPath) => {
      const cfg = config()
      const record = { pid: 43210, creationTime: 'old-created-at', role: 'cursor-host' }
      await run(
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
      await run(
        Effect.gen(function* () {
          const f = yield* fake
          const gate = yield* Deferred.make<void>()
          let seen = false
          const worker: Worker = yield* makeWorker({
            dbPath,
            agentFactory: () => f.agent,
            recoverProcesses: (records) =>
              Effect.gen(function* () {
                expect(records).toEqual([record])
                seen = true
                yield* Deferred.await(gate)
                yield* worker.records
                  .remove(record)
                  .pipe(Effect.mapError((cause) => new AgentError('Cannot remove recovered process', cause)))
                return { processTreeStopped: true }
              }),
          })
          yield* until(
            Effect.sync(() => seen),
            Boolean,
          )
          yield* worker.handle(request(cfg, 'thread_resume'))
          expect(f.calls.includes('resume')).toBe(false)
          expect((yield* worker.handle({ type: 'status', ok: true })).worker_ready).toBe(true)
          yield* Deferred.succeed(gate, undefined)
          yield* opened(worker)
          expect(yield* worker.records.list()).toEqual([])
          expect(f.calls.includes('resume')).toBe(true)
        }),
      )
    }))

  it('takes over durable process recovery when stop interrupts startup reconciliation', () =>
    fixture(async (dbPath) => {
      const cfg = config()
      const record = { pid: 54321, creationTime: 'previous-worker', role: 'cursor-host' }
      await run(
        Effect.gen(function* () {
          const f = yield* fake
          const worker = yield* makeWorker({ dbPath, agentFactory: () => f.agent })
          yield* worker.handle(request(cfg, 'thread_open'))
          yield* opened(worker)
          yield* worker.records.add(record)
        }),
      )
      await run(
        Effect.gen(function* () {
          const f = yield* fake
          const gate = yield* Deferred.make<void>()
          let attempts = 0
          const worker: Worker = yield* makeWorker({
            dbPath,
            agentFactory: () => f.agent,
            stopTimeoutMs: 1000,
            recoverProcesses: (records) =>
              Effect.gen(function* () {
                attempts++
                expect(records).toEqual([record])
                yield* Deferred.await(gate)
                yield* worker.records
                  .remove(record)
                  .pipe(Effect.mapError((cause) => new AgentError('Process record removal failed', cause)))
                return { processTreeStopped: true }
              }),
          })
          yield* until(
            Effect.sync(() => attempts),
            (count) => count === 1,
          )
          const stopping = request(cfg, 'thread_stop')
          yield* worker.handle(stopping)
          const query = {
            type: 'thread_command_status' as const,
            ok: true,
            command_id: stopping.command_id!,
            thread_id: cfg.thread_id,
            storage_generation: cfg.storage_generation,
          }
          const status = yield* until(
            worker.handle(query),
            (result) =>
              attempts >= 2 ||
              result.command_status?.state === 'succeeded' ||
              result.command_status?.state === 'unknown',
          )
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
    }))

  it.each(['open', 'resume'] as const)('cleans and retires an Agent after %s fails with a live connection', (action) =>
    fixture(async (dbPath) => {
      const cfg = config()
      if (action === 'resume')
        await run(
          Effect.gen(function* () {
            const f = yield* fake
            const worker = yield* makeWorker({ dbPath, agentFactory: () => f.agent })
            yield* worker.handle(request(cfg, 'thread_open'))
            yield* opened(worker)
          }),
        )
      await run(
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
          const worker = yield* makeWorker({ dbPath, agentFactory: () => instances[factories++]!, stopTimeoutMs: 500 })
          const command = request(cfg, action === 'open' ? 'thread_open' : 'thread_resume')
          yield* worker.handle(command)
          const query = {
            type: 'thread_command_status' as const,
            ok: true,
            command_id: command.command_id!,
            thread_id: cfg.thread_id,
            storage_generation: cfg.storage_generation,
          }
          const status = yield* until(
            worker.handle(query),
            (result) => failed.calls.includes('reap') || result.command_status?.state === 'failed',
          )
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
  )

  it('pages large outbox replies by encoded bytes and preserves UTF-8 truncation metadata', () =>
    fixture(async (dbPath) => {
      await run(
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
            const response = yield* worker.handle({ type: 'thread_pending', ok: true, after_worker_seq: cursor })
            expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(240 * 1024)
            expect(Schema.is(WorkerIPCMessageSchema)(response)).toBe(true)
            const items = response.thread_reports ?? []
            delivered.push(...items)
            cursor = items.at(-1)?.worker_seq ?? cursor
            if (delivered.some((item) => item.kind === 'turn.ended')) break
            yield* Effect.sleep(2)
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
    }))

  it('times out a Turn through stop and records timeout even when process-tree termination is unknown', () =>
    fixture(async (dbPath) => {
      await run(
        Effect.gen(function* () {
          const cfg = { ...config(), execution_timeout_seconds: 1 }
          const f = yield* fake
          const agent: ThreadAgent = { ...f.agent, reap: () => Effect.succeed({ processTreeStopped: false }) }
          const worker = yield* makeWorker({ dbPath, agentFactory: () => agent, stopTimeoutMs: 10 })
          yield* worker.handle(request(cfg, 'thread_open'))
          yield* opened(worker)
          const input = message(cfg)
          yield* worker.handle(input)
          yield* completed(worker, input.command_id!)
          const items = yield* until(reports(worker), (items) => items.some((item) => item.kind === 'thread.unknown'))
          expect(f.calls.includes('abort')).toBe(true)
          expect(items.filter((item) => item.kind === 'turn.ended').map((item) => item.reason)).toEqual(['timeout'])
          expect((yield* worker.handle({ type: 'status', ok: true })).agent_ready).toBe(false)
        }),
      )
    }))

  it('recovers on an explicit new message or resume after unknown without reviving an old intent or queue', () =>
    fixture(async (dbPath) => {
      await run(
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
          const uncertainInput = message(cfg)
          const oldQueued = message(cfg, 'old queued')
          yield* worker.handle(uncertainInput)
          yield* worker.handle(oldQueued)
          yield* until(
            Effect.sync(() => old.sentInputs.length),
            (count) => count === 1,
          )
          yield* Queue.offer(old.events, { type: 'uncertain', reason: 'broken execution channel' })
          yield* Queue.offer(old.events, { type: 'exited', reason: 'root exited', processTreeStopped: true })
          const items = yield* completed(worker, uncertainInput.command_id!)
          expect(findCompletion(items, uncertainInput.command_id!)?.command_outcome).toBe('unknown')
          expect(findCompletion(items, oldQueued.command_id!)?.command_outcome).toBe('cancelled')
          expect(factories).toBe(2)
          expect(reader.calls.includes(`sent:${uncertainInput.client_message_id}`)).toBe(true)
          const explicitNew = message(cfg, 'continue after review')
          expect((yield* worker.handle(explicitNew)).ok).toBe(true)
          yield* completed(worker, explicitNew.command_id!)
          expect(next.calls.includes('resume')).toBe(true)
          expect(next.sentInputs.map((input) => input.id)).toEqual([explicitNew.client_message_id])
          yield* Queue.offer(next.events, { type: 'uncertain', reason: 'another execution disconnected' })
          yield* Queue.offer(next.events, { type: 'exited', reason: 'root exited', processTreeStopped: true })
          yield* until(
            Effect.sync(() => next.calls),
            (calls) => calls.includes('reap'),
          )
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
        }),
      )
    }))

  it('freezes on CommitUnknown before send, retaining the real committed intent', () =>
    fixture(async (dbPath) => {
      await run(
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
            yield* until(
              Effect.sync(() => uncertainCommit),
              Boolean,
            )
            const failure = yield* worker.handle({ type: 'status', ok: true }).pipe(Effect.flip)
            expect(failure.code).toBe('commit_unknown')
            expect(yield* worker.failed.pipe(Effect.flip, Effect.timeout(100))).toBe(failure)
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
    }))
})
