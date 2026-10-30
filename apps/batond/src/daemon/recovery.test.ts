import { randomUUID } from 'node:crypto'
import { chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Cause, Effect, Exit, Stream } from 'effect'
import type * as Scope from 'effect/Scope'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import type { ThreadReport, WorkerIPCMessage, WorkerOpenConfig } from '@baton/protocol'
import { acquireProcessLock } from '../platform/lock.ts'
import { writePrivateFileAtomic } from '../platform/private.ts'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { makeWorker, type Worker, type ThreadAgent } from '../worker/index.ts'
import { openWorkerLedger, type State } from '../worker/ledger.ts'
import { initializeWorkerDirectory, LocalWorkerHost } from './host.ts'
import { contentHash, makeNodeLedger, type DiscoveredWorker, type NodeLedger } from './ledger.ts'
import { makeWorkerRecovery } from './recovery.ts'
import type { DaemonWorkerHost } from './host.ts'
import { runWorker } from './worker-runner.ts'

const temporary: string[] = []
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true })
})
const run = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
  const result = await Effect.runPromiseExit(effect)
  if (Exit.isFailure(result)) throw Cause.squash(result.cause)
  return result.value
}
async function fixture() {
  const path = await makePrivateTempDirectory('br-')
  temporary.push(path)
  const threadId = randomUUID(),
    commandId = randomUUID()
  const paths = await initializeWorkerDirectory(path, threadId)
  const config: WorkerOpenConfig = {
    thread_id: threadId,
    node_id: randomUUID(),
    storage_generation: randomUUID(),
    agent_type: 'cursor',
    runtime_mode: 'full-access',
    working_directory: path,
    execution_timeout_seconds: 60,
    adapter_config: {},
  }
  const saved: DiscoveredWorker = { threadId, config, ready: false }
  const prepared = {
    id: commandId,
    hash: contentHash(config),
    request: {
      type: 'thread_open' as const,
      ok: false,
      command_id: commandId,
      thread_id: threadId,
      storage_generation: config.storage_generation,
      open_config: config,
    },
  }
  return { path, paths, saved, prepared }
}
async function withLedger<A>(path: string, use: (ledger: NodeLedger) => Promise<A>): Promise<A> {
  return run(
    Effect.scoped(
      Effect.gen(function* () {
        const ledger = yield* makeNodeLedger(join(path, 'node.db'))
        return yield* Effect.tryPromise({ try: () => use(ledger), catch: (error) => error })
      }),
    ),
  )
}
async function workerLedger(path: string, config: WorkerOpenConfig, state?: Partial<State>): Promise<void> {
  await run(
    Effect.scoped(
      Effect.gen(function* () {
        const ledger = yield* openWorkerLedger({ dbPath: path })
        yield* ledger.save({
          ...ledger.initial,
          config,
          phase: 'idle',
          opened: true,
          nativeId: 'offline-native',
          ...state,
        })
      }),
    ),
  )
  await chmod(path, 0o600)
}
const unreachableHost = () =>
  ({
    ensureWorker: vi.fn(async () => {
      throw new Error('Worker unavailable')
    }),
    request: vi.fn(async () => {
      throw new Error('IPC unavailable')
    }),
  }) satisfies DaemonWorkerHost

it('reports runtime mode conflicts without marking the Worker history lost', async () => {
  const f = await fixture()
  await withLedger(f.path, async (ledger) => {
    await run(ledger.prepare(f.prepared))
    await workerLedger(f.paths.ledger, { ...f.saved.config, runtime_mode: 'approval-required' })
    const host: DaemonWorkerHost = {
      ensureWorker: vi.fn(async () => {}),
      request: vi.fn(async (): Promise<WorkerIPCMessage> => ({
        type: 'result',
        ok: true,
        worker_ready: true,
        session_id: f.saved.threadId,
        storage_generation: f.saved.config.storage_generation,
        runtime_mode: 'approval-required',
      })),
    }
    const live = makeWorkerRecovery({ dataDirectory: f.path, ledger, host })
    expect(await live.ensure(f.saved.threadId)).toBe('runtime_mode_conflict')
    const offline = makeWorkerRecovery({ dataDirectory: f.path, ledger, host: unreachableHost() })
    expect(await offline.ensure(f.saved.threadId)).toBe('runtime_mode_conflict')
    expect((await run(ledger.worker(f.saved.threadId)))?.history_unavailable).not.toBe(true)
  })
})

