import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFile, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { releaseMetadata } from '@baton/protocol/release'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { runBatondCLI } from '../cli.ts'
import { acquireProcessLock, processLockIsHeld } from '../platform/lock.ts'
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../platform/private.ts'
import { setupDaemon } from '../testing/daemon.ts'
import { upgradeCenter, writeUpgradePackage } from '../testing/upgrade.ts'
import { initializeWorkerDirectory } from './host.ts'
import { manageUpgrade } from './upgrade-management.ts'
import { migrateUpgrade } from './upgrade-migrate.ts'
import { readUpgradeState, requestUpgrade, upgradePaused } from './upgrade.ts'
import { webSocketText } from './transport.ts'

vi.mock('node:https', async () => (await import('../testing/upgrade.ts')).upgradeHTTPSFixture())
vi.mock('node:child_process', async () => (await import('../testing/upgrade.ts')).upgradeProcessFixture())

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})

async function fixture() {
  const daemon = await setupDaemon(cleanup)
  const center = await upgradeCenter(cleanup)
  await writePrivateFileAtomic(
    join(daemon.path, 'identity.json'),
    JSON.stringify({ ...daemon.id, coordinator_url: center.url }),
  )
  const resources = join(dirname(daemon.path), `${basename(daemon.path)}-resources`)
  cleanup.push(() => rm(resources, { recursive: true, force: true }))
  cleanup.push(() =>
    rm(join(dirname(daemon.path), `${basename(daemon.path)}.upgrade-backups`), { recursive: true, force: true }),
  )
  await ensurePrivateDirectory(resources)
  const target = join(resources, 'batond')
  await writeUpgradePackage(target)
  return { ...daemon, center, target }
}

async function cli(args: string[]) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    await runBatondCLI(args)
    return JSON.parse(String(log.mock.calls.at(-1)?.[0]))
  } finally {
    log.mockRestore()
  }
}

it('版本拒绝后仍能按中心版本离线准备、查询与取消，不要求旧程序协议兼容', async () => {
  const f = await fixture()
  const centerRelease = {
    ...releaseMetadata(),
    version: 'v-next',
    protocol_version: 99,
    supported_daemon_versions: ['v-next'],
  }
  f.center.setRelease(centerRelease)
  f.wss.on('connection', (socket) =>
    socket.on('message', (raw) => {
      if (JSON.parse(webSocketText(raw)).kind === 'auth')
        socket.send(
          JSON.stringify({
            kind: 'auth_result',
            ok: false,
            code: 'node_version_incompatible',
            message: '请更新客户端',
          }),
        )
    }),
  )
  const daemon = f.start()
  await daemon.running
  expect(daemon.failure()).toMatchObject({ code: 'node_version_incompatible' })
  const prepared = await cli(['upgrade', 'prepare', '--version', 'v-next', '--data-dir', f.path])
  expect(prepared.state).toMatchObject({ phase: 'draining', target_version: 'v-next' })
  expect(prepared.state.target_path).toBeUndefined()
  expect(prepared.state.checked_release).toBeUndefined()
  await f.center.close()
  expect(await cli(['upgrade', 'prepare', '--version', 'v-next', '--data-dir', f.path])).toMatchObject({
    state: prepared.state,
  })
  expect(await cli(['upgrade', 'status', '--data-dir', f.path])).toMatchObject({
    state: { phase: 'ready', operation_id: prepared.state.operation_id },
  })
  await expect(migrateUpgrade(f.path)).rejects.toMatchObject({ code: 'upgrade_backup_required' })
  expect(await cli(['upgrade', 'cancel', '--data-dir', f.path])).toMatchObject({ state: { phase: 'cancelled' } })
  expect(await upgradePaused(f.path)).toBe(false)
})

