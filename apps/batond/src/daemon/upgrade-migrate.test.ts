import { randomUUID, createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Effect } from 'effect'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { releaseMetadata } from '@baton/protocol/release'
import type { WorkerOpenConfig, ThreadReport } from '@baton/protocol'
import * as storage from '../storage-format.ts'
import { setupDaemon } from '../testing/daemon.ts'
import { writeUpgradePackage, upgradeCenter } from '../testing/upgrade.ts'
import { writePrivateFileAtomic } from '../platform/private.ts'
import { acquireProcessLock } from '../platform/lock.ts'
import { openWorkerLedger, readLedger } from '../worker/ledger.ts'
import { makeProjectLedger } from '../project/ledger.ts'
import { makeNodeLedger } from './ledger.ts'
import { initializeWorkerDirectory } from './host.ts'
import { checkUpgrade } from './upgrade-check.ts'
import { dataEntries } from './upgrade-backup.ts'
import { migrateUpgrade } from './upgrade-migrate.ts'
import { prepareUpgrade, readUpgradeState, requestUpgrade, saveUpgradeState } from './upgrade.ts'
import { runWorker } from './worker-runner.ts'
import { runDaemon } from './daemon.ts'
import { runBatondCLI } from '../cli.ts'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, statfs: vi.fn(actual.statfs) }
})
vi.mock('node:https', async () => (await import('../testing/upgrade.ts')).upgradeHTTPSFixture())
vi.mock('node:child_process', async () => (await import('../testing/upgrade.ts')).upgradeProcessFixture())

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})
async function fixture() {
  const { path, id } = await setupDaemon(cleanup)
  const center = await upgradeCenter(cleanup)
  await writePrivateFileAtomic(join(path, 'identity.json'), JSON.stringify({ ...id, coordinator_url: center.url }))
  const target = join(path, 'package')
  await writeUpgradePackage(target)
  const thread = await initializeWorkerDirectory(path, randomUUID())
  for (const file of ['node.db', 'project-runtime.db', `threads/${basename(thread.threadDirectory)}/thread.db`])
    await writePrivateFileAtomic(join(path, file), '')
  const config: WorkerOpenConfig = {
    thread_id: basename(thread.threadDirectory),
    node_id: id.node_id,
    storage_generation: randomUUID(),
    agent_type: 'cursor',
    working_directory: path,
    execution_timeout_seconds: 60,
    adapter_config: {},
  }
  const report: ThreadReport = {
    type: 'thread.report',
    thread_id: config.thread_id,
    storage_generation: config.storage_generation,
    event_id: randomUUID(),
    worker_seq: 1,
    kind: 'thread.opened',
    native_session_id: 'native-keep',
  }
  const messageId = randomUUID()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const node = yield* makeNodeLedger(join(path, 'node.db'))
        yield* makeProjectLedger(join(path, 'project-runtime.db'))
        yield* node.saveWorker({
          threadId: config.thread_id,
          config,
          ready: true,
          launch_attempted: true,
          startup_phase: 'open_attempted',
        })
        yield* node.ingest(report)
        const worker = yield* openWorkerLedger({ dbPath: thread.ledger, dataDirectory: path })
        yield* worker.save({
          ...worker.initial,
          config,
          phase: 'idle',
          opened: true,
          nativeId: 'native-keep',
          messages: {
            [messageId]: {
              state: 'queued',
              digest: 'queued-digest',
              input: { id: messageId, text: '保留的排队输入', epoch: 0, operationId: randomUUID(), mode: 'queue' },
            },
          },
          outbox: [{ report, acked: false }],
        })
      }),
    ),
  )
  cleanup.push(() => fs.rm(join(dirname(path), `${basename(path)}.upgrade-backups`), { recursive: true, force: true }))
  return { path, id, center, target, thread, messageId, config, report }
}
function edit(file: string, sql: string) {
  const db = new DatabaseSync(file)
  try {
    db.exec(sql)
  } finally {
    db.close()
  }
}
function migrations(file: string) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return db.prepare('SELECT * FROM storage_migrations').all()
  } finally {
    db.close()
  }
}
// SHM 与空 WAL 是读取辅助文件，有内容的 WAL 纳入不变性检查。
async function snapshot(path: string) {
  const files: Record<string, string> = {}
  for (const entry of await dataEntries(path))
    if (!entry.directory && !entry.path.endsWith('.db-shm') && !(entry.path.endsWith('.db-wal') && entry.bytes === 0))
      files[entry.path] = createHash('sha256')
        .update(await fs.readFile(join(path, entry.path)))
        .digest('hex')
  return files
}

