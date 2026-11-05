import { randomUUID } from 'node:crypto'
import { realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect } from 'effect'
import type * as Scope from 'effect/Scope'
import type {
  NodeIdentity,
  RuntimeAgent,
  ThreadCommand,
  ThreadReport,
  WorkerCommandResult,
  WorkerRequest,
} from '@baton/protocol'
import { expect, it } from 'vite-plus/test'
import { makeNodeLedger } from './ledger.ts'
import { initializeBrowseRoots, loadBrowseRoots } from '../devices/roots.ts'
import { CommandDeliveryUncertain, makeThreadService } from './threads.ts'
import type { DaemonWorkerHost } from './host.ts'
import { IPCError } from './ipc.ts'
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../platform/private.ts'
import { makePrivateTempDirectory } from '../testing/private.ts'

const capability: RuntimeAgent = {
  agent_type: 'cursor',
  version: 'offline',
  status: 'available',
  models: [],
  default_model: 'default',
  default_runtime_mode: 'full-access',
  runtime_modes: [{ id: 'full-access', available: true }],
  capabilities: { create: true, queue: true, steer: false, stop: true, resume: true, switch_model: false },
}
const accepted = (request: WorkerRequest): WorkerCommandResult => ({
  type: 'result',
  ok: true,
  receipt: {
    command_id: request.command_id!,
    thread_id: request.thread_id!,
    storage_generation: request.storage_generation!,
    action:
      request.type === 'thread_settings'
        ? 'settings'
        : request.type === 'thread_stop'
          ? 'stop'
          : request.type === 'thread_withdraw'
            ? 'withdraw'
            : 'open',
  },
  command_status: { command_id: request.command_id!, state: 'accepted' },
})

async function withService(
  run: (options: {
    commandId: string
    command: ThreadCommand
    host: DaemonWorkerHost
    setHandler: (handler: DaemonWorkerHost['request']) => void
    path: string
  }) => Effect.Effect<void, unknown, Scope.Scope>,
) {
  const path = await makePrivateTempDirectory('bh-')
  try {
    await initializeBrowseRoots(path, path)
    const commandId = randomUUID()
    const command: ThreadCommand = {
      type: 'thread.command',
      thread_id: randomUUID(),
      action: 'open',
      agent_type: 'cursor',
      runtime_mode: 'full-access',
      working_directory: path,
    }
    let ready = false
    let generation: string | undefined
    let handler: DaemonWorkerHost['request'] = async (_id, req) => accepted(req)
    const host: DaemonWorkerHost = {
      async ensureWorker() {
        ready = true
      },
      async request(id, req, options) {
        if (req.type === 'status')
          return {
            type: 'result',
            ok: true,
            worker_ready: ready,
            ...(generation
              ? { storage_generation: generation, session_id: id, runtime_mode: 'full-access' as const }
              : {}),
          }
        if (req.type === 'thread_open') generation = req.storage_generation
        return handler(id, req, options)
      },
    }
    await Effect.runPromise(
      Effect.scoped(
        run({
          commandId,
          command,
          host,
          path,
          setHandler: (next) => {
            handler = next
          },
        }),
      ),
    )
  } finally {
    await rm(path, { recursive: true, force: true })
  }
}

it('queries authenticated Worker status for every new activity challenge without saving a command receipt', async () => {
  await withService(({ command, host, path }) =>
    Effect.gen(function* () {
      const ledger = yield* makeNodeLedger(join(path, 'node.db'))
      const nodeId = randomUUID()
      yield* ledger.saveWorker({
        threadId: command.thread_id,
        config: {
          thread_id: command.thread_id,
          node_id: nodeId,
          storage_generation: 'generation',
          agent_type: 'cursor',
          runtime_mode: 'full-access',
          working_directory: path,
          execution_timeout_seconds: 7200,
          adapter_config: {},
        },
        ready: true,
      })
      let checks = 0
      const service = makeThreadService({
        dataDirectory: path,
        identity: { node_id: nodeId } as NodeIdentity,
        ledger,
        capability: () => capability,
        host: {
          ...host,
          async request(id, request) {
            checks++
            return {
              type: 'result',
              ok: true,
              worker_ready: true,
              agent_ready: true,
              session_id: id,
              storage_generation: 'generation',
              activity_check_seq: request.activity_check_seq!,
              ...(checks === 1 ? { active_turn: { worker_turn_seq: 1, execution_id: 'execution' } } : {}),
            }
          },
        },
      })
      const check: ThreadCommand = {
        type: 'thread.command',
        action: 'check_activity',
        thread_id: command.thread_id,
        storage_generation: 'generation',
        activity_check_seq: 1,
      }
      expect(yield* Effect.promise(() => service.command(randomUUID(), check))).toMatchObject({
        ok: true,
        activity_check_seq: 1,
        active_turn: { worker_turn_seq: 1, execution_id: 'execution' },
      })
      expect(
        yield* Effect.promise(() => service.command(randomUUID(), { ...check, activity_check_seq: 2 })),
      ).toMatchObject({ ok: false, activity_check_seq: 2, code: 'activity_not_verified' })
      expect(checks).toBe(2)
      expect(yield* ledger.pendingCommands()).toEqual([])
    }),
  )
})