it('运行中的 daemon 通过原认证 IPC 接收版本准备并保留同一操作', async () => {
  const f = await fixture()
  const worker = await initializeWorkerDirectory(f.path, randomUUID())
  const release = await acquireProcessLock(worker.lock)
  cleanup.push(release)
  f.wss.on('connection', (socket) =>
    socket.on('message', (raw) => {
      if (JSON.parse(webSocketText(raw)).kind === 'auth') socket.send(JSON.stringify({ kind: 'auth_result', ok: true }))
    }),
  )
  f.start()
  await vi.waitFor(() => requestUpgrade(f.path, 'upgrade_status'))
  const prepared = await cli(['upgrade', 'prepare', '--version', releaseMetadata().version, '--data-dir', f.path])
  expect(prepared).toMatchObject({
    state: { phase: 'draining' },
    blockers: [{ kind: 'thread', reason: 'worker_alive' }],
  })
  await expect(manageUpgrade(f.path, 'prepare', { package: f.target, self: true })).rejects.toMatchObject({
    code: 'upgrade_busy',
  })
  expect(await cli(['upgrade', 'prepare', '--version', releaseMetadata().version, '--data-dir', f.path])).toMatchObject(
    { state: prepared.state },
  )
  expect(await cli(['upgrade', 'cancel', '--data-dir', f.path])).toMatchObject({ state: { phase: 'cancelled' } })
})