it('checks actual package identity, local formats, center compatibility and backup space without changing data', async () => {
  const f = await fixture()
  const original = releaseMetadata()
  const before = await snapshot(f.path)
  expect(await checkUpgrade(f.path, f.target)).toMatchObject({ ok: true, release: original })
  expect(await snapshot(f.path)).toEqual(before)
  expect(await readUpgradeState(f.path)).toBeUndefined()
  const live = await initializeWorkerDirectory(f.path, randomUUID())
  await writePrivateFileAtomic(live.ledger, '')
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* openWorkerLedger({ dbPath: live.ledger, dataDirectory: f.path })
        yield* Effect.promise(async () => {
          expect((await fs.stat(live.ledger + '-wal')).size).toBeGreaterThan(0)
          const liveBefore = await snapshot(f.path)
          expect(await checkUpgrade(f.path, f.target)).toMatchObject({ ok: true })
          expect(await snapshot(f.path)).toEqual(liveBefore)
        })
      }),
    ),
  )
  await writePrivateFileAtomic(join(f.target, 'version.json'), JSON.stringify({ ...original, commit: 'different' }))
  expect(await checkUpgrade(f.path, f.target)).toMatchObject({ ok: false, code: 'upgrade_package_invalid' })
  await writeUpgradePackage(f.target)
  edit(join(f.path, 'node.db'), 'UPDATE storage_format SET version=2')
  expect(await checkUpgrade(f.path, f.target)).toMatchObject({ ok: false, code: 'storage_version_unsupported' })
  edit(join(f.path, 'node.db'), 'UPDATE storage_format SET version=1')
  const published = { ...original, version: 'v2', commit: 'a'.repeat(40), supported_daemon_versions: ['v2'] }
  await writeUpgradePackage(f.target, published)
  f.center.setRelease({ ...original, version: 'v1', supported_daemon_versions: ['v1'] })
  expect(await checkUpgrade(f.path, f.target)).toMatchObject({ ok: false, code: 'node_version_incompatible' })
  f.center.setRelease({ ...original, version: 'v1', supported_daemon_versions: ['v2'] })
  expect(await checkUpgrade(f.path, f.target)).toMatchObject({ ok: true })
  f.center.setRelease({ ...original, protocol_version: 2 })
  expect(await checkUpgrade(f.path, f.target)).toMatchObject({ ok: false, code: 'node_version_incompatible' })
  f.center.setRelease(original)
  expect(await checkUpgrade(f.path, f.target)).toMatchObject({ ok: true })
  await writeUpgradePackage(f.target)
  f.center.setRelease({ ...original, version: 'v1', supported_daemon_versions: ['v1'] })
  expect(await checkUpgrade(f.path, f.target)).toMatchObject({ ok: true })
  const disk = await fs.statfs(f.path)
  const space = vi.mocked(fs.statfs).mockResolvedValueOnce({
    type: disk.type,
    bsize: disk.bsize,
    frsize: disk.frsize,
    blocks: disk.blocks,
    bfree: disk.bfree,
    bavail: 0,
    files: disk.files,
    ffree: disk.ffree,
  })
  expect(await checkUpgrade(f.path, f.target)).toMatchObject({ ok: false, code: 'upgrade_insufficient_space' })
  space.mockRestore()
  await f.center.close()
  expect(await checkUpgrade(f.path, f.target)).toMatchObject({ ok: false, code: 'upgrade_coordinator_unavailable' })
  await expect(prepareUpgrade(f.path, f.target)).rejects.toMatchObject({ code: 'upgrade_coordinator_unavailable' })
  expect(await readUpgradeState(f.path)).toBeUndefined()
  expect(f.center.requests.every((r) => r.path === '/api/v1/release' && r.method === 'GET' && !r.authenticated)).toBe(
    true,
  )
})

