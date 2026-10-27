import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect } from 'effect'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import type { NodeIdentity, WorkerOpenConfig } from '@baton/protocol'
import { reportBatondError, runBatondCLI } from '../cli.ts'
import { updateBrowseRoots } from '../devices/roots.ts'
import { writePrivateFileAtomic } from '../platform/private.ts'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { desktopDirectory, DesktopDirectoryError } from './desktop-directory.ts'
import { initializeWorkerDirectory } from './host.ts'
import { contentHash, makeNodeLedger } from './ledger.ts'

const cleanup: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture(ledger = true) {
  const path = await makePrivateTempDirectory('bd-dir-')
  cleanup.push(path)
  const data = join(path, 'data')
  const root = join(path, 'work')
  const cwd = join(root, 'repo')
  const outside = join(path, 'work-other')
  await mkdir(data, { mode: 0o700 })
  await mkdir(cwd, { recursive: true })
  await mkdir(outside)
  const identity: NodeIdentity = {
    node_id: randomUUID(),
    employee_id: randomUUID(),
    coordinator_url: 'https://offline.invalid',
    display_name: 'Offline node',
    system: 'linux',
    role: '',
    capabilities: [],
    registration_seq: 1,
    registered_at: '2026-01-01T00:00:00Z',
    credential: { id: randomUUID(), token: 'offline-secret', version: 1, expires_at: '2099-01-01T00:00:00Z' },
  }
  await writePrivateFileAtomic(join(data, 'identity.json'), JSON.stringify(identity))
  await updateBrowseRoots(data, { action: 'add', path: root, id: 'work' })
  const config: WorkerOpenConfig = {
    thread_id: randomUUID(),
    node_id: identity.node_id,
    storage_generation: randomUUID(),
    agent_type: 'pi',
    working_directory: cwd,
    execution_timeout_seconds: 7200,
    adapter_config: {},
  }
  const save = async (workingDirectory: string, nodeId = identity.node_id) => {
    const next = { ...config, thread_id: randomUUID(), working_directory: workingDirectory, node_id: nodeId }
    const request = {
      type: 'thread_open' as const,
      ok: false,
      command_id: randomUUID(),
      thread_id: next.thread_id,
      storage_generation: next.storage_generation,
      open_config: next,
    }
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const node = yield* makeNodeLedger(join(data, 'node.db'))
          yield* node.prepare({ id: request.command_id, hash: contentHash(request), request })
        }),
      ),
    )
    return ['--thread-id', next.thread_id, '--data-dir', data]
  }
  if (ledger) await Effect.runPromise(Effect.scoped(makeNodeLedger(join(data, 'node.db'))))
  return { path, data, root, cwd, outside, identity, config, save }
}

it('prints only public identity and the canonical authorized directory without starting processes or changing the ledger', async () => {
  const f = await fixture()
  const link = join(f.root, 'link')
  await symlink(f.cwd, link, 'junction')
  const args = await f.save(link)
  const before = await readFile(join(f.data, 'node.db'))
  // SQLite 的只读 WAL 连接可创建 -wal/-shm，业务文件与数据库内容保持不变。
  const files = (await readdir(f.data)).filter((name) => !['node.db-wal', 'node.db-shm'].includes(name))
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  await runBatondCLI(['desktop-directory', ...args])
  expect(output).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({
      node_id: f.identity.node_id,
      employee_id: f.identity.employee_id,
      coordinator_url: f.identity.coordinator_url,
      working_directory: await realpath(f.cwd),
    }),
  )
  expect(await readFile(join(f.data, 'node.db'))).toEqual(before)
  expect((await readdir(f.data)).filter((name) => !['node.db-wal', 'node.db-shm'].includes(name))).toEqual(files)
  expect(JSON.stringify(output.mock.calls)).not.toContain(f.identity.credential.token)
})

it('rejects unknown and local-only Threads even when a local open file names an authorized directory', async () => {
  const f = await fixture()
  const thread = randomUUID()
  const paths = await initializeWorkerDirectory(f.data, thread)
  await writePrivateFileAtomic(
    join(paths.threadDirectory, 'local-open.json'),
    JSON.stringify({ open_config: { ...f.config, thread_id: thread } }),
  )
  for (const id of [thread, randomUUID()])
    await expect(desktopDirectory(['--thread-id', id, '--data-dir', f.data])).rejects.toMatchObject({
      code: 'thread_unknown',
    })
  const foreign = await f.save(f.cwd, randomUUID())
  await expect(desktopDirectory(foreign)).rejects.toMatchObject({ code: 'thread_unknown' })
})

