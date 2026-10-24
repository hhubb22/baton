import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Fiber, Queue, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import type { WorkerOpenConfig } from '@baton/protocol'
import type { AgentMessage, ThreadAgent } from '../../worker/agent.ts'
import { makeCursorAgentFactory } from './thread-agent.ts'
import { mappingFor, persistMapping } from './mapping.ts'
import { prepare } from './evidence.ts'
import type { HostEvent, NativeMessage } from './protocol.ts'
import type { CursorHostConnection } from './transport.ts'

const input: AgentMessage = { id: 'input', operationId: 'op', text: 'hello', epoch: 1, mode: 'queue' }
const directory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), 'baton-cursor-thread-'))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
)
const configFor = (directory: string): WorkerOpenConfig => ({
  thread_id: '00000000-0000-4000-8000-000000000001',
  node_id: '00000000-0000-4000-8000-000000000002',
  storage_generation: 'generation',
  agent_type: 'cursor',
  working_directory: directory,
  execution_timeout_seconds: 60,
  adapter_config: { state_path: join(directory, 'native.json') },
})

const hosts = Effect.fnUntraced(function* (config: WorkerOpenConfig) {
  const events = yield* Queue.unbounded<HostEvent>()
  let connections = 0,
    opens = 0,
    sends = 0,
    reads = 0,
    reaps = 0
  let generation = ''
  const history: NativeMessage[] = []
  const connect = (): Effect.Effect<CursorHostConnection> =>
    Effect.sync(() => {
      connections++
      return {
        probe: Effect.succeed({
          authenticated: 'unknown',
          models: [],
          sdkVersion: 'fixture',
          platform: 'fixture',
          integrity: true,
          sandboxHelper: true,
        }),
        open: (_config, processGeneration) =>
          Effect.promise(() => {
            opens++
            generation = processGeneration
            return mappingFor(config, 'native')
          }),
        send: () =>
          Effect.sync(() => {
            sends++
            return { nativeSessionId: 'native', executionId: 'run' }
          }),
        history: () =>
          Effect.sync(() => {
            reads++
            return history
          }),
        events: Stream.fromQueue(events),
        abort: Effect.void,
        close: Effect.void,
        disconnect: Effect.void,
        reap: Effect.sync(() => {
          reaps++
          return { processTreeStopped: true }
        }),
        exited: Effect.never,
      }
    })
  return {
    events,
    connect,
    history,
    counters: () => ({ connections, opens, sends, reads, reaps }),
    generation: () => generation,
  }
})

const setup = Effect.fnUntraced(function* (eventCapacity?: number) {
  const config = configFor(yield* directory)
  const fixture = yield* hosts(config)
  const agent = yield* Effect.acquireRelease(
    Effect.sync(() =>
      makeCursorAgentFactory({
        command: { file: 'unused' },
        connect: fixture.connect,
        ...(eventCapacity === undefined ? {} : { eventCapacity }),
      })(config),
    ),
    (agent) => agent.reap().pipe(Effect.orDie),
  )
  let sequence = 0
  const publish = (event: HostEvent['event']) =>
    Queue.offer(fixture.events, {
      generation: fixture.generation(),
      sequence: ++sequence,
      event,
    })
  return { config, fixture, agent, publish }
})
const start = Effect.fnUntraced(function* (agent: ThreadAgent, config: WorkerOpenConfig) {
  yield* agent.open(config)
  const baseline = yield* agent.prepareInput(input)
  yield* agent.send(input, baseline)
})