it('backs off idle polling, wakes on commands and durably collects late reports before ACK', async () => {
  await withService(({ commandId, command, host, path, setHandler }) =>
    Effect.gen(function* () {
      const ledger = yield* makeNodeLedger(join(path, 'node.db'))
      let now = 0,
        pending = 0,
        status = 0,
        generation = '',
        idle = true,
        unreachable = false,
        ensured = 0
      const reports: ThreadReport[] = []
      setHandler(async (_id, req) => {
        if (req.type === 'thread_open') {
          generation = req.storage_generation!
          return accepted(req)
        }
        if (req.type === 'thread_pending') {
          pending++
          if (unreachable) throw new IPCError('unreachable', 'Offline Worker')
          return {
            type: 'result',
            ok: true,
            worker_ready: true,
            worker_idle: idle,
            session_id: command.thread_id,
            storage_generation: generation,
            runtime_mode: 'full-access',
            thread_reports: [...reports],
          }
        }
        if (req.type === 'thread_ack') {
          expect((await Effect.runPromise(ledger.pendingReports())).map((r) => r.event_id)).toContain(req.event_id)
          reports.splice(0)
          return { type: 'result', ok: true }
        }
        return accepted(req)
      })
      const service = makeThreadService({
        dataDirectory: path,
        identity: { node_id: randomUUID() } as NodeIdentity,
        ledger,
        capability: () => capability,
        now: () => now,
        host: {
          ensureWorker: async (id) => {
            ensured++
            await host.ensureWorker(id)
          },
          request: async (id, req, options) => {
            if (req.type === 'status') status++
            return host.request(id, req, options)
          },
        },
      })
      expect((yield* Effect.promise(() => service.command(commandId, command))).ok).toBe(true)
      yield* Effect.promise(() => service.discover())
      const baseline = status
      for (let i = 0; i < 120; i++) {
        now = i * 250
        yield* Effect.promise(() => service.collectReports())
      }
      expect(pending).toBeLessThanOrEqual(10)
      expect(status - baseline).toBe(0)
      reports.push({
        type: 'thread.report',
        thread_id: command.thread_id,
        storage_generation: generation,
        event_id: randomUUID(),
        worker_seq: 1,
        kind: 'thread.stopped',
      })
      now += 5000
      yield* Effect.promise(() => service.collectReports())
      expect(yield* ledger.pendingReports()).toHaveLength(1)
      expect(reports).toEqual([])
      idle = false
      yield* Effect.promise(() =>
        service.command(randomUUID(), { ...command, action: 'settings', execution_timeout_seconds: 120 }),
      )
      const previous = pending
      expect(yield* Effect.promise(() => service.collectReports())).toBe(250)
      expect(pending).toBe(previous + 1)
      now += 250
      unreachable = true
      yield* Effect.promise(() => service.collectReports())
      expect(status).toBeGreaterThan(baseline)
      // A reachable status keeps recovery from spawning a duplicate Worker.
      expect(ensured).toBe(1)
    }),
  )
})

it('queries a prepared command and resends the identical request only when the Worker has no receipt', async () => {
  await withService(({ commandId, command, host, path, setHandler }) =>
    Effect.gen(function* () {
      const ledger = yield* makeNodeLedger(join(path, 'node.db'))
      const delivered: WorkerRequest[] = [],
        queries: WorkerRequest[] = []
      setHandler(async (_id, req) => {
        if (req.type === 'thread_command_status') {
          queries.push(req)
          return { type: 'result', ok: false, code: 'command_not_found' }
        }
        expect((await Effect.runPromise(ledger.worker(command.thread_id)))?.startup_phase).toBe('open_attempted')
        delivered.push(req)
        if (delivered.length === 1) throw new IPCError('closed', 'Disconnected before command acceptance')
        return accepted(req)
      })
      const service = makeThreadService({
        dataDirectory: path,
        identity: { node_id: randomUUID() } as NodeIdentity,
        ledger,
        host,
        capability: () => capability,
      })
      yield* Effect.promise(async () => {
        await expect(service.command(commandId, command)).rejects.toBeInstanceOf(CommandDeliveryUncertain)
      })
      expect((yield* ledger.pendingCommands()).map((c) => c.id)).toEqual([commandId])
      const result = yield* Effect.promise(() => service.command(commandId, command))
      expect(result.ok).toBe(true)
      expect(queries).toHaveLength(1)
      expect(queries[0]?.command_id).toBe(commandId)
      expect(delivered).toHaveLength(2)
      expect(delivered[1]).toEqual(delivered[0])
      expect(yield* ledger.pendingCommands()).toEqual([])
    }),
  )
})

