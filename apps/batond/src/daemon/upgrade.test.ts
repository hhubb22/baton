import { BUILD } from '@baton/protocol/release'
import { writeUpgradePackage, upgradeCenter } from '../testing/upgrade.ts'

vi.mock('node:https', async () => (await import('../testing/upgrade.ts')).upgradeHTTPSFixture())
vi.mock('node:child_process', async () => (await import('../testing/upgrade.ts')).upgradeProcessFixture())
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { Schema } from 'effect'
import { NodeToControlBody, type NodeUpgradeStateRequest, type RuntimeReport } from '@baton/protocol'
import type WebSocket from 'ws'
import { setupDaemon } from '../testing/daemon.ts'
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../platform/private.ts'
import { acquireProcessLock } from '../platform/lock.ts'
import { initializeWorkerDirectory } from './host.ts'
import { requestWorker } from './ipc.ts'
import { readUpgradeState, requestUpgrade, upgradePaths } from './upgrade.ts'
import { runBatondCLI } from '../cli.ts'
import { webSocketText } from './transport.ts'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})

it('authenticates upgrade commands, blocks readiness on living or unconfirmed processes and rejects ready work', async () => {
  const { path, id, wss, start } = await setupDaemon(cleanup)
  const center = await upgradeCenter(cleanup)
  await writePrivateFileAtomic(join(path, 'identity.json'), JSON.stringify({ ...id, coordinator_url: center.url }))
  let socket: WebSocket | undefined
  let syncs = 0
  const replies: unknown[] = []
  const upgrades: NodeUpgradeStateRequest[] = []
  const runtimeReports: RuntimeReport[] = []
  const control = (body: unknown, correlation?: string) =>
    socket!.send(
      JSON.stringify({
        kind: 'envelope',
        envelope: {
          version: 1,
          message_id: randomUUID(),
          route: { to: 'node' },
          priority: 'control',
          source: { kind: 'control' },
          ...(correlation ? { correlation_id: correlation } : {}),
          body,
        },
      }),
    )
  wss.on('connection', (current) => {
    socket = current
    current.on('message', (bytes) => {
      const frame = JSON.parse(webSocketText(bytes))
      if (frame.kind === 'auth') current.send(JSON.stringify({ kind: 'auth_result', ok: true }))
      const body = frame.envelope?.body
      if (body?.type === 'node.sync') {
        syncs++
        control({ type: 'node.sync_result', ok: true }, frame.envelope.message_id)
      }
      if (body?.type === 'node.upgrade_state') {
        const decoded = Schema.decodeUnknownSync(NodeToControlBody)(body)
        if (decoded.type !== 'node.upgrade_state') throw new Error('Unexpected upgrade report')
        expect(body).toEqual(decoded)
        upgrades.push(decoded)
        control(
          {
            type: 'node.upgrade_state_result',
            operation_id: decoded.operation_id,
            phase: decoded.phase,
            ok: true,
          },
          frame.envelope.message_id,
        )
      }
      if (body?.type === 'node.runtime_report') {
        const decoded = Schema.decodeUnknownSync(NodeToControlBody)(body)
        if (decoded.type !== 'node.runtime_report') throw new Error('Unexpected runtime report')
        expect(decoded.report.upgrade_protocol).toBe(1)
        runtimeReports.push(decoded.report)
        control({ type: 'node.runtime_report_result', ok: true }, frame.envelope.message_id)
      }
      if (body?.type === 'thread.command_result') replies.push(body)
      if (frame.kind === 'error') replies.push(frame)
    })
  })
  const workerId = randomUUID()
  const worker = await initializeWorkerDirectory(path, workerId)
  const release = await acquireProcessLock(worker.lock)
  cleanup.push(release)
  const daemon = start({
    project: {
      runtimeCommand: {
        file: process.execPath,
        args: [fileURLToPath(new URL('../testing/project/runtime.mjs', import.meta.url)), 'idle'],
      },
    },
  })
  await vi.waitFor(
    async () => {
      await requestUpgrade(path, 'upgrade_status')
      expect(daemon.failure()).toBeUndefined()
      expect(syncs).toBeGreaterThan(0)
    },
    { timeout: 5000 },
  )
  await expect(
    requestWorker({ ...upgradePaths(path), token: '0'.repeat(64), request: { type: 'upgrade_status', ok: false } }),
  ).rejects.toMatchObject({ code: 'unauthorized' })
  const target = join(path, 'package')
  const other = join(path, 'other-package')
  for (const directory of [target, other]) {
    await writeUpgradePackage(directory)
  }
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    await runBatondCLI(['upgrade', 'prepare', '--package', target, '--data-dir', path])
  } finally {
    log.mockRestore()
  }
  const prepared = await readUpgradeState(path)
  expect(prepared?.phase).toBe('draining')
  expect(prepared?.source_version).toBe(BUILD.version)
  await vi.waitFor(() =>
    expect(upgrades).toContainEqual({
      type: 'node.upgrade_state',
      operation_id: prepared!.operation_id,
      source_version: BUILD.version,
      target_version: prepared!.target_version,
      phase: 'draining',
    }),
  )
  await expect(requestUpgrade(path, 'upgrade_prepare', target)).resolves.toMatchObject({
    state: { operation_id: prepared!.operation_id },
  })
  await expect(requestUpgrade(path, 'upgrade_prepare', other)).rejects.toMatchObject({ code: 'upgrade_conflict' })
  await expect(requestUpgrade(path, 'upgrade_status')).resolves.toMatchObject({
    blockers: expect.arrayContaining([{ kind: 'thread', id: workerId, reason: 'worker_alive' }]),
  })
  // 模拟已登记、尚无完整回收证据的进程；单独释放 Worker 锁仍不能就绪。
  const edit = (sql: string) => {
    const db = new DatabaseSync(join(path, 'project-runtime.db'))
    try {
      db.exec(sql)
    } finally {
      db.close()
    }
  }
  edit(
    `INSERT INTO project_processes VALUES ('unconfirmed', '${JSON.stringify({ pid: 424242, creationTime: 'unknown', role: 'unconfirmed' })}')`,
  )
  const probes = join(path, 'agent-probes', 'codex')
  await ensurePrivateDirectory(join(path, 'agent-probes'))
  await ensurePrivateDirectory(probes)
  await writePrivateFileAtomic(
    join(probes, 'processes.json'),
    JSON.stringify([{ pid: 434343, creationTime: 'unknown', role: 'probe' }]),
  )
  await release()
  await expect(requestUpgrade(path, 'upgrade_status')).resolves.toMatchObject({
    state: { phase: 'draining' },
    blockers: expect.arrayContaining([
      {
        kind: 'process',
        id: 'unconfirmed',
        pid: 424242,
        creation_time: 'unknown',
        reason: 'runtime_cleanup_unconfirmed',
      },
    ]),
  })
  await requestUpgrade(path, 'upgrade_cancel')
  expect((await readUpgradeState(path))?.phase).toBe('cancelled')
  await vi.waitFor(() =>
    expect(upgrades).toContainEqual(
      expect.objectContaining({ operation_id: prepared!.operation_id, phase: 'cancelled' }),
    ),
  )
  await requestUpgrade(path, 'upgrade_prepare', target)
  const previousSyncs = syncs
  edit("DELETE FROM project_processes WHERE role='unconfirmed'")
  await expect(requestUpgrade(path, 'upgrade_status')).resolves.toMatchObject({
    state: { phase: 'draining' },
    blockers: expect.arrayContaining([expect.objectContaining({ reason: 'probe_cleanup_unconfirmed', pid: 434343 })]),
  })
  await writePrivateFileAtomic(join(probes, 'processes.json'), '[]')
  await vi.waitFor(
    async () => {
      expect((await readUpgradeState(path))?.phase).toBe('ready')
    },
    { timeout: 10000 },
  )
  await vi.waitFor(() => expect(syncs).toBeGreaterThan(previousSyncs))
  const ready = await readUpgradeState(path)
  await vi.waitFor(() => {
    expect(upgrades).toContainEqual(expect.objectContaining({ operation_id: ready!.operation_id, phase: 'ready' }))
    expect(runtimeReports).toContainEqual(expect.objectContaining({ upgrade_protocol: 1, agents: [] }))
  })
  await expect(runBatondCLI(['open', '--cwd', path, '--data-dir', path])).rejects.toMatchObject({
    code: 'node_upgrading',
  })
  const threadId = randomUUID()
  control({
    type: 'thread.command',
    thread_id: threadId,
    action: 'open',
    agent_type: 'cursor',
    working_directory: path,
  })
  await vi.waitFor(() =>
    expect(replies).toContainEqual({
      kind: 'error',
      code: 'node_upgrading',
      message: '设备已准备升级，请稍后重试原命令',
    }),
  )
  await requestUpgrade(path, 'upgrade_cancel')
  expect((await readUpgradeState(path))?.phase).toBe('cancelled')
  await vi.waitFor(() =>
    expect(upgrades).toContainEqual(expect.objectContaining({ operation_id: ready!.operation_id, phase: 'cancelled' })),
  )
  expect(runtimeReports.some((report) => (report.agents?.length ?? 0) > 0)).toBe(true)
  expect(daemon.failure()).toBeUndefined()
}, 15000)