it('does not create a missing ledger or missing data directory', async () => {
  const f = await fixture(false)
  const files = await readdir(f.data)
  await expect(desktopDirectory(['--thread-id', randomUUID(), '--data-dir', f.data])).rejects.toMatchObject({
    code: 'ledger_unavailable',
  })
  expect(await readdir(f.data)).toEqual(files)
  const missing = join(f.path, 'missing')
  await expect(desktopDirectory(['--thread-id', randomUUID(), '--data-dir', missing])).rejects.toMatchObject({
    code: 'invalid_arguments',
  })
  await expect(readdir(missing)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects invalid UUIDs and caller-supplied directories with safe structured errors', async () => {
  const f = await fixture()
  const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const previous = process.exitCode
  try {
    for (const args of [
      ['--thread-id', '../offline-secret', '--data-dir', f.data],
      ['--thread-id', randomUUID()],
      ['--data-dir', f.data],
      ['--thread-id', randomUUID(), '--data-dir', f.data, '--cwd', 'offline-secret'],
      ['--thread-id', randomUUID(), '--data-dir', f.data, '--working-directory', 'offline-secret'],
    ]) {
      const error = await runBatondCLI(['desktop-directory', ...args]).catch((error: unknown) => error)
      reportBatondError(error, 'desktop-directory')
      const result = JSON.parse(String(output.mock.calls.at(-1)?.[0]))
      expect(result).toMatchObject({ ok: false, code: 'invalid_arguments', message: expect.any(String) })
      expect(result.message).not.toContain('offline-secret')
      expect(process.exitCode).toBe(1)
    }
  } finally {
    process.exitCode = previous
  }
})

it('reports deleted directories as directory_missing and denies files and paths outside current roots', async () => {
  const f = await fixture()
  const missing = await f.save(join(f.cwd, 'missing'))
  await expect(desktopDirectory(missing)).rejects.toMatchObject({ code: 'directory_missing' })
  const file = join(f.cwd, 'file')
  await writeFile(file, '')
  await expect(desktopDirectory(await f.save(file))).rejects.toMatchObject({ code: 'path_denied' })
  await expect(desktopDirectory(await f.save(f.outside))).rejects.toMatchObject({ code: 'path_denied' })
  const args = await f.save(f.cwd)
  await updateBrowseRoots(f.data, { action: 'remove', path: 'work' })
  await expect(desktopDirectory(args)).rejects.toMatchObject({ code: 'path_denied' })
})

it('denies symlink escapes and an authorized root replaced by a symlink', async () => {
  const f = await fixture()
  const link = join(f.root, 'escape')
  await symlink(f.outside, link, 'junction')
  await expect(desktopDirectory(await f.save(link))).rejects.toMatchObject({ code: 'path_denied' })
  const args = await f.save(f.cwd)
  await mkdir(join(f.outside, 'repo'))
  await rename(f.root, join(f.path, 'original-work'))
  await symlink(f.outside, f.root, 'junction')
  await expect(desktopDirectory(args)).rejects.toMatchObject({ code: 'path_denied' })
})

it('sanitizes unreadable identity and corrupt ledger errors', async () => {
  const f = await fixture(false)
  await writeFile(join(f.data, 'node.db'), 'offline-secret-corrupt-ledger')
  const args = ['--thread-id', randomUUID(), '--data-dir', f.data]
  await expect(desktopDirectory(args)).rejects.toMatchObject({
    code: 'ledger_unavailable',
    message: '无法读取已有节点账本',
  })
  await writePrivateFileAtomic(join(f.data, 'identity.json'), 'offline-secret-corrupt-identity')
  await expect(desktopDirectory(args)).rejects.toMatchObject({
    code: 'identity_unavailable',
    message: '无法读取已注册的节点身份',
  })
})

it.each(['directory_missing', 'path_denied', 'thread_unknown'] as const)(
  'preserves %s through reportBatondError',
  (code) => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const previous = process.exitCode
    try {
      reportBatondError(new DesktopDirectoryError(code, '无法查询工作目录'), 'desktop-directory')
      expect(output).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ ok: false, code, message: '无法查询工作目录' }))
      expect(process.exitCode).toBe(1)
    } finally {
      process.exitCode = previous
    }
  },
)