it('restarts an acknowledged Worker from its existing SQLite ledger and obtains the interrupted Turn end without opening a new native session', async () => {
  const f = await fixture(),
    messageId = randomUUID()
  await workerLedger(f.paths.ledger, f.saved.config, {
    phase: 'busy',
    turn: 1,
    activeMessage: messageId,
    messages: {
      [messageId]: {
        digest: 'offline-message',
        state: 'sent',
        turn: 1,
        executionId: 'offline-execution',
        input: { id: messageId, text: 'offline message', epoch: 0, operationId: randomUUID(), mode: 'queue' },
      },
    },
  })
  const agent: ThreadAgent = {
    open: () => Effect.die('Unexpected native session creation'),
    resume: () => Effect.die('Unexpected resume'),
    prepareInput: () => Effect.die('Unexpected preparation'),
    restoreInput: () => Effect.void,
    send: () => Effect.die('Unexpected send'),
    sent: () => Effect.succeed(undefined),
    events: Stream.never,
    abort: () => Effect.void,
    close: () => Effect.void,
    reap: () => Effect.succeed({ processTreeStopped: true }),
  }
  let turnEnd: ThreadReport | undefined
  for (const firstRun of [true, false]) {
    let worker: Worker | undefined
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const ledger = yield* makeNodeLedger(join(f.path, 'node.db'))
          if (firstRun) {
            yield* ledger.prepare(f.prepared)
            yield* ledger.markWorkerLaunch(f.saved.threadId)
            yield* ledger.received(f.prepared.id, {
              type: 'thread.command_result',
              thread_id: f.saved.threadId,
              ok: true,
              storage_generation: f.saved.config.storage_generation,
            })
          }
          const context = yield* Effect.context<Scope.Scope>()
          const localRun = Effect.runPromiseWith(context)
          const host: DaemonWorkerHost = {
            async ensureWorker() {
              expect((await localRun(ledger.worker(f.saved.threadId)))?.startup_phase).toBe('open_attempted')
              worker = await localRun(makeWorker({ dbPath: f.paths.ledger, agentFactory: () => agent }))
            },
            async request(_threadId, request) {
              if (!worker) throw new Error('Worker process was killed')
              return localRun(worker.handle(request))
            },
          }
          const recovery = makeWorkerRecovery({ dataDirectory: f.path, ledger, host })
          yield* Effect.tryPromise({
            try: async () => {
              await recovery.recoverAll()
              await vi.waitFor(async () => {
                const reply = await host.request(f.saved.threadId, { type: 'thread_pending', ok: false })
                expect(
                  reply.thread_reports?.some((report) => report.kind === 'turn.ended' && report.worker_turn_seq === 1),
                ).toBe(true)
              })
              expect(await recovery.ensure(f.saved.threadId)).toBe('ready')
              expect((await localRun(ledger.worker(f.saved.threadId)))?.ready).toBe(true)
            },
            catch: (error) => error,
          })
        }),
      ),
    )
    const persisted = await run(
      Effect.scoped(openWorkerLedger({ dbPath: f.paths.ledger }).pipe(Effect.map((ledger) => ledger.initial))),
    )
    expect(persisted.nativeId).toBe('offline-native')
    expect(persisted.messages[messageId]?.ended).toBe(true)
    const ends = persisted.outbox.filter((entry) => entry.report.kind === 'turn.ended').map((entry) => entry.report)
    expect(ends).toHaveLength(1)
    if (turnEnd) expect(ends[0]).toEqual(turnEnd)
    turnEnd = ends[0]
  }
})

