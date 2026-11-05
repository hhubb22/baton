import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect } from 'effect'
import { expect, it, vi } from 'vite-plus/test'
import type { NodeIdentity, WorkerOpenConfig } from '@baton/protocol'
import { initializeBrowseRoots } from '../devices/roots.ts'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../platform/private.ts'
import { makeNodeLedger } from './ledger.ts'
import { makeThreadService } from './threads.ts'
import { runDaemon } from './daemon.ts'
import { ControlClient } from './control-client.ts'
import { loadBindingFence } from './binding-fence.ts'
import { openExecutionLedger, readExecutionState } from '../execution/ledger.ts'
import { executionPaths } from '../execution/paths.ts'
import { makeExecutionService } from '../execution/service.ts'
import { syncingExecutionReports } from './upgrade-execution.ts'
import { FullOutputStore } from '../worker/full-output.ts'
import { makeProjectLedger } from '../project/ledger.ts'
import { loadIdentity, saveDeviceIdentity } from './identity.ts'

it('logout fences retained queues, reports and execution outputs from a replacement binding', async () => {
  const directory = await makePrivateTempDirectory('baton-rebind-')
  const oldNode = randomUUID(),
    newNode = randomUUID(),
    threadId = randomUUID(),
    executionId = randomUUID(),
    generation = randomUUID()
  const identity: NodeIdentity = {
    node_id: oldNode,
    employee_id: randomUUID(),
    coordinator_url: 'https://old.invalid',
    display_name: 'Old device',
    system: 'linux',
    role: '',
    capabilities: [],
    registration_seq: 1,
    registered_at: new Date().toISOString(),
    credential: { id: randomUUID(), token: 'old-secret', version: 1, expires_at: null },
  }
  const config: WorkerOpenConfig = {
    thread_id: threadId,
    node_id: oldNode,
    storage_generation: generation,
    agent_type: 'cursor',
    runtime_mode: 'full-access',
    working_directory: directory,
    execution_timeout_seconds: 7200,
    adapter_config: {},
  }
  const commandId = randomUUID(),
    eventId = randomUUID(),
    projectRun = randomUUID(),
    queuedProjectRun = randomUUID()
  const controller = new AbortController()
  let daemon: Promise<void> | undefined
  try {
    await initializeBrowseRoots(directory, directory)
    await writePrivateFileAtomic(join(directory, 'identity.json'), JSON.stringify(identity))
    await ensurePrivateDirectory(join(directory, 'threads'))
    await ensurePrivateDirectory(join(directory, 'threads', threadId))
    const physicalOnlyThread = randomUUID()
    await ensurePrivateDirectory(join(directory, 'threads', physicalOnlyThread))
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ledger = yield* makeNodeLedger(join(directory, 'node.db'))
          yield* ledger.prepare({
            id: commandId,
            hash: 'pending-open',
            request: {
              type: 'thread_open',
              ok: false,
              command_id: commandId,
              thread_id: threadId,
              storage_generation: generation,
              open_config: config,
            },
          })
          yield* ledger.ingest({
            type: 'thread.report',
            thread_id: threadId,
            storage_generation: generation,
            event_id: eventId,
            worker_seq: 1,
            kind: 'thread.unknown',
            reason: 'retained old report',
          })
          const project = yield* makeProjectLedger(join(directory, 'project-runtime.db'))
          yield* project.insert({ type: 'project_run_start', run_id: projectRun, lease_epoch: 1 }, true)
          yield* project.enqueue('old-pending', { type: 'project_run_start', run_id: queuedProjectRun, lease_epoch: 1 })
        }),
      ),
    )
    await ensurePrivateDirectory(join(directory, 'executions'))
    const paths = executionPaths(directory, executionId)
    await ensurePrivateDirectory(paths.directory)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const execution = yield* openExecutionLedger(paths.ledger)
          yield* execution.save({
            intent: false,
            command: {
              type: 'execution.command',
              action: 'start',
              execution_id: executionId,
              storage_generation: generation,
              command: 'old queued command',
            },
            reports: [
              {
                acked: false,
                report: {
                  type: 'execution.report',
                  execution_id: executionId,
                  storage_generation: generation,
                  event_id: randomUUID(),
                  seq: 1,
                  status: 'pending',
                },
              },
            ],
          })
        }),
      ),
    )
    const output = await new FullOutputStore(paths.directory).put(
      { thread_id: executionId, storage_generation: generation },
      Buffer.from('old private output'),
      1,
    )
    const client = new ControlClient(directory, {
      start: async () => {
        daemon = Effect.runPromise(
          Effect.scoped(runDaemon({ dataDirectory: directory, boundRuntime: () => Effect.never })),
          { signal: controller.signal },
        )
        daemon.catch(() => undefined)
      },
    })
    await client.status()
    expect(await client.request({ method: 'logout' })).toEqual({ ok: true })
    const fence = await loadBindingFence(directory)
    expect(fence).toEqual({
      node_ids: [oldNode],
      thread_ids: expect.arrayContaining([threadId, physicalOnlyThread]),
      execution_ids: [executionId],
      project_run_ids: expect.arrayContaining([projectRun, queuedProjectRun]),
    })
    const host = {
      ensureWorker: vi.fn(async () => undefined),
      request: vi.fn(async () => {
        throw new Error('retired Worker must not be contacted')
      }),
    }
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ledger = yield* makeNodeLedger(join(directory, 'node.db'), newNode, new Set(fence.thread_ids))
          expect(yield* ledger.worker(threadId)).toBeUndefined()
          expect(yield* ledger.command(commandId)).toBeUndefined()
          expect(yield* ledger.pendingCommands()).toEqual([])
          expect(yield* ledger.pendingReports()).toEqual([])
          const threads = makeThreadService({
            dataDirectory: directory,
            identity: { ...identity, node_id: newNode },
            excludedThreadIds: new Set(fence.thread_ids),
            ledger,
            host,
            capability: () => [],
          })
          yield* Effect.promise(() => threads.discover())
          yield* Effect.promise(() => threads.recover())
          yield* Effect.promise(() => threads.collectReports())
          expect(
            yield* Effect.promise(() =>
              threads.command(randomUUID(), {
                type: 'thread.command',
                action: 'check_activity',
                thread_id: threadId,
                storage_generation: generation,
                activity_check_seq: 1,
              }),
            ),
          ).toMatchObject({ ok: false, code: 'binding_mismatch' })
          expect(
            yield* Effect.promise(() =>
              threads.command(randomUUID(), {
                type: 'thread.command',
                action: 'open',
                thread_id: physicalOnlyThread,
                agent_type: 'cursor',
                runtime_mode: 'full-access',
                working_directory: directory,
              }),
            ),
          ).toMatchObject({ ok: false, code: 'binding_mismatch' })
          const physicalOpen = makeThreadService({
            dataDirectory: directory,
            identity: { ...identity, node_id: newNode },
            ledger,
            host,
            capability: () => ({
              agent_type: 'cursor',
              version: 'offline',
              status: 'available',
              models: [],
              default_model: 'default',
              runtime_modes: [{ id: 'full-access', available: true }],
              capabilities: { create: true, queue: true, steer: false, stop: true, resume: true, switch_model: false },
            }),
          })
          expect(
            yield* Effect.promise(() =>
              physicalOpen.command(randomUUID(), {
                type: 'thread.command',
                action: 'open',
                thread_id: physicalOnlyThread,
                agent_type: 'cursor',
                runtime_mode: 'full-access',
                working_directory: directory,
              }),
            ),
          ).toMatchObject({ ok: false, code: 'binding_mismatch' })
          yield* ledger.acknowledge({
            type: 'thread.report_result',
            thread_id: threadId,
            worker_seq: 1,
            event_id: eventId,
            ok: true,
          })
          const project = yield* makeProjectLedger(
            join(directory, 'project-runtime.db'),
            new Set(fence.project_run_ids),
          )
          expect(yield* project.pending()).toEqual([])
          expect(yield* project.get(projectRun)).toBeUndefined()
          expect(yield* project.claim(Date.now())).toBeUndefined()
          yield* project.ack(projectRun, 1)
        }),
      ),
    )
    expect(host.ensureWorker).not.toHaveBeenCalled()
    expect(host.request).not.toHaveBeenCalled()
    const exclusions = new Set(fence.execution_ids)
    const executions = makeExecutionService({ dataDirectory: directory, excludedIds: exclusions })
    await executions.recover()
    expect(await executions.collectReports()).toEqual([])
    expect(await syncingExecutionReports(directory, exclusions).collectReports()).toEqual([])
    expect(
      await executions.command({
        type: 'execution.command',
        action: 'start',
        execution_id: executionId,
        storage_generation: generation,
      }),
    ).toMatchObject({ ok: false, code: 'binding_mismatch' })
    expect(
      await executions.output({
        type: 'execution.output_request',
        operation_id: randomUUID(),
        execution_id: executionId,
        output_id: output.id,
        storage_generation: generation,
      }),
    ).toMatchObject({ ok: false, code: 'binding_mismatch' })
    const retainedReport = readExecutionState(paths.ledger)!.reports[0]!.report
    const ack = {
      type: 'execution.report_result' as const,
      execution_id: executionId,
      event_id: retainedReport.event_id,
      seq: retainedReport.seq,
      ok: true,
    }
    await executions.ack(ack)
    await syncingExecutionReports(directory, exclusions).ack(ack)
    expect(readExecutionState(paths.ledger)?.reports[0]?.acked).toBe(false)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const original = yield* makeNodeLedger(join(directory, 'node.db'))
          expect(yield* original.pendingCommands()).toHaveLength(1)
          expect(yield* original.pendingReports()).toHaveLength(1)
          const originalProject = yield* makeProjectLedger(join(directory, 'project-runtime.db'))
          expect(yield* originalProject.get(projectRun)).toMatchObject({ cleanup_acked: 0 })
        }),
      ),
    )
    expect(await readFile(join(paths.directory, 'full-output', `${output.id}.bin`), 'utf8')).toBe('old private output')
    expect(await client.shutdown()).toEqual({ ok: true })
    await daemon
  } finally {
    controller.abort()
    await daemon?.catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

it('device login fences retained execution and Project work when identity was lost', async () => {
  const directory = await makePrivateTempDirectory('baton-lost-identity-')
  const executionId = randomUUID(),
    projectRun = randomUUID(),
    generation = randomUUID()
  const identity: NodeIdentity = {
    node_id: randomUUID(),
    employee_id: randomUUID(),
    coordinator_url: 'https://replacement.invalid',
    display_name: 'Replacement device',
    system: 'linux',
    role: '',
    capabilities: [],
    registration_seq: 1,
    registered_at: new Date().toISOString(),
    credential: { id: randomUUID(), token: 'new-secret', version: 1, expires_at: null },
  }
  try {
    await ensurePrivateDirectory(join(directory, 'executions'))
    const paths = executionPaths(directory, executionId)
    await ensurePrivateDirectory(paths.directory)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const execution = yield* openExecutionLedger(paths.ledger)
          yield* execution.save({
            intent: false,
            command: {
              type: 'execution.command',
              action: 'start',
              execution_id: executionId,
              storage_generation: generation,
              command: 'old queued command',
            },
            reports: [
              {
                acked: false,
                report: {
                  type: 'execution.report',
                  execution_id: executionId,
                  storage_generation: generation,
                  event_id: randomUUID(),
                  seq: 1,
                  status: 'pending',
                },
              },
            ],
          })
          const project = yield* makeProjectLedger(join(directory, 'project-runtime.db'))
          yield* project.enqueue('lost-binding-command', {
            type: 'project_run_start',
            run_id: projectRun,
            lease_epoch: 1,
          })
        }),
      ),
    )
    await expect(readFile(join(directory, 'identity.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    const saved = await saveDeviceIdentity(directory, identity, identity.coordinator_url!)
    expect(saved).toEqual(identity)
    expect(await loadIdentity(directory)).toEqual(identity)
    const fence = await loadBindingFence(directory)
    expect(fence.execution_ids).toEqual([executionId])
    expect(fence.project_run_ids).toEqual([projectRun])
    expect(fence.node_ids).not.toContain(identity.node_id)
    const executions = makeExecutionService({ dataDirectory: directory, excludedIds: new Set(fence.execution_ids) })
    await executions.recover()
    expect(await executions.collectReports()).toEqual([])
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const current = yield* makeProjectLedger(
            join(directory, 'project-runtime.db'),
            new Set(fence.project_run_ids),
          )
          expect(yield* current.pending()).toEqual([])
          const retained = yield* makeProjectLedger(join(directory, 'project-runtime.db'))
          expect(yield* retained.pending()).toHaveLength(1)
        }),
      ),
    )
    expect(readExecutionState(paths.ledger)?.command?.command).toBe('old queued command')
    expect(readExecutionState(paths.ledger)?.reports[0]?.acked).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
