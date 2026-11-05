import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect } from 'effect'
import type { WorkerIPCMessage } from '@baton/protocol'
import { expect, it } from 'vite-plus/test'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { makeNodeLedger, type DiscoveredWorker, type NodeLedger } from './ledger.ts'
import type { DaemonWorkerHost } from './host.ts'
import { makeWorkerRecovery } from './recovery.ts'

const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect)

const worker = (nodeId: string, overrides: Partial<DiscoveredWorker> = {}): DiscoveredWorker => {
  const threadId = overrides.threadId ?? randomUUID()
  return {
    threadId,
    ready: true,
    startup_phase: 'open_attempted',
    launch_attempted: true,
    config: {
      thread_id: threadId,
      node_id: nodeId,
      storage_generation: randomUUID(),
      agent_type: 'cursor',
      runtime_mode: 'full-access',
      working_directory: '/tmp',
      execution_timeout_seconds: 60,
      adapter_config: {},
    },
    ...overrides,
  }
}

const status = (saved: DiscoveredWorker, overrides: Partial<WorkerIPCMessage> = {}): WorkerIPCMessage => ({
  type: 'status',
  ok: true,
  worker_ready: true,
  session_id: saved.threadId,
  storage_generation: saved.config.storage_generation,
  runtime_mode: saved.config.runtime_mode,
  ...overrides,
})

async function fixture(
  saved: DiscoveredWorker | undefined,
  host: DaemonWorkerHost,
  options: { nodeId?: string; lost?: DiscoveredWorker } = {},
) {
  const directory = await makePrivateTempDirectory('baton-recovery-')
  return {
    directory,
    async close() {
      await rm(directory, { recursive: true, force: true })
    },
    async withLedger<A>(run: (ledger: NodeLedger) => Promise<A>) {
      return Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const ledger = yield* makeNodeLedger(join(directory, 'node.db'))
            if (saved) yield* ledger.saveWorker(saved)
            if (options.lost) {
              yield* ledger.saveWorker(options.lost)
              yield* ledger.markWorkerLost(options.lost.threadId, 'history missing')
            }
            return yield* Effect.promise(() => run(ledger))
          }),
        ),
      )
    },
    recovery(ledger: NodeLedger) {
      return makeWorkerRecovery({ ledger, host, ...(options.nodeId ? { nodeId: options.nodeId } : {}) })
    },
  }
}

it('accepts a live Worker without starting another one', async () => {
  const saved = worker(randomUUID())
  const requests: string[] = []
  const ensureWorker = async () => {
    throw new Error('must not launch')
  }
  const f = await fixture(saved, {
    ensureWorker,
    async request(_id, request) {
      requests.push(request.type)
      return status(saved)
    },
  })
  try {
    const result = await f.withLedger(async (ledger) => f.recovery(ledger).ensure(saved.threadId))
    expect(result).toBe('ready')
    expect(requests).toEqual(['status'])
  } finally {
    await f.close()
  }
})

it('starts the in-process Worker and verifies its status', async () => {
  const saved = worker(randomUUID())
  let ensured = 0
  let started = false
  const f = await fixture(saved, {
    async ensureWorker() {
      ensured++
      started = true
    },
    async request() {
      return started ? status(saved) : { type: 'status', ok: false, code: 'unavailable' }
    },
  })
  try {
    const result = await f.withLedger(async (ledger) => f.recovery(ledger).ensure(saved.threadId))
    expect(result).toBe('ready')
    expect(ensured).toBe(1)
  } finally {
    await f.close()
  }
})

it('coalesces concurrent recovery and marks the thread ready only after a verified status', async () => {
  const saved = worker(randomUUID(), { ready: false, launch_attempted: false })
  let resolves!: () => void
  const gate = new Promise<void>((resolve) => {
    resolves = resolve
  })
  let requests = 0
  let started = false
  const f = await fixture(saved, {
    async ensureWorker() {
      await gate
      started = true
    },
    async request() {
      requests++
      return started ? status(saved) : { type: 'status', ok: false, code: 'unavailable' }
    },
  })
  try {
    const result = await f.withLedger(async (ledger) => {
      const recovery = f.recovery(ledger)
      const first = recovery.ensure(saved.threadId)
      const second = recovery.ensure(saved.threadId)
      resolves()
      expect(await first).toBe('ready')
      expect(await second).toBe('ready')
      return run(ledger.worker(saved.threadId))
    })
    expect(requests).toBe(2)
    expect(result).toMatchObject({ ready: true, launch_attempted: true })
  } finally {
    await f.close()
  }
})

it('reports runtime mode conflicts without starting another Worker', async () => {
  const saved = worker(randomUUID())
  const f = await fixture(saved, {
    async ensureWorker() {
      throw new Error('must not launch')
    },
    async request() {
      return status(saved, { runtime_mode: 'auto' })
    },
  })
  try {
    const result = await f.withLedger(async (ledger) => f.recovery(ledger).ensure(saved.threadId))
    expect(result).toBe('runtime_mode_conflict')
  } finally {
    await f.close()
  }
})

it('does not recover another binding or a thread with unavailable history', async () => {
  const nodeId = randomUUID()
  const foreign = worker(randomUUID())
  const lost = worker(nodeId)
  let requests = 0
  const f = await fixture(
    foreign,
    {
      async ensureWorker() {
        throw new Error('must not launch')
      },
      async request() {
        requests++
        return status(foreign)
      },
    },
    { nodeId, lost },
  )
  try {
    const results = await f.withLedger(async (ledger) => {
      const recovery = f.recovery(ledger)
      return [await recovery.ensure(foreign.threadId), await recovery.ensure(lost.threadId)]
    })
    expect(results).toEqual(['retry', 'lost'])
    expect(requests).toBe(0)
  } finally {
    await f.close()
  }
})

it('recovers only owned threads with durable activity and retries when startup fails', async () => {
  const nodeId = randomUUID()
  const active = worker(nodeId, { ready: false })
  const failed = worker(nodeId, { ready: false })
  const ensured: string[] = []
  const started = new Set<string>()
  const f = await fixture(
    active,
    {
      async ensureWorker(id) {
        ensured.push(id)
        if (id === failed.threadId) throw new Error('launch failed')
        started.add(id)
      },
      async request(id) {
        if (!started.has(id)) return { type: 'status', ok: false }
        return id === active.threadId ? status(active) : status(failed)
      },
    },
    { nodeId },
  )
  try {
    const results = await f.withLedger(async (ledger) => {
      await run(ledger.saveWorker(failed))
      await run(
        ledger.recordProcess('thread', failed.threadId, {
          pid: 4321,
          creationTime: 'Thu Nov  5 04:15:31 2026',
          role: 'agent-host',
        }),
      )
      const recovery = f.recovery(ledger)
      await recovery.recoverAll()
      return [await recovery.ensure(failed.threadId), await recovery.ensure(active.threadId)]
    })
    expect(results).toEqual(['retry', 'ready'])
    expect(new Set(ensured)).toEqual(new Set([active.threadId, failed.threadId]))
  } finally {
    await f.close()
  }
})