it('backs up once, resumes a failed per-ledger pass and keeps daemon and independent Workers paused', async () => {
  const f = await fixture()
  await expect(migrateUpgrade(f.path)).rejects.toMatchObject({ code: 'upgrade_busy' })
  const prepared = await prepareUpgrade(f.path, f.target)
  await f.center.close()
  expect(await prepareUpgrade(f.path, f.target)).toEqual(prepared)
  await expect(migrateUpgrade(f.path)).rejects.toMatchObject({ code: 'upgrade_busy' })
  await saveUpgradeState(f.path, { ...prepared, phase: 'ready' })
  const release = await acquireProcessLock(join(f.path, 'daemon.lock'))
  try {
    await expect(migrateUpgrade(f.path)).rejects.toMatchObject({ code: 'upgrade_busy' })
  } finally {
    await release()
  }
  const files = [join(f.path, 'node.db'), join(f.path, 'project-runtime.db'), f.thread.ledger]
  const facts = files.map(migrations)
  const initialize = storage.initializeStorage
  let fail = true
  let entered!: () => void
  let proceed!: () => void
  const atThread = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    proceed = resolve
  })
  const stub = vi.spyOn(storage, 'initializeStorage').mockImplementation((sql, kind, baseline) => {
    if (kind !== 'thread') return initialize(sql, kind, baseline)
    if (fail) {
      fail = false
      return Effect.fail(new storage.StorageFormatError('migration_checksum_mismatch', '离线注入一次迁移失败'))
    }
    entered()
    return Effect.promise(() => gate).pipe(Effect.andThen(initialize(sql, kind, baseline)))
  })
  await expect(migrateUpgrade(f.path)).rejects.toMatchObject({ code: 'upgrade_migration_failed' })
  const failed = await readUpgradeState(f.path)
  expect(failed).toMatchObject({
    phase: 'failed',
    error_code: 'upgrade_migration_failed',
    backup_path: expect.any(String),
    backup_checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
  })
  expect(files.map(migrations)).toEqual(facts)
  const output = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    await runBatondCLI(['upgrade', 'status', '--data-dir', f.path])
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({
      state: { phase: 'failed', error_code: 'upgrade_migration_failed' },
    })
  } finally {
    output.mockRestore()
  }
  expect(readLedger(f.thread.ledger).initial.messages[f.messageId]?.state).toBe('queued')
  const migration = migrateUpgrade(f.path)
  try {
    await atThread
    expect((await readUpgradeState(f.path))?.phase).toBe('migrating')
    let executions = 0
    await Effect.runPromise(
      Effect.scoped(
        runWorker({
          dataDirectory: f.path,
          threadId: f.config.thread_id,
          agentFactory: () => {
            executions++
            throw new Error('不应启动 Agent')
          },
        }),
      ),
    )
    await expect(
      Effect.runPromise(
        Effect.scoped(
          runDaemon({
            dataDirectory: f.path,
            identity: f.id,
            probe: async () => {
              executions++
              throw new Error('不应探测')
            },
          }),
        ),
      ),
    ).rejects.toThrow('Process lock is held')
    expect(executions).toBe(0)
  } finally {
    proceed()
  }
  const syncing = await migration
  stub.mockRestore()
  expect(syncing).toMatchObject({
    phase: 'syncing',
    backup_path: failed!.backup_path,
    backup_checksum: failed!.backup_checksum,
  })
  expect(files.map(migrations)).toEqual(facts)
  const state = readLedger(f.thread.ledger).initial
  expect(state.config).toEqual(f.config)
  expect(state.messages[f.messageId]?.state).toBe('queued')
  expect(state.outbox[0]?.report).toEqual(f.report)
  expect(
    readLedger(join(syncing.backup_path!, 'data', 'threads', f.config.thread_id, 'thread.db')).initial.messages[
      f.messageId
    ]?.state,
  ).toBe('queued')
  await saveUpgradeState(f.path, { ...syncing, phase: 'migrating' })
  expect(await migrateUpgrade(f.path)).toMatchObject({
    phase: 'syncing',
    backup_path: syncing.backup_path,
    backup_checksum: syncing.backup_checksum,
  })
  expect(files.map(migrations)).toEqual(facts)
  const controller = new AbortController()
  let starts = 0
  const daemon = Effect.runPromise(
    Effect.scoped(
      runDaemon({
        dataDirectory: f.path,
        identity: f.id,
        transport: async () => {
          throw new Error('离线中心')
        },
        probe: async () => {
          starts++
          throw new Error('不应开始业务')
        },
      }),
    ),
    { signal: controller.signal },
  ).catch((error: unknown) => {
    if (!controller.signal.aborted) throw error
  })
  cleanup.push(async () => {
    controller.abort()
    await daemon
  })
  await vi.waitFor(async () => {
    expect(await requestUpgrade(f.path, 'upgrade_status')).toMatchObject({ state: { phase: 'syncing' } })
  })
  await expect(requestUpgrade(f.path, 'upgrade_cancel')).rejects.toMatchObject({ code: 'upgrade_busy' })
  expect(starts).toBe(0)
}, 15000)