it('appends one stable history-unavailable report after all durable node reports and preserves the loss across restart and stale discovery writes', async () => {
  const f = await fixture(),
    host = unreachableHost()
  let stopped: ThreadReport | undefined
  const earlier: ThreadReport[] = [1, 2, 3].map((worker_seq) => ({
    type: 'thread.report',
    thread_id: f.saved.threadId,
    storage_generation: f.saved.config.storage_generation,
    event_id: randomUUID(),
    worker_seq,
    kind: 'thread.opened',
  }))
  await withLedger(f.path, async (ledger) => {
    await run(ledger.prepare(f.prepared))
    await run(ledger.markWorkerLaunch(f.saved.threadId))
    for (const report of earlier) await run(ledger.ingest(report))
    const recovery = makeWorkerRecovery({ dataDirectory: f.path, ledger, host, inspect: async () => 'missing' })
    expect(await recovery.ensure(f.saved.threadId)).toBe('lost')
    const pending = await run(ledger.pendingReports())
    expect(pending.slice(0, 3)).toEqual(earlier)
    stopped = pending[3]
    expect(stopped).toMatchObject({
      worker_seq: 4,
      kind: 'thread.unknown',
      history_unavailable: true,
      storage_generation: f.saved.config.storage_generation,
    })
    await run(ledger.saveWorker({ ...f.saved, ready: true }))
    expect((await run(ledger.worker(f.saved.threadId)))?.history_unavailable).toEqual(stopped)
    expect((await run(ledger.worker(f.saved.threadId)))?.ready).toBe(false)
    expect(await run(ledger.pendingCommands())).toEqual([])
  })
  await withLedger(f.path, async (ledger) => {
    const recovery = makeWorkerRecovery({ dataDirectory: f.path, ledger, host, inspect: async () => 'missing' })
    expect(await recovery.ensure(f.saved.threadId)).toBe('lost')
    expect(await run(ledger.markWorkerLost(f.saved.threadId, 'another inspection'))).toEqual(stopped)
    expect(await run(ledger.pendingReports())).toEqual([...earlier, stopped])
    for (const report of [...earlier, stopped!])
      await run(ledger.acknowledge({ ...report, type: 'thread.report_result', ok: true }))
    expect(await run(ledger.pendingReports())).toEqual([])
    expect(await recovery.ensure(f.saved.threadId)).toBe('lost')
  })
})

it.each(['missing', 'empty'] as const)(
  'retries a pre-open startup with a %s ledger across daemon restarts',
  async (condition) => {
    const f = await fixture()
    const inspect = async () => condition
    await withLedger(f.path, async (ledger) => {
      await run(ledger.prepare(f.prepared))
      const recovery = makeWorkerRecovery({ dataDirectory: f.path, ledger, host: unreachableHost(), inspect })
      expect(await recovery.ensure(f.saved.threadId)).toBe('retry')
      expect((await run(ledger.worker(f.saved.threadId)))?.startup_phase).toBe('awaiting_open')
    })
    let running = false
    const host: DaemonWorkerHost = {
      async ensureWorker() {
        running = true
      },
      async request() {
        if (!running) throw new Error('Not started')
        return { type: 'result', ok: true, worker_ready: true }
      },
    }
    await withLedger(f.path, async (ledger) => {
      const restarted = makeWorkerRecovery({ dataDirectory: f.path, ledger, host, inspect })
      expect((await run(ledger.worker(f.saved.threadId)))?.launch_attempted).toBe(true)
      expect(await restarted.ensure(f.saved.threadId)).toBe('ready')
      expect((await run(ledger.pendingCommands())).map((command) => command.id)).toEqual([f.prepared.id])
      expect(await run(ledger.pendingReports())).toEqual([])
    })
    await withLedger(f.path, async (ledger) => {
      const reconnected = makeWorkerRecovery({ dataDirectory: f.path, ledger, host, inspect })
      expect(await reconnected.ensure(f.saved.threadId)).toBe('ready')
      expect((await run(ledger.worker(f.saved.threadId)))?.startup_phase).toBe('awaiting_open')
      expect(await run(ledger.pendingReports())).toEqual([])
    })
  },
)