it('新程序 self 准备先暂停，独立 Worker 锁和配置写入者退出后 status 才推进 ready', async () => {
  const f = await fixture()
  const worker = await initializeWorkerDirectory(f.path, randomUUID())
  // 复用持有实际进程锁的独立进程替身，升级管理不向该进程发送退出信号。
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../testing/platform/process.mjs', import.meta.url)), 'lock', worker.lock],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      await exited
    }
  })
  const lines = createInterface({ input: child.stdout })
  try {
    expect((await once(lines, 'line'))[0]).toBe('locked')
  } finally {
    lines.close()
  }
  await f.center.close()
  const prepared = await cli(['upgrade', 'prepare', '--package', f.target, '--self', '--data-dir', f.path])
  expect(prepared.state).toMatchObject({
    phase: 'draining',
    source_version: 'unknown',
    target_path: f.target,
    checked_release: releaseMetadata(),
  })
  expect(await cli(['upgrade', 'status', '--data-dir', f.path])).toMatchObject({
    state: { phase: 'draining' },
    blockers: [{ reason: 'worker_alive' }],
  })
  expect(await processLockIsHeld(worker.lock)).toBe(true)
  expect(child.signalCode).toBeNull()
  await expect(migrateUpgrade(f.path)).rejects.toMatchObject({ code: 'upgrade_busy' })
  const writer = await acquireProcessLock(join(f.path, 'identity.lock'))
  cleanup.push(writer)
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  await exited
  expect(await cli(['upgrade', 'status', '--data-dir', f.path])).toMatchObject({
    state: { phase: 'draining' },
    blockers: [{ id: 'identity', reason: 'writer_alive_or_unconfirmed' }],
  })
  await writer()
  expect(await cli(['upgrade', 'status', '--data-dir', f.path])).toMatchObject({
    state: { phase: 'ready' },
    blockers: [],
  })
  await expect(stat(join(f.path, 'node.db'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(join(f.path, 'project-runtime.db'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('self 在核验不受支持的旧数据前已保存暂停，重启 daemon 不提前写库或启动业务', async () => {
  const f = await fixture()
  const node = join(f.path, 'node.db')
  const db = new DatabaseSync(node)
  db.exec("CREATE TABLE old_payload (value TEXT); INSERT INTO old_payload VALUES ('preserve')")
  db.close()
  const before = await readFile(node)
  await expect(
    cli(['upgrade', 'prepare', '--package', f.target, '--self', '--data-dir', f.path]),
  ).rejects.toMatchObject({ code: 'storage_version_unsupported' })
  expect(await readUpgradeState(f.path)).toMatchObject({ phase: 'draining' })
  expect(await upgradePaused(f.path)).toBe(true)
  let probes = 0
  const daemon = f.start({
    probe: async () => {
      probes++
      throw new Error('不应探测')
    },
  })
  await vi.waitFor(() => requestUpgrade(f.path, 'upgrade_status'))
  expect(await cli(['upgrade', 'status', '--data-dir', f.path])).toMatchObject({
    state: { phase: 'draining' },
    blockers: [{ id: 'node.db', reason: 'inspection_failed' }],
  })
  await daemon.stop()
  expect(daemon.failure()).toBeUndefined()
  expect(probes).toBe(0)
  expect(await readFile(node)).toEqual(before)
  await expect(stat(join(f.path, 'project-runtime.db'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('版本目标在新应用绑定，迁移与重新绑定保留操作、数据和原备份，拒绝不同构建', async () => {
  const f = await fixture()
  const prepared = await cli(['upgrade', 'prepare', '--version', releaseMetadata().version, '--data-dir', f.path])
  await cli(['upgrade', 'status', '--data-dir', f.path])
  const bound = await cli(['upgrade', 'prepare', '--package', f.target, '--self', '--data-dir', f.path])
  expect(bound.state).toMatchObject({
    operation_id: prepared.state.operation_id,
    phase: 'ready',
    target_path: f.target,
  })
  const syncing = await migrateUpgrade(f.path)
  const originalBackup = await readFile(join(syncing.backup_path!, 'backup.json'))
  const moved = join(dirname(f.target), 'moved-batond')
  await writeUpgradePackage(moved)
  expect(await cli(['upgrade', 'prepare', '--package', moved, '--self', '--data-dir', f.path])).toMatchObject({
    state: { ...syncing, target_path: moved },
  })
  expect(await migrateUpgrade(f.path)).toMatchObject({
    operation_id: syncing.operation_id,
    phase: 'syncing',
    backup_path: syncing.backup_path,
    backup_checksum: syncing.backup_checksum,
  })
  expect(await readFile(join(syncing.backup_path!, 'backup.json'))).toEqual(originalBackup)
  await expect(cli(['upgrade', 'cancel', '--data-dir', f.path])).rejects.toMatchObject({ code: 'upgrade_busy' })
  await writeUpgradePackage(moved, { ...releaseMetadata(), commit: 'different-build' })
  await expect(cli(['upgrade', 'prepare', '--package', moved, '--self', '--data-dir', f.path])).rejects.toMatchObject({
    code: 'upgrade_package_invalid',
  })
  await expect(migrateUpgrade(f.path)).rejects.toMatchObject({ code: 'upgrade_package_invalid' })
  expect(await readUpgradeState(f.path)).toMatchObject({
    operation_id: syncing.operation_id,
    phase: 'syncing',
    backup_path: syncing.backup_path,
  })
})

it('版本准备记录中心协议，self 拒绝协议不符且保留原暂停操作', async () => {
  const f = await fixture()
  f.center.setRelease({ ...releaseMetadata(), protocol_version: 99 })
  const prepared = await cli(['upgrade', 'prepare', '--version', releaseMetadata().version, '--data-dir', f.path])
  expect(prepared.state.target_protocol_version).toBe(99)
  await expect(
    cli(['upgrade', 'prepare', '--package', f.target, '--self', '--data-dir', f.path]),
  ).rejects.toMatchObject({ code: 'node_version_incompatible' })
  expect(await readUpgradeState(f.path)).toEqual(prepared.state)
  expect(await upgradePaused(f.path)).toBe(true)
})

it.each([
  ['prepare', '--version', 'v-next', '--package', '/package'],
  ['prepare', '--version', 'v-next', '--self'],
  ['status', '--version', 'v-next'],
  ['migrate', '--self'],
])('拒绝混用升级参数 %j', async (...args) => {
  await expect(runBatondCLI(['upgrade', ...args])).rejects.toThrow('用法：upgrade')
})
