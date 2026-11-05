import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect } from 'effect'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import type { NodeIdentity, WorkerOpenConfig } from '@baton/protocol'
import { updateBrowseRoots } from '../devices/roots.ts'
import { writePrivateFileAtomic } from '../platform/private.ts'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { resolveThreadDirectory } from './desktop-directory.ts'
import { resolveThreadDirectoryResponse } from './control-daemon.ts'
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
    credential: { id: randomUUID(), token: 'offline-secret', version: 1 },
  }
  await writePrivateFileAtomic(join(data, 'identity.json'), JSON.stringify(identity))
  await updateBrowseRoots(data, { action: 'add', path: root, id: 'work' })
  const config: WorkerOpenConfig = {
    thread_id: randomUUID(),
    node_id: identity.node_id,
    storage_generation: randomUUID(),
    agent_type: 'pi',
    runtime_mode: 'full-access',
    working_directory: cwd,
    execution_timeout_seconds: 7200,
    adapter_config: {},
  }
  const save = async (workingDirectory: string, nodeId = identity.node_id) => {
    const next = { ...config, thread_id: randomUUID(), working_directory: workingDirectory, node_id: nodeId }
    const request = {
      type: 'thread_open' as const,
      ok: true,
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

it('returns only public identity and the canonical authorized directory without starting processes or changing the ledger', async () => {
  const f = await fixture()
  const link = join(f.root, 'link')
  await symlink(f.cwd, link, 'junction')
  const args = await f.save(link)
  const before = await readFile(join(f.data, 'node.db'))
  // SQLite 的只读 WAL 连接可创建 -wal/-shm，业务文件与数据库内容保持不变。
  const files = (await readdir(f.data)).filter((name) => !['node.db-wal', 'node.db-shm'].includes(name))
  const saved = await resolveThreadDirectory(f.data, args[1]!)
  expect(saved).toEqual({
    node_id: f.identity.node_id,
    employee_id: f.identity.employee_id,
    coordinator_url: f.identity.coordinator_url,
    working_directory: await realpath(f.cwd),
  })
  expect(await readFile(join(f.data, 'node.db'))).toEqual(before)
  expect((await readdir(f.data)).filter((name) => !['node.db-wal', 'node.db-shm'].includes(name))).toEqual(files)
  expect(JSON.stringify(saved)).not.toContain(f.identity.credential.token)
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
    await expect(resolveThreadDirectory(f.data, id)).rejects.toMatchObject({
      code: 'thread_unknown',
    })
  const foreign = await f.save(f.cwd, randomUUID())
  await expect(resolveThreadDirectory(f.data, foreign[1]!)).rejects.toMatchObject({ code: 'thread_unknown' })
})

it('does not create a missing ledger or missing data directory', async () => {
  const f = await fixture(false)
  const files = await readdir(f.data)
  await expect(resolveThreadDirectory(f.data, randomUUID())).rejects.toMatchObject({
    code: 'ledger_unavailable',
  })
  expect(await readdir(f.data)).toEqual(files)
  const missing = join(f.path, 'missing')
  await expect(resolveThreadDirectory(missing, randomUUID())).rejects.toMatchObject({
    code: 'identity_unavailable',
  })
  await expect(readdir(missing)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('reports deleted directories as directory_missing and denies files and paths outside current roots', async () => {
  const f = await fixture()
  const missing = await f.save(join(f.cwd, 'missing'))
  await expect(resolveThreadDirectory(f.data, missing[1]!)).rejects.toMatchObject({ code: 'directory_missing' })
  const file = join(f.cwd, 'file')
  await writeFile(file, '')
  await expect(resolveThreadDirectory(f.data, (await f.save(file))[1]!)).rejects.toMatchObject({ code: 'path_denied' })
  await expect(resolveThreadDirectory(f.data, (await f.save(f.outside))[1]!)).rejects.toMatchObject({
    code: 'path_denied',
  })
  const args = await f.save(f.cwd)
  await updateBrowseRoots(f.data, { action: 'remove', path: 'work' })
  await expect(resolveThreadDirectory(f.data, args[1]!)).rejects.toMatchObject({ code: 'path_denied' })
})

it('control-daemon returns the authorized directory and rejects a path outside browse roots', async () => {
  const f = await fixture()
  const inside = await f.save(f.cwd)
  await expect(resolveThreadDirectoryResponse(f.data, inside[1]!)).resolves.toMatchObject({
    ok: true,
    node_id: f.identity.node_id,
    employee_id: f.identity.employee_id,
    coordinator_url: f.identity.coordinator_url,
    directory: await realpath(f.cwd),
  })
  const outside = await f.save(f.outside)
  await expect(resolveThreadDirectoryResponse(f.data, outside[1]!)).resolves.toMatchObject({
    ok: false,
    code: 'path_denied',
  })
})

it('denies symlink escapes and an authorized root replaced by a symlink', async () => {
  const f = await fixture()
  const link = join(f.root, 'escape')
  await symlink(f.outside, link, 'junction')
  await expect(resolveThreadDirectory(f.data, (await f.save(link))[1]!)).rejects.toMatchObject({ code: 'path_denied' })
  const args = await f.save(f.cwd)
  await mkdir(join(f.outside, 'repo'))
  await rename(f.root, join(f.path, 'original-work'))
  await symlink(f.outside, f.root, 'junction')
  await expect(resolveThreadDirectory(f.data, args[1]!)).rejects.toMatchObject({ code: 'path_denied' })
})

it('sanitizes unreadable identity and corrupt ledger errors', async () => {
  const f = await fixture(false)
  await writeFile(join(f.data, 'node.db'), 'offline-secret-corrupt-ledger')
  await expect(resolveThreadDirectory(f.data, randomUUID())).rejects.toMatchObject({
    code: 'ledger_unavailable',
    message: '无法读取已有节点账本',
  })
  await writePrivateFileAtomic(join(f.data, 'identity.json'), 'offline-secret-corrupt-identity')
  await expect(resolveThreadDirectory(f.data, randomUUID())).rejects.toMatchObject({
    code: 'identity_unavailable',
    message: '无法读取已注册的节点身份',
  })
})