it.each(['missing', 'empty'] as const)(
  'never recreates a %s ledger after a possible open handoff, including after stale discovery writes',
  async (condition) => {
    const f = await fixture()
    await withLedger(f.path, async (ledger) => {
      await run(ledger.prepare(f.prepared))
      await run(ledger.markWorkerLaunch(f.saved.threadId))
      await run(ledger.markWorkerOpenAttempt(f.saved.threadId))
      await run(ledger.saveWorker({ ...f.saved, startup_phase: 'awaiting_open' }))
    })
    await withLedger(f.path, async (ledger) => {
      expect((await run(ledger.worker(f.saved.threadId)))?.startup_phase).toBe('open_attempted')
      const recovery = makeWorkerRecovery({
        dataDirectory: f.path,
        ledger,
        host: unreachableHost(),
        inspect: async () => condition,
      })
      expect(await recovery.ensure(f.saved.threadId)).toBe('lost')
      expect((await run(ledger.pendingReports()))[0]).toMatchObject({ history_unavailable: true, worker_seq: 1 })
    })
  },
)

it('retains an IPC open attempt made before daemon registration across ledger restart', async () => {
  const f = await fixture(),
    host = unreachableHost()
  await withLedger(f.path, async (ledger) => {
    await run(ledger.markWorkerOpenAttempt(f.saved.threadId))
    expect(await run(ledger.workers())).toEqual([])
  })
  await withLedger(f.path, async (ledger) => {
    await run(ledger.prepare(f.prepared))
    expect((await run(ledger.worker(f.saved.threadId)))?.startup_phase).toBe('open_attempted')
    const recovery = makeWorkerRecovery({ dataDirectory: f.path, ledger, host, inspect: async () => 'missing' })
    expect(await recovery.ensure(f.saved.threadId)).toBe('lost')
  })
})

it('persists an open received directly over IPC before native session creation', async () => {
  const f = await fixture()
  const host = new LocalWorkerHost(f.path)
  const previousUmask = process.umask()
  try {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const ledger = yield* makeNodeLedger(join(f.path, 'node.db'))
          yield* ledger.prepare(f.prepared)
          yield* Effect.promise(() => writePrivateFileAtomic(f.paths.token, 'a'.repeat(64)))
          const agent: ThreadAgent = {
            open: () =>
              Effect.gen(function* () {
                expect((yield* ledger.worker(f.saved.threadId).pipe(Effect.orDie))?.startup_phase).toBe(
                  'open_attempted',
                )
                return { nativeSessionId: 'offline-native' }
              }),
            resume: () => Effect.die('Unexpected resume'),
            prepareInput: () => Effect.die('Unexpected preparation'),
            restoreInput: () => Effect.void,
            send: () => Effect.die('Unexpected send'),
            sent: () => Effect.succeed(undefined),
            events: Stream.never,
            abort: () => Effect.void,
            close: () => Effect.void,
            reap: () => Effect.succeed({ processTreeStopped: true }),
          }
          yield* Effect.forkIn(
            runWorker({
              dataDirectory: f.path,
              threadId: f.saved.threadId,
              command: {
                executable: process.execPath,
                args: [fileURLToPath(new URL('../testing/platform/process.mjs', import.meta.url))],
              },
              agentFactory: () => agent,
            }),
            yield* Effect.scope,
          )
          yield* Effect.tryPromise({
            try: async () => {
              await vi.waitFor(
                async () => {
                  expect((await host.request(f.saved.threadId, { type: 'status', ok: false })).worker_ready).toBe(true)
                },
                { timeout: 5000 },
              )
              expect((await run(ledger.worker(f.saved.threadId)))?.startup_phase).toBe('awaiting_open')
              const reply = await host.request(f.saved.threadId, f.prepared.request)
              expect(reply.ok).toBe(true)
              expect((await run(ledger.worker(f.saved.threadId)))?.startup_phase).toBe('open_attempted')
              await vi.waitFor(async () => {
                const pending = await host.request(f.saved.threadId, { type: 'thread_pending', ok: false })
                expect(pending.thread_reports?.some((report) => report.kind === 'thread.opened')).toBe(true)
              })
            },
            catch: (error) => error,
          })
        }),
      ),
    )
  } finally {
    process.umask(previousUmask)
  }
})

