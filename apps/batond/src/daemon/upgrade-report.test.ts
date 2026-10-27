import { randomUUID } from 'node:crypto'
import { readdir, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Effect, Schema } from 'effect'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import type WebSocket from 'ws'
import {
  Envelope,
  NodeToControlBody,
  type NodeUpgradeStateRequest,
  type ThreadReport,
  type WorkerOpenConfig,
} from '@baton/protocol'
import { setupDaemon } from '../testing/daemon.ts'
import { upgradeCenter, writeUpgradePackage } from '../testing/upgrade.ts'
import { writePrivateFileAtomic } from '../platform/private.ts'
import { openWorkerLedger, readLedger } from '../worker/ledger.ts'
import { initializeWorkerDirectory, type DaemonWorkerHost } from './host.ts'
import { makeNodeLedger } from './ledger.ts'
import { migrateUpgrade } from './upgrade-migrate.ts'
import { prepareUpgrade, readUpgradeState, requestUpgrade, saveUpgradeState, upgradePaused } from './upgrade.ts'
import { webSocketText } from './transport.ts'

vi.mock('node:https', async () => (await import('../testing/upgrade.ts')).upgradeHTTPSFixture())
vi.mock('node:child_process', async () => (await import('../testing/upgrade.ts')).upgradeProcessFixture())

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function control(socket: WebSocket, body: unknown, correlation: string) {
  socket.send(
    JSON.stringify({
      kind: 'envelope',
      envelope: {
        version: 1,
        message_id: randomUUID(),
        route: { to: 'node' },
        priority: 'control',
        source: { kind: 'control' },
        correlation_id: correlation,
        body,
      },
    }),
  )
}

it.each(['ready', 'failed'] as const)(
  '%s 受限连接无业务数据库时重投丢失或不匹配的 ACK，确认后停投并在重连时重报',
  async (phase) => {
    const { path, wss, start } = await setupDaemon(cleanup)
    const state = {
      operation_id: randomUUID(),
      source_version: 'development',
      target_version: 'v1',
      phase,
    }
    await saveUpgradeState(path, {
      ...state,
      target_path: join(path, 'private-package'),
      reason: 'private failure diagnostic',
    })
    const deliveries: Array<{ connection: number; id: string; body: NodeUpgradeStateRequest }> = []
    let connections = 0
    let reports = 0
    let current: WebSocket | undefined
    wss.on('connection', (socket) => {
      const connection = ++connections
      current = socket
      socket.on('message', (bytes) => {
        const raw = webSocketText(bytes)
        const frame = JSON.parse(raw)
        if (frame.kind === 'auth') socket.send(JSON.stringify({ kind: 'auth_result', ok: true }))
        if (frame.kind !== 'envelope') return
        const env = Schema.decodeUnknownSync(Envelope)(frame.envelope)
        const body = Schema.decodeUnknownSync(NodeToControlBody)(env.body)
        if (body.type === 'node.sync') control(socket, { type: 'node.sync_result', ok: true }, env.message_id)
        if (body.type === 'node.runtime_report') {
          expect(body.report.upgrade_protocol).toBe(1)
          expect(body.report.exec.enabled).toBe(false)
          reports++
          control(socket, { type: 'node.runtime_report_result', ok: true }, env.message_id)
        }
        if (body.type !== 'node.upgrade_state') return
        expect(raw).not.toContain('target_path')
        expect(raw).not.toContain('private-package')
        expect(raw).not.toContain('private failure diagnostic')
        deliveries.push({ connection, id: env.message_id, body })
        const ack = { type: 'node.upgrade_state_result', operation_id: state.operation_id, phase, ok: true }
        if (connection > 1) {
          control(socket, ack, env.message_id)
          return
        }
        // 首次丢 ACK；随后逐项核实关联 ID、操作、阶段和成功标记。
        switch (deliveries.length) {
          case 1:
            break
          case 2:
            control(socket, ack, randomUUID())
            break
          case 3:
            control(socket, { ...ack, operation_id: randomUUID() }, env.message_id)
            break
          case 4:
            control(socket, { ...ack, phase: 'draining' }, env.message_id)
            break
          case 5:
            control(socket, { ...ack, ok: false, code: 'upgrade_conflict' }, env.message_id)
            break
          default:
            control(socket, ack, env.message_id)
        }
      })
    })
    const daemon = start()
    await vi.waitFor(() => expect(deliveries).toHaveLength(6), { timeout: 5000 })
    await delay(300)
    expect(deliveries).toHaveLength(6)
    expect(new Set(deliveries.map((entry) => entry.id)).size).toBe(1)
    for (const delivery of deliveries) expect(delivery.body).toEqual({ type: 'node.upgrade_state', ...state })
    expect(reports).toBeGreaterThan(0)
    expect(await readdir(path)).not.toContain('node.db')
    expect(await readdir(path)).not.toContain('project-runtime.db')

    current!.terminate()
    await vi.waitFor(() => expect(deliveries).toHaveLength(7), { timeout: 5000 })
    await delay(300)
    expect(connections).toBe(2)
    expect(deliveries).toHaveLength(7)
    expect(deliveries[6]).toMatchObject({ connection: 2, body: { type: 'node.upgrade_state', ...state } })
    expect(deliveries[6]!.id).not.toBe(deliveries[0]!.id)
    expect(await readdir(path)).not.toContain('node.db')
    expect(await readdir(path)).not.toContain('project-runtime.db')
    expect(daemon.failure()).toBeUndefined()
  },
)

