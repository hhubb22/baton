import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Queue, Stream } from 'effect'
import { describe, expect, it } from 'vitest'
import type { WorkerOpenConfig } from '@baton/protocol'
import type { AgentMessage } from '../../worker/agent.ts'
import { makeCursorAgentFactory } from './thread-agent.ts'
import { mappingFor, persistMapping } from './mapping.ts'
import { prepare } from './evidence.ts'
import type { HostEvent, NativeMessage } from './protocol.ts'
import type { CursorHostConnection } from './transport.ts'

const input: AgentMessage = { id: 'input', operationId: 'op', text: 'hello', epoch: 1, mode: 'queue' }
const withDirectory = async (test: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), 'baton-cursor-thread-'))
  try {
    await test(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
const configFor = (directory: string): WorkerOpenConfig => ({
  thread_id: '00000000-0000-4000-8000-000000000001',
  node_id: '00000000-0000-4000-8000-000000000002',
  storage_generation: 'generation',
  agent_type: 'cursor',
  working_directory: directory,
  execution_timeout_seconds: 60,
  adapter_config: { state_path: join(directory, 'native.json') },
})

function hosts(config: WorkerOpenConfig) {
  const events = Effect.runSync(Queue.unbounded<HostEvent>())
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
          Effect.promise(async () => {
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
}

describe('Cursor ThreadAgent', () => {
  it('restores locally and checks sent before resume using only a read host', () =>
    withDirectory(async (directory) => {
      const config = configFor(directory),
        fixture = hosts(config)
      const native = await mappingFor(config, 'native')
      await persistMapping(native)
      const baseline = prepare(input, native, [])
      const agent = makeCursorAgentFactory({ command: { file: 'unused' }, connect: fixture.connect })(config)
      expect(fixture.counters().connections).toBe(0)
      await Effect.runPromise(agent.restoreInput(input, baseline))
      expect(fixture.counters().connections).toBe(0)
      fixture.history.push({ id: 'user', role: 'user', text: input.text })
      expect(await Effect.runPromise(agent.sent(input, baseline))).toEqual({
        nativeSessionId: 'native',
        executionId: 'user',
      })
      expect(fixture.counters()).toMatchObject({ opens: 0, sends: 0, reads: 1, reaps: 1 })
      await Effect.runPromise(agent.abort())
      expect(await Effect.runPromise(agent.sent(input, baseline))).toBeDefined()
      expect(fixture.counters()).toMatchObject({ opens: 0, sends: 0, reads: 2 })
      await Effect.runPromise(agent.reap())
    }))
  it('prepares once, sends without a second baseline and rejects foreign events', () =>
    withDirectory(async (directory) => {
      const config = configFor(directory),
        fixture = hosts(config)
      const agent = makeCursorAgentFactory({ command: { file: 'unused' }, connect: fixture.connect })(config)
      await Effect.runPromise(agent.open(config))
      await expect(Effect.runPromise(agent.prepareInput({ ...input, model: 'different-model' }))).rejects.toThrow(
        /does not support changing/,
      )
      expect(fixture.counters()).toMatchObject({ reads: 0, sends: 0 })
      const baseline = await Effect.runPromise(agent.prepareInput(input))
      expect(await Effect.runPromise(agent.prepareInput(input))).toEqual(baseline)
      await Effect.runPromise(agent.send(input, baseline))
      expect(fixture.counters()).toMatchObject({ opens: 1, sends: 1, reads: 1 })
      const event = Effect.runPromise(Stream.runCollect(agent.events.pipe(Stream.take(1))))
      await Effect.runPromise(
        Queue.offer(fixture.events, {
          generation: fixture.generation(),
          sequence: 1,
          event: {
            type: 'end',
            nativeSessionId: 'another-session',
            messageId: input.id,
            executionId: 'run',
            outcome: 'completed',
          },
        }),
      )
      expect(await event).toEqual([{ type: 'uncertain', reason: 'Cursor event execution identity mismatch' }])
      await Effect.runPromise(agent.reap())
    }))
  it('rejects other agent types before creating any host', () =>
    withDirectory(async (directory) => {
      const config = { ...configFor(directory), agent_type: 'pi' as const },
        fixture = hosts(config)
      const agent = makeCursorAgentFactory({ command: { file: 'unused' }, connect: fixture.connect })(config)
      await expect(Effect.runPromise(agent.open(config))).rejects.toThrow(/mismatch/)
      expect(fixture.counters().connections).toBe(0)
      await Effect.runPromise(agent.reap())
    }))
})