it('allows one legitimate first launch and coalesces concurrent requests before the first open handoff', async () => {
  const f = await fixture()
  await withLedger(f.path, async (ledger) => {
    await run(ledger.prepare(f.prepared))
    let running = false
    const host = {
      ensureWorker: vi.fn(async () => {
        running = true
      }),
      request: vi.fn(async (): Promise<WorkerIPCMessage> => {
        if (!running) throw new Error('Not started')
        return { type: 'result', ok: true, worker_ready: true }
      }),
    } satisfies DaemonWorkerHost
    const recovery = makeWorkerRecovery({ dataDirectory: f.path, ledger, host, inspect: async () => 'missing' })
    expect(await Promise.all(Array.from({ length: 8 }, () => recovery.ensure(f.saved.threadId)))).toEqual(
      Array(8).fill('ready'),
    )
    expect(await recovery.ensure(f.saved.threadId)).toBe('ready')
    expect((await run(ledger.worker(f.saved.threadId)))?.launch_attempted).toBe(true)
    expect(await run(ledger.pendingReports())).toEqual([])
  })
})

it('persists a definitive corruption verdict once across daemon restarts', async () => {
  const f = await fixture()
  let lost: ThreadReport[] = []
  await withLedger(f.path, async (ledger) => {
    await run(ledger.prepare(f.prepared))
    const recovery = makeWorkerRecovery({
      dataDirectory: f.path,
      ledger,
      host: unreachableHost(),
      inspect: async () => 'corrupt',
    })
    expect(await recovery.ensure(f.saved.threadId)).toBe('lost')
    expect(await recovery.ensure(f.saved.threadId)).toBe('lost')
    lost = await run(ledger.pendingReports())
    expect(lost).toHaveLength(1)
    expect(lost[0]).toMatchObject({ kind: 'thread.unknown', history_unavailable: true })
  })
  await withLedger(f.path, async (ledger) => {
    const recovery = makeWorkerRecovery({
      dataDirectory: f.path,
      ledger,
      host: unreachableHost(),
      inspect: async () => 'valid',
    })
    expect(await recovery.ensure(f.saved.threadId)).toBe('lost')
    expect(await run(ledger.pendingReports())).toEqual(lost)
  })
})

it('does not recreate a missing ledger without durable proof that open was never attempted', async () => {
  const f = await fixture(),
    host = unreachableHost()
  await withLedger(f.path, async (ledger) => {
    await run(ledger.saveWorker({ ...f.saved, launch_attempted: true }))
    const recovery = makeWorkerRecovery({ dataDirectory: f.path, ledger, host, inspect: async () => 'missing' })
    expect(await recovery.ensure(f.saved.threadId)).toBe('lost')
  })
})

it('keeps a retry verdict retryable without publishing history loss or advancing startup', async () => {
  const f = await fixture()
  await withLedger(f.path, async (ledger) => {
    await run(ledger.prepare(f.prepared))
    const before = await run(ledger.worker(f.saved.threadId))
    const recovery = makeWorkerRecovery({
      dataDirectory: f.path,
      ledger,
      host: unreachableHost(),
      inspect: async () => 'retry',
    })
    expect(await recovery.ensure(f.saved.threadId)).toBe('retry')
    expect(await run(ledger.pendingReports())).toEqual([])
    expect(await run(ledger.worker(f.saved.threadId))).toEqual(before)
  })
})

it('does not infer ledger loss from an IPC failure while the Worker process lock is held', async () => {
  const f = await fixture(),
    host = unreachableHost()
  await withLedger(f.path, async (ledger) => {
    await run(ledger.prepare(f.prepared))
    await run(ledger.markWorkerLaunch(f.saved.threadId))
    await run(ledger.markWorkerOpenAttempt(f.saved.threadId))
    const release = await acquireProcessLock(f.paths.lock)
    let locked = true
    const recovery = makeWorkerRecovery({
      dataDirectory: f.path,
      ledger,
      host,
      inspect: async () => {
        if (locked) throw new Error('Inspection must wait for the Worker lock')
        return 'missing'
      },
    })
    try {
      expect(await recovery.ensure(f.saved.threadId)).toBe('retry')
      expect(await run(ledger.pendingReports())).toEqual([])
    } finally {
      await release()
      locked = false
    }
    expect(await recovery.ensure(f.saved.threadId)).toBe('lost')
  })
})