it('rejects an undelivered open when its mode becomes unavailable before retry', async () => {
  await withService(({ commandId, command, host, path, setHandler }) =>
    Effect.gen(function* () {
      const ledger = yield* makeNodeLedger(join(path, 'node.db'))
      const delivered: WorkerRequest[] = []
      let available = true
      setHandler(async (_id, request) => {
        if (request.type === 'thread_command_status') return { type: 'result', ok: false, code: 'command_not_found' }
        delivered.push(request)
        throw new IPCError('closed', 'Disconnected before command acceptance')
      })
      const service = makeThreadService({
        dataDirectory: path,
        identity: { node_id: randomUUID() } as NodeIdentity,
        ledger,
        host,
        capability: () => ({
          ...capability,
          runtime_modes: [{ id: 'full-access', available, reason: 'Sandbox unavailable' }],
        }),
      })
      yield* Effect.promise(async () => {
        await expect(service.command(commandId, command)).rejects.toBeInstanceOf(CommandDeliveryUncertain)
      })
      available = false
      const result = yield* Effect.promise(() => service.command(commandId, command))
      expect(result).toMatchObject({ ok: false, code: 'runtime_mode_unavailable', reason: 'Sandbox unavailable' })
      expect(delivered).toHaveLength(1)
      expect(yield* ledger.pendingCommands()).toEqual([])
    }),
  )
})

it('registers only a flagged open directory idempotently and reports the roots change', async () => {
  await withService(({ commandId, command, path }) =>
    Effect.gen(function* () {
      const cwd = join(path, 'parent', 'workspace')
      yield* Effect.promise(async () => {
        await ensurePrivateDirectory(join(path, 'parent'))
        await ensurePrivateDirectory(cwd)
        await writePrivateFileAtomic(join(path, 'browse-roots.json'), '{"roots":[]}')
      })
      const ledger = yield* makeNodeLedger(join(path, 'node.db'))
      const running = new Set<string>()
      const generations = new Map<string, string>()
      const host: DaemonWorkerHost = {
        async ensureWorker(id) {
          running.add(id)
        },
        async request(id, request) {
          if (request.type === 'status') {
            const generation = generations.get(id)
            return {
              type: 'result',
              ok: true,
              worker_ready: running.has(id),
              ...(generation
                ? { storage_generation: generation, session_id: id, runtime_mode: 'full-access' as const }
                : {}),
            }
          }
          if (request.type === 'thread_open') generations.set(id, request.storage_generation!)
          return accepted(request)
        },
      }
      let rootsChanged = 0
      const service = makeThreadService({
        dataDirectory: path,
        identity: { node_id: randomUUID() } as NodeIdentity,
        ledger,
        host,
        capability: () => capability,
        onRootsChanged: () => {
          rootsChanged++
        },
      })
      const denied = yield* Effect.promise(() => service.command(randomUUID(), { ...command, working_directory: cwd }))
      expect(denied).toMatchObject({ ok: false, code: 'working_directory_forbidden' })
      const opened = yield* Effect.promise(() =>
        service.command(commandId, { ...command, working_directory: cwd, allow_directory_registration: true }),
      )
      expect(opened.ok).toBe(true)
      const registered = yield* Effect.promise(() => realpath(cwd))
      expect((yield* Effect.promise(() => loadBrowseRoots(path))).map((root) => root.path)).toEqual([registered])
      expect(rootsChanged).toBe(1)
      const again = yield* Effect.promise(() =>
        service.command(randomUUID(), {
          ...command,
          thread_id: randomUUID(),
          working_directory: cwd,
          allow_directory_registration: true,
        }),
      )
      expect(again.ok).toBe(true)
      expect((yield* Effect.promise(() => loadBrowseRoots(path))).map((root) => root.path)).toEqual([registered])
    }),
  )
})

it('fails a flagged open without starting a Worker when the directory does not exist', async () => {
  await withService(({ commandId, command, host, path, setHandler }) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => writePrivateFileAtomic(join(path, 'browse-roots.json'), '{"roots":[]}'))
      const ledger = yield* makeNodeLedger(join(path, 'node.db'))
      let deliveries = 0
      setHandler(async (_id, request) => {
        deliveries++
        return accepted(request)
      })
      const service = makeThreadService({
        dataDirectory: path,
        identity: { node_id: randomUUID() } as NodeIdentity,
        ledger,
        host,
        capability: () => capability,
      })
      const result = yield* Effect.promise(() =>
        service.command(commandId, {
          ...command,
          working_directory: join(path, 'missing'),
          allow_directory_registration: true,
        }),
      )
      expect(result).toMatchObject({
        ok: false,
        code: 'working_directory_missing',
        reason: '目录不存在或无法访问',
      })
      expect(deliveries).toBe(0)
      expect(yield* Effect.promise(() => loadBrowseRoots(path))).toEqual([])
    }),
  )
})

