import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Deferred, Fiber, Queue, Stream } from 'effect'
import { describe, expect, it } from 'vite-plus/test'
import type { WorkerOpenConfig } from '@baton/protocol'
import { makeCursorHostHandlers, type CursorHostDependencies } from './host.ts'
import { prepare } from './evidence.ts'
import type { AgentMessage } from '../../worker/agent.ts'
import type { NativeMessage } from './protocol.ts'
import type { CursorAgentSdkSession, SendOptions, InteractionUpdate } from '@baton/providers/cursor'
import { mappingFor } from './mapping.ts'

const config = (directory: string): WorkerOpenConfig => ({
  thread_id: '00000000-0000-4000-8000-000000000001',
  node_id: '00000000-0000-4000-8000-000000000002',
  storage_generation: 'generation',
  agent_type: 'cursor',
  working_directory: directory,
  execution_timeout_seconds: 60,
  adapter_config: { state_path: join(directory, 'native.json') },
})
const input: AgentMessage = { id: 'input', text: 'hello', epoch: 1, operationId: 'operation', mode: 'queue' }

// The SDK runner has its own upstream transcript tests. These ports cover Baton differences.
const inHost = async (test: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), 'baton-cursor-host-'))
  try {
    await test(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('Cursor host lifecycle', () => {
  it('buffers SDK text within a byte bound while preserving reply/end and abort during floods', () =>
    inHost(async (directory) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const history: NativeMessage[] = []
            const terminal = yield* Deferred.make<{ id: string; status: 'cancelled' }>()
            let callback: ((update: InteractionUpdate) => Effect.Effect<void, unknown>) | undefined
            let cancellations = 0
            const session: CursorAgentSdkSession = {
              agentId: 'native',
              listMessages: Effect.succeed([]),
              close: Effect.void,
              send: (request) =>
                Effect.sync(() => {
                  callback = request.onDelta
                  history.push({ id: 'user', role: 'user', text: input.text })
                  return {
                    agentId: 'native',
                    runId: 'run',
                    cancel: Effect.sync(() => {
                      cancellations++
                    }),
                    wait: Deferred.await(terminal),
                  }
                }),
            }
            const unused = async (): Promise<never> => {
              throw new Error('Unexpected store mutation')
            }
            const handlers = yield* makeCursorHostHandlers({
              runner: {
                open: () => Effect.succeed(session),
                assertComplete: Effect.void,
                listMessages: () => Effect.succeed([]),
              },
              processGroup: { terminateChildren: Effect.void, waitQuiescent: () => Effect.void },
              openStore: () =>
                Effect.succeed({
                  agents: { get: unused, create: unused, update: unused, delete: unused, list: unused },
                  runs: { get: unused, create: unused, update: unused, delete: unused, list: unused },
                  checkpoints: { get: unused, create: unused, update: unused, delete: unused, list: unused },
                  runEvents: { append: unused, list: unused, delete: unused },
                  dispose: async () => {},
                }),
              history: () => Effect.succeed(history),
              probe: Effect.succeed({
                authenticated: 'unknown',
                models: [],
                sdkVersion: 'fixture',
                platform: 'fixture',
                integrity: true,
                sandboxHelper: true,
              }),
            })
            const native = yield* handlers.open({ config: config(directory), generation: 'flood' })
            yield* handlers.send({ message: input, preparation: prepare(input, native, []) })
            for (let index = 0; index < 700; index++) yield* callback!({ type: 'text-delta', text: 'x'.repeat(1024) })
            const frames = yield* handlers.events().pipe(Stream.take(1), Stream.runCollect)
            expect(frames[0]).toMatchObject({
              generation: 'flood',
              sequence: 1,
              event: { type: 'delta', gap: true, messageId: input.id, executionId: 'run' },
            })
            const delta = frames[0]!.event
            expect(delta.type === 'delta' && Buffer.byteLength(delta.text)).toBe(16 * 1024)
            yield* handlers.abort().pipe(Effect.timeout(1000))
            expect(cancellations).toBe(1)
            const controls = yield* Effect.forkScoped(
              handlers.events().pipe(
                Stream.filter((frame) => frame.event.type !== 'delta'),
                Stream.take(2),
                Stream.runCollect,
              ),
            )
            yield* Deferred.succeed(terminal, { id: 'run', status: 'cancelled' as const })
            const ended = yield* Fiber.join(controls).pipe(Effect.timeout(1000))
            expect(ended.map((frame) => frame.event.type)).toEqual(['reply', 'end'])
            expect(ended[0]!.event).toMatchObject({ type: 'reply', text: 'x'.repeat(700 * 1024) })
            // SDK callbacks can outlive the run; the host must ignore them after termination.
            yield* callback!({ type: 'text-delta', text: 'late output' })
          }),
        ),
      )
    }))

  it('rejects history when the mapped native agent is missing without opening an execution session', () =>
    inHost(async (directory) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const native = yield* Effect.promise(() => mappingFor(config(directory), 'missing-native'))
            let historyReads = 0
            const unused = async (): Promise<never> => {
              throw new Error('Native execution and mutations are forbidden in history lookup')
            }
            const store: Effect.Success<ReturnType<CursorHostDependencies['openStore']>> = {
              agents: { get: async () => null, create: unused, update: unused, delete: unused, list: unused },
              runs: { get: unused, create: unused, update: unused, delete: unused, list: unused },
              checkpoints: { get: unused, create: unused, update: unused, delete: unused, list: unused },
              runEvents: { append: unused, list: unused, delete: unused },
              dispose: async () => {},
            }
            const handlers = yield* makeCursorHostHandlers({
              processGroup: { terminateChildren: Effect.void, waitQuiescent: () => Effect.void },
              runner: {
                open: () => Effect.die('History must not create or resume an Agent'),
                assertComplete: Effect.void,
                listMessages: () => Effect.die('Missing native session must be detected before reading messages'),
              },
              openStore: () => Effect.succeed(store),
              history: () =>
                Effect.sync(() => {
                  historyReads++
                  return []
                }),
              probe: Effect.succeed({
                authenticated: 'unknown',
                models: [],
                sdkVersion: 'fixture',
                platform: 'fixture',
                integrity: true,
                sandboxHelper: true,
              }),
            })
            const result = yield* handlers.history(native).pipe(Effect.flip)
            expect(result.message).toMatch(/unavailable/)
            expect(historyReads).toBe(0)
          }),
        ),
      )
    }))
  it.each(['running', 'finished', 'cancelled'] as const)(
    'uses force once for a resumed %s run without changing read-only state',
    (status) =>
      inHost(async (directory) => {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const native = yield* Effect.promise(() => mappingFor(config(directory), 'native'))
              const agentDocument = Object.freeze({
                agentId: 'native',
                cwd: native.cwd,
                status: 'running' as const,
                activeRunId: 'stale-run',
                createdAt: 0,
                updatedAt: 0,
              })
              const runDocument = Object.freeze({
                agentId: 'native',
                runId: 'stale-run',
                turnNumber: 4,
                status,
                createdAt: 0,
                updatedAt: 0,
              })
              const history: NativeMessage[] = []
              const calls: Array<Omit<SendOptions, 'onDelta'> | undefined> = []
              const unused = async (): Promise<never> => {
                throw new Error('Read-only recovery must not mutate the store')
              }
              const store: Effect.Success<ReturnType<CursorHostDependencies['openStore']>> = {
                agents: {
                  get: async () => agentDocument,
                  create: unused,
                  update: unused,
                  delete: unused,
                  list: unused,
                },
                runs: { get: async () => runDocument, create: unused, update: unused, delete: unused, list: unused },
                checkpoints: { get: unused, create: unused, update: unused, delete: unused, list: unused },
                runEvents: { append: unused, list: unused, delete: unused },
                dispose: async () => {},
              }
              const session: CursorAgentSdkSession = {
                agentId: 'native',
                listMessages: Effect.succeed([]),
                close: Effect.void,
                send: (request) =>
                  Effect.sync(() => {
                    calls.push(request.options)
                    const runId = `new-run-${calls.length}`
                    history.push({
                      id: `user-${calls.length}`,
                      role: 'user',
                      text: typeof request.message === 'string' ? request.message : request.message.text,
                    })
                    return {
                      agentId: 'native',
                      runId,
                      cancel: Effect.void,
                      wait: Effect.succeed({ id: runId, status: 'finished' as const }),
                    }
                  }),
              }
              const handlers = yield* makeCursorHostHandlers({
                processGroup: { terminateChildren: Effect.void, waitQuiescent: () => Effect.void },
                runner: {
                  open: () => Effect.succeed(session),
                  assertComplete: Effect.void,
                  listMessages: () => Effect.succeed([]),
                },
                openStore: () => Effect.succeed(store),
                history: () => Effect.succeed(history),
                probe: Effect.succeed({
                  authenticated: 'unknown',
                  models: [],
                  sdkVersion: 'fixture',
                  platform: 'fixture',
                  integrity: true,
                  sandboxHelper: true,
                }),
              })
              yield* handlers.history(native)
              yield* handlers.open({ config: config(directory), generation: 'resumed', mapping: native })
              const baseline = prepare(input, native, yield* handlers.history(native))
              expect(calls).toHaveLength(0)
              expect(agentDocument.activeRunId).toBe('stale-run')
              expect(runDocument.status).toBe(status)
              yield* handlers.send({ message: input, preparation: baseline })
              expect(calls).toHaveLength(1)
              if (status === 'running') expect(calls[0]?.local?.force).toBe(true)
              else expect(calls[0]?.local).toBeUndefined()
              const next = { ...input, id: 'next', operationId: 'next-op', text: 'second new input' }
              yield* Effect.yieldNow
              yield* handlers.send({
                message: next,
                preparation: prepare(next, native, yield* handlers.history(native)),
              })
              expect(calls).toHaveLength(2)
              expect(calls[1]?.local).toBeUndefined()
            }),
          ),
        )
      }),
  )
  it('registers abort with ordinary RPC slots full and waits for real termination', () =>
    inHost(async (directory) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const handleReady = yield* Deferred.make<void>()
            const terminated = yield* Deferred.make<{ id: string; status: 'cancelled' }>()
            const observed = yield* Queue.unbounded<unknown>()
            const groupQuiet = yield* Deferred.make<void>()
            const groupWaitStarted = yield* Deferred.make<void>()
            let groupTerminationRequests = 0
            const historyReady = yield* Deferred.make<void>()
            const ordinaryRequestsFull = yield* Deferred.make<void>()
            let historyReads = 0
            const history: NativeMessage[] = []
            let sends = 0
            let cancels = 0
            const session: CursorAgentSdkSession = {
              agentId: 'native',
              listMessages: Effect.succeed([]),
              close: Effect.void,
              send: () =>
                Effect.gen(function* () {
                  sends++
                  yield* Deferred.await(handleReady)
                  history.push({ id: 'user', role: 'user', text: input.text })
                  return {
                    agentId: 'native',
                    runId: 'run',
                    cancel: Effect.sync(() => {
                      cancels++
                    }),
                    wait: Deferred.await(terminated),
                  }
                }),
            }
            const dependencies: CursorHostDependencies = {
              processGroup: {
                terminateChildren: Effect.sync(() => {
                  groupTerminationRequests++
                }),
                waitQuiescent: (timeoutMs) => {
                  expect(timeoutMs).toBe(60_000)
                  return Deferred.succeed(groupWaitStarted, undefined).pipe(Effect.andThen(Deferred.await(groupQuiet)))
                },
              },
              runner: {
                open: () => Effect.succeed(session),
                assertComplete: Effect.void,
                listMessages: () => Effect.succeed([]),
              },
              openStore: (native) => {
                const unused = async (): Promise<never> => {
                  throw new Error('Unexpected store operation')
                }
                return Effect.succeed({
                  agents: {
                    get: async () => ({
                      agentId: native.nativeSessionId,
                      cwd: native.cwd,
                      status: 'idle' as const,
                      createdAt: 0,
                      updatedAt: 0,
                    }),
                    create: unused,
                    update: unused,
                    delete: unused,
                    list: unused,
                  },
                  checkpoints: { get: unused, create: unused, update: unused, delete: unused, list: unused },
                  runs: { get: unused, create: unused, update: unused, delete: unused, list: unused },
                  runEvents: { append: unused, list: unused, delete: unused },
                  dispose: async () => {},
                })
              },
              history: () =>
                Effect.gen(function* () {
                  if (++historyReads === 5) yield* Deferred.succeed(ordinaryRequestsFull, undefined)
                  yield* Deferred.await(historyReady)
                  return history
                }),
              probe: Effect.succeed({
                authenticated: 'unknown',
                models: [],
                sdkVersion: 'fixture',
                platform: 'fixture',
                integrity: true,
                sandboxHelper: true,
              }),
            }
            const handlers = yield* makeCursorHostHandlers(dependencies)
            const native = yield* handlers.open({ config: config(directory), generation: 'process' })
            yield* Stream.runForEach(handlers.events(), (event) => Queue.offer(observed, event)).pipe(Effect.forkScoped)
            const sending = yield* handlers
              .send({ message: input, preparation: prepare(input, native, []) })
              .pipe(Effect.forkScoped)
            for (let i = 0; i < 5; i++) yield* handlers.history(native).pipe(Effect.forkScoped)
            yield* Deferred.await(ordinaryRequestsFull)
            yield* handlers.abort().pipe(Effect.timeout('500 millis'))
            expect(cancels).toBe(0)
            expect(groupTerminationRequests).toBe(1)
            yield* Deferred.succeed(historyReady, undefined)
            yield* Deferred.succeed(handleReady, undefined)
            yield* Fiber.join(sending)
            expect(sends).toBe(1)
            expect(cancels).toBe(1)
            expect(yield* Queue.size(observed)).toBe(0)
            yield* Deferred.succeed(terminated, { id: 'run', status: 'cancelled' as const })
            yield* Deferred.await(groupWaitStarted)
            expect(yield* Queue.size(observed)).toBe(0)
            yield* Deferred.succeed(groupQuiet, undefined)
            const end = yield* Queue.take(observed)
            expect(end).toMatchObject({ event: { type: 'end', outcome: 'cancelled', executionId: 'run' } })
          }),
        ),
      )
    }))
})