it('syncing 补报持久结果后重发 completed，收到完成回执才落盘并在当前 daemon 开放原队列', async () => {
  const { path, id, wss, start } = await setupDaemon(cleanup)
  const center = await upgradeCenter(cleanup)
  await writePrivateFileAtomic(join(path, 'identity.json'), JSON.stringify({ ...id, coordinator_url: center.url }))
  const target = join(path, 'package')
  await writeUpgradePackage(target)
  const paths = await initializeWorkerDirectory(path, randomUUID())
  for (const file of [join(path, 'node.db'), paths.ledger]) await writePrivateFileAtomic(file, '')
  const config: WorkerOpenConfig = {
    thread_id: basename(paths.threadDirectory),
    node_id: id.node_id,
    storage_generation: randomUUID(),
    agent_type: 'cursor',
    working_directory: path,
    execution_timeout_seconds: 60,
    adapter_config: {},
  }
  const messageId = randomUUID()
  const opened: ThreadReport = {
    type: 'thread.report',
    thread_id: config.thread_id,
    storage_generation: config.storage_generation,
    event_id: randomUUID(),
    worker_seq: 1,
    kind: 'thread.opened',
    native_session_id: 'keep-native',
  }
  const queued: ThreadReport = {
    ...opened,
    event_id: randomUUID(),
    worker_seq: 2,
    kind: 'message.queued',
    client_message_id: messageId,
  }
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const node = yield* makeNodeLedger(join(path, 'node.db'))
        yield* node.saveWorker({
          threadId: config.thread_id,
          config,
          ready: true,
          launch_attempted: true,
          startup_phase: 'open_attempted',
        })
        yield* node.ingest(opened)
        const awaiting = { ...config, thread_id: randomUUID() }
        yield* node.saveWorker({
          threadId: awaiting.thread_id,
          config: awaiting,
          ready: false,
          startup_phase: 'awaiting_open',
        })
        const worker = yield* openWorkerLedger({ dbPath: paths.ledger, dataDirectory: path })
        yield* worker.save({
          ...worker.initial,
          config,
          phase: 'idle',
          opened: true,
          nativeId: 'keep-native',
          messages: {
            [messageId]: {
              state: 'queued',
              digest: 'keep-input',
              input: {
                id: messageId,
                text: '保留的输入',
                epoch: 0,
                operationId: randomUUID(),
                mode: 'queue',
              },
            },
          },
          outbox: [
            { report: opened, acked: false },
            { report: queued, acked: false },
          ],
        })
      }),
    ),
  )
  cleanup.push(() => rm(join(dirname(path), `${basename(path)}.upgrade-backups`), { recursive: true, force: true }))
  const prepared = await prepareUpgrade(path, target)
  await saveUpgradeState(path, { ...prepared, phase: 'ready' })
  const syncing = await migrateUpgrade(path)
  expect(syncing.phase).toBe('syncing')

  const reports: Array<{ socket: WebSocket; id: string; body: ThreadReport }> = []
  const completed: Array<{ socket: WebSocket; id: string; body: NodeUpgradeStateRequest }> = []
  let allowCompletion = false
  wss.on('connection', (socket) => {
    socket.on('message', (bytes) => {
      const frame = JSON.parse(webSocketText(bytes))
      if (frame.kind === 'auth') socket.send(JSON.stringify({ kind: 'auth_result', ok: true }))
      if (frame.kind !== 'envelope') return
      const env = Schema.decodeUnknownSync(Envelope)(frame.envelope)
      const body = Schema.decodeUnknownSync(NodeToControlBody)(env.body)
      if (body.type === 'node.sync') control(socket, { type: 'node.sync_result', ok: true }, env.message_id)
      if (body.type === 'node.runtime_report')
        control(socket, { type: 'node.runtime_report_result', ok: true }, env.message_id)
      if (body.type === 'thread.report') reports.push({ socket, id: env.message_id, body })
      if (body.type === 'node.upgrade_state') {
        if (body.phase === 'completed') completed.push({ socket, id: env.message_id, body })
        if (body.phase !== 'completed' || allowCompletion)
          control(
            socket,
            {
              type: 'node.upgrade_state_result',
              operation_id: body.operation_id,
              phase: body.phase,
              ok: true,
            },
            env.message_id,
          )
      }
    })
  })
  const workersStarted = new Set<string>()
  const host = {
    ensureWorker: vi.fn(async (threadId: string) => {
      expect((await readUpgradeState(path))?.phase).toBe('completed')
      workersStarted.add(threadId)
    }),
    request: async (threadId) => ({
      type: 'result',
      ok: true,
      worker_ready: workersStarted.has(threadId),
      session_id: threadId,
      storage_generation: config.storage_generation,
    }),
  } satisfies DaemonWorkerHost
  const probe = vi.fn(async () => [])
  const daemon = start({ host, probe })
  await vi.waitFor(() => expect(reports.map(({ body }) => body)).toEqual([opened, queued]))
  await delay(150)
  expect(completed).toEqual([])
  expect(await upgradePaused(path)).toBe(true)
  expect(host.ensureWorker).not.toHaveBeenCalled()
  expect(probe).not.toHaveBeenCalled()
  for (const { socket, id, body } of reports)
    control(
      socket,
      {
        type: 'thread.report_result',
        thread_id: body.thread_id,
        event_id: body.event_id,
        worker_seq: body.worker_seq,
        ok: true,
      },
      id,
    )
  await vi.waitFor(() => expect(completed.length).toBeGreaterThanOrEqual(2))
  expect(new Set(completed.map(({ id }) => id)).size).toBe(1)
  expect((await readUpgradeState(path))?.phase).toBe('syncing')
  expect(await upgradePaused(path)).toBe(true)
  expect(host.ensureWorker).not.toHaveBeenCalled()
  expect(probe).not.toHaveBeenCalled()
  const pending = completed.at(-1)!
  allowCompletion = true
  control(
    pending.socket,
    {
      type: 'node.upgrade_state_result',
      operation_id: syncing.operation_id,
      phase: 'completed',
      ok: true,
    },
    pending.id,
  )
  await vi.waitFor(async () => {
    expect((await readUpgradeState(path))?.phase).toBe('completed')
    expect(await upgradePaused(path)).toBe(false)
    expect(host.ensureWorker).toHaveBeenCalledWith(config.thread_id)
    expect(probe).toHaveBeenCalled()
  })
  expect(readLedger(paths.ledger).initial.messages[messageId]?.state).toBe('queued')
  expect(readLedger(paths.ledger).initial.nativeId).toBe('keep-native')
  await expect(requestUpgrade(path, 'upgrade_cancel')).rejects.toMatchObject({ code: 'upgrade_busy' })
  expect(daemon.failure()).toBeUndefined()
  await daemon.stop()
  expect((await readUpgradeState(path))?.phase).toBe('completed')
  expect((await prepareUpgrade(path, target)).operation_id).not.toBe(syncing.operation_id)
})