it('accepts authenticated Worker status before consulting an unavailable ledger', async () => {
  const f = await fixture()
  await withLedger(f.path, async (ledger) => {
    await run(ledger.prepare(f.prepared))
    const host: DaemonWorkerHost = {
      async ensureWorker() {
        throw new Error('A surviving Worker must not be launched again')
      },
      async request() {
        return {
          type: 'result',
          ok: true,
          worker_ready: true,
          session_id: f.saved.threadId,
          storage_generation: f.saved.config.storage_generation,
          runtime_mode: f.saved.config.runtime_mode,
        }
      },
    }
    const recovery = makeWorkerRecovery({
      dataDirectory: f.path,
      ledger,
      host,
      inspect: async () => {
        throw new Error('Ready status must take precedence over file inspection')
      },
    })
    expect(await recovery.ensure(f.saved.threadId)).toBe('ready')
  })
  await withLedger(f.path, async (ledger) => {
    expect(await run(ledger.worker(f.saved.threadId))).toMatchObject({
      ready: true,
      launch_attempted: true,
      startup_phase: 'open_attempted',
    })
    expect(await run(ledger.pendingReports())).toEqual([])
  })
})

it.each(['open-attempt', 'history-loss'] as const)(
  'rereads the durable %s recorded during inspection before deciding to launch',
  async (change) => {
    const f = await fixture()
    await withLedger(f.path, async (ledger) => {
      await run(ledger.prepare(f.prepared))
      let loss: ThreadReport | undefined
      const recovery = makeWorkerRecovery({
        dataDirectory: f.path,
        ledger,
        host: unreachableHost(),
        inspect: async () => {
          if (change === 'open-attempt') {
            await run(ledger.markWorkerOpenAttempt(f.saved.threadId))
            return 'missing'
          }
          loss = await run(ledger.markWorkerLost(f.saved.threadId, 'Concurrent recovery found history loss'))
          return 'valid'
        },
      })
      expect(await recovery.ensure(f.saved.threadId)).toBe('lost')
      const reports = await run(ledger.pendingReports())
      expect(reports).toHaveLength(1)
      expect(reports[0]).toMatchObject({ history_unavailable: true, kind: 'thread.unknown' })
      if (loss) expect(reports).toEqual([loss])
      expect((await run(ledger.worker(f.saved.threadId)))?.ready).toBe(false)
    })
  },
)

it('retries a failed restart with an intact ledger and reconnects to a surviving Worker without another launch', async () => {
  const f = await fixture()
  await withLedger(f.path, async (ledger) => {
    await run(ledger.prepare(f.prepared))
    await run(ledger.markWorkerLaunch(f.saved.threadId))
    let available = false
    const host = {
      ensureWorker: vi.fn(async () => {
        throw new Error('Temporary process resource exhaustion')
      }),
      request: vi.fn(async (): Promise<WorkerIPCMessage> => {
        if (!available) throw new Error('IPC temporarily unavailable')
        return {
          type: 'result',
          ok: true,
          worker_ready: true,
          session_id: f.saved.threadId,
          storage_generation: f.saved.config.storage_generation,
          runtime_mode: f.saved.config.runtime_mode,
        }
      }),
    } satisfies DaemonWorkerHost
    const recovery = makeWorkerRecovery({ dataDirectory: f.path, ledger, host, inspect: async () => 'valid' })
    expect(await recovery.ensure(f.saved.threadId)).toBe('retry')
    available = true
    expect(await recovery.ensure(f.saved.threadId)).toBe('ready')
    expect(await run(ledger.pendingReports())).toEqual([])
  })
})