describe('Cursor ThreadAgent', () => {
  describe('local recovery and input preparation', () => {
    it.effect('restores locally and checks sent before resume using only a read host', () =>
      Effect.gen(function* () {
        const { config, fixture, agent } = yield* setup()
        const native = yield* Effect.promise(() => mappingFor(config, 'native'))
        yield* Effect.promise(() => persistMapping(native))
        const baseline = prepare(input, native, [])
        expect(fixture.counters().connections).toBe(0)
        yield* agent.restoreInput(input, baseline)
        expect(fixture.counters().connections).toBe(0)
        fixture.history.push({ id: 'user', role: 'user', text: input.text })
        expect(yield* agent.sent(input, baseline)).toEqual({ nativeSessionId: 'native', executionId: 'user' })
        expect(fixture.counters()).toMatchObject({ opens: 0, sends: 0, reads: 1, reaps: 1 })
        yield* agent.abort()
        expect(yield* agent.sent(input, baseline)).toBeDefined()
        expect(fixture.counters()).toMatchObject({ opens: 0, sends: 0, reads: 2 })
      }),
    )

    it.effect('prepares once and sends without a second baseline', () =>
      Effect.gen(function* () {
        const { config, fixture, agent } = yield* setup()
        yield* agent.open(config)
        const baseline = yield* agent.prepareInput(input)
        expect(yield* agent.prepareInput(input)).toEqual(baseline)
        yield* agent.send(input, baseline)
        expect(fixture.counters()).toMatchObject({ opens: 1, sends: 1, reads: 1 })
      }),
    )

    it.effect('rejects model changes before reading history or sending', () =>
      Effect.gen(function* () {
        const { config, fixture, agent } = yield* setup()
        yield* agent.open(config)
        const failure = yield* agent.prepareInput({ ...input, model: 'different-model' }).pipe(Effect.flip)
        expect(failure.message).toMatch(/does not support changing/)
        expect(fixture.counters()).toMatchObject({ reads: 0, sends: 0 })
      }),
    )

    it.effect('rejects other agent types before creating any host', () =>
      Effect.gen(function* () {
        const config = { ...configFor(yield* directory), agent_type: 'pi' as const }
        const fixture = yield* hosts(config)
        const agent = yield* Effect.acquireRelease(
          Effect.sync(() => makeCursorAgentFactory({ command: { file: 'unused' }, connect: fixture.connect })(config)),
          (agent) => agent.reap().pipe(Effect.orDie),
        )
        expect((yield* agent.open(config).pipe(Effect.flip)).message).toMatch(/mismatch/)
        expect(fixture.counters().connections).toBe(0)
      }),
    )
  })

  describe('event identity and output', () => {
    it.effect('rejects foreign execution events', () =>
      Effect.gen(function* () {
        const { config, agent, publish } = yield* setup()
        yield* start(agent, config)
        const event = yield* Stream.runCollect(agent.events.pipe(Stream.take(1))).pipe(Effect.forkScoped)
        yield* publish({
          type: 'end',
          nativeSessionId: 'another-session',
          messageId: input.id,
          executionId: 'run',
          outcome: 'completed',
        })
        expect(yield* Fiber.join(event)).toEqual([
          { type: 'uncertain', reason: 'Cursor event execution identity mismatch' },
        ])
      }),
    )

    it.effect('keeps lossy text separate from reliable control events and rejects old-turn text', () =>
      Effect.gen(function* () {
        const { config, agent, publish } = yield* setup(1)
        yield* start(agent, config)
        const identity = { nativeSessionId: 'native', messageId: input.id, executionId: 'run' }
        for (let index = 0; index < 2000; index++)
          yield* publish({ ...identity, type: 'delta', id: 'text', text: '😀'.repeat(128) })
        const controlFiber = yield* Stream.runCollect(agent.events.pipe(Stream.take(2))).pipe(Effect.forkScoped)
        yield* publish({ ...identity, type: 'reply', id: 'reply', text: 'durable answer' })
        yield* publish({ ...identity, type: 'end', outcome: 'completed' })
        const controls = yield* Fiber.join(controlFiber)
        expect(controls.map((event) => event.type)).toEqual(['reply', 'end'])
        const output = yield* Stream.runCollect(agent.output!.pipe(Stream.take(1)))
        expect(output[0]).toMatchObject({ ...identity, gap: true })
        expect(Buffer.byteLength(output[0]!.text)).toBe(16 * 1024)
        const next = { ...input, id: 'next', operationId: 'next-operation' }
        const preparation = yield* agent.prepareInput(next)
        yield* agent.send(next, preparation)
        yield* publish({ ...identity, type: 'delta', id: 'late', text: 'late previous turn' })
        yield* publish({ ...identity, messageId: next.id, type: 'delta', id: 'fresh', text: 'fresh text', gap: true })
        const fresh = yield* Stream.runCollect(
          agent.output!.pipe(
            Stream.filter((event) => event.messageId === next.id),
            Stream.take(1),
          ),
        )
        expect(fresh).toEqual([{ ...identity, messageId: next.id, text: 'fresh text', gap: true }])
      }),
    )
  })
})