it('delivers settings, stop and withdraw after roots are revoked and the working directory is removed', async () => {
  await withService(({ commandId, command, host, path, setHandler }) =>
    Effect.gen(function* () {
      const cwd = join(path, 'workspace')
      yield* Effect.promise(() => ensurePrivateDirectory(cwd))
      const ledger = yield* makeNodeLedger(join(path, 'node.db'))
      const delivered: WorkerRequest[] = []
      setHandler(async (_id, req) => {
        delivered.push(req)
        return accepted(req)
      })
      const service = makeThreadService({
        dataDirectory: path,
        identity: { node_id: randomUUID() } as NodeIdentity,
        ledger,
        host,
        capability: () => capability,
      })
      const opened = yield* Effect.promise(() => service.command(commandId, { ...command, working_directory: cwd }))
      expect(opened.ok).toBe(true)
      yield* Effect.promise(async () => {
        await writePrivateFileAtomic(join(path, 'browse-roots.json'), '{"roots":[]}')
        await rm(cwd, { recursive: true })
      })
      const actions: ThreadCommand['action'][] = ['settings', 'stop', 'withdraw']
      for (const action of actions) {
        const result = yield* Effect.promise(() =>
          service.command(randomUUID(), {
            type: 'thread.command',
            thread_id: command.thread_id,
            action,
            storage_generation: opened.storage_generation!,
            ...(action === 'settings' ? { execution_timeout_seconds: 14400 } : {}),
            ...(action === 'withdraw' ? { client_message_id: randomUUID() } : {}),
          }),
        )
        expect(result).toMatchObject({ ok: true, storage_generation: opened.storage_generation })
      }
      expect(delivered.map((req) => req.type)).toEqual([
        'thread_open',
        'thread_settings',
        'thread_stop',
        'thread_withdraw',
      ])
      for (const action of ['message', 'resume'] as const) {
        yield* Effect.promise(async () => {
          await expect(
            service.command(randomUUID(), {
              type: 'thread.command',
              thread_id: command.thread_id,
              action,
              storage_generation: opened.storage_generation!,
              ...(action === 'resume' ? { runtime_mode: 'full-access' as const } : {}),
              ...(action === 'message' ? { client_message_id: randomUUID(), content: 'next' } : {}),
            }),
          ).rejects.toBeInstanceOf(CommandDeliveryUncertain)
        })
      }
      expect(delivered).toHaveLength(4)
    }),
  )
})

it.each(['unsupported', 'model_with_steer'])(
  'persists and reuses Worker rejection %s without retrying it',
  async (code) => {
    await withService(({ commandId, command, host, path, setHandler }) =>
      Effect.gen(function* () {
        const ledger = yield* makeNodeLedger(join(path, 'node.db'))
        let deliveries = 0
        setHandler(async () => {
          deliveries++
          return { type: 'result', ok: false, code }
        })
        const service = makeThreadService({
          dataDirectory: path,
          identity: { node_id: randomUUID() } as NodeIdentity,
          ledger,
          host,
          capability: () => capability,
        })
        const result = yield* Effect.promise(() => service.command(commandId, command))
        expect(result).toMatchObject({ ok: false, code })
        expect(yield* Effect.promise(() => service.command(commandId, command))).toEqual(result)
        expect(deliveries).toBe(1)
        expect((yield* ledger.command(commandId))?.result).toEqual(result)
        expect(yield* ledger.pendingCommands()).toEqual([])
      }),
    )
  },
)

it('keeps a command pending when an apparent success carries a conflicting receipt', async () => {
  await withService(({ commandId, command, host, path, setHandler }) =>
    Effect.gen(function* () {
      const ledger = yield* makeNodeLedger(join(path, 'node.db'))
      setHandler(async (_id, req) => ({
        ...accepted(req),
        command_status: { command_id: randomUUID(), state: 'accepted' },
      }))
      const service = makeThreadService({
        dataDirectory: path,
        identity: { node_id: randomUUID() } as NodeIdentity,
        ledger,
        host,
        capability: () => capability,
      })
      yield* Effect.promise(async () => {
        await expect(service.command(commandId, command)).rejects.toBeInstanceOf(CommandDeliveryUncertain)
      })
      expect((yield* ledger.command(commandId))?.result).toBeUndefined()
      expect((yield* ledger.pendingCommands()).map((c) => c.id)).toEqual([commandId])
    }),
  )
})
