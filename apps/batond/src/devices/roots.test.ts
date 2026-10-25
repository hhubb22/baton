import { readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { RuntimeReport } from '@baton/protocol'
import { Schema } from 'effect'
import { afterEach, expect, it } from 'vite-plus/test'
import { acquireProcessLock } from '../platform/lock.ts'
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../platform/private.ts'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { makeDeviceService } from './index.ts'
import { authorizeDirectory, initializeBrowseRoots, loadBrowseRoots, updateBrowseRoots } from './roots.ts'

const temporary: string[] = []
async function directory(): Promise<string> {
  const path = await realpath(await makePrivateTempDirectory('baton-roots-'))
  temporary.push(path)
  return path
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

it('preserves empty roots, adds an explicit workspace and rejects symlink escapes', async () => {
  const path = await directory(),
    root = await directory(),
    outside = await directory()
  await writePrivateFileAtomic(join(path, 'browse-roots.json'), '{"roots":[]}')
  expect(await initializeBrowseRoots(path)).toEqual([])
  await expect(authorizeDirectory(path, homedir())).rejects.toThrow('授权目录')
  const roots = await initializeBrowseRoots(path, root)
  expect(roots).toHaveLength(1)
  expect(await initializeBrowseRoots(path, root)).toEqual(roots)
  await ensurePrivateDirectory(join(root, 'child'))
  await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(authorizeDirectory(path, join(root, 'escape'))).rejects.toThrow('授权目录')
  await expect(authorizeDirectory(path, root)).resolves.toBe(await realpath(root))
  const absent = await directory()
  expect(await initializeBrowseRoots(absent)).toEqual([{ id: 'home', path: await realpath(homedir()) }])
  expect(await loadBrowseRoots(absent)).toHaveLength(1)
})

it('serializes canonical-root add/remove and preserves an explicitly empty configuration', async () => {
  const data = await directory(),
    root = await directory(),
    second = await directory()
  const alias = join(await directory(), 'alias')
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await Promise.all([
    updateBrowseRoots(data, { action: 'add', path: root }),
    updateBrowseRoots(data, { action: 'add', path: alias }),
    updateBrowseRoots(data, { action: 'add', path: second }),
  ])
  const roots = await loadBrowseRoots(data)
  expect(roots).toHaveLength(2)
  expect(new Set(roots.map((root) => root.path))).toEqual(new Set([root, second]))
  await Promise.all([
    updateBrowseRoots(data, { action: 'remove', path: alias }),
    updateBrowseRoots(data, { action: 'remove', path: alias }),
  ])
  expect(await loadBrowseRoots(data)).toHaveLength(1)
  await updateBrowseRoots(data, { action: 'remove', path: roots.find((entry) => entry.path === second)!.id })
  expect(await loadBrowseRoots(data)).toEqual([])
  // Windows 的私有文件由父目录 ACL 保护，mode 不表示 DACL。
  if (process.platform !== 'win32') expect((await stat(join(data, 'browse-roots.json'))).mode & 0o777).toBe(0o600)
})

it('registers more than 32 distinct roots and preserves a configured limit during edits and initialization', async () => {
  const data = await directory()
  const workspace = await directory()
  for (let index = 0; index < 34; index++) {
    const path = join(workspace, String(index))
    await ensurePrivateDirectory(path)
    await updateBrowseRoots(data, { action: 'add', path: path })
  }
  const initial = JSON.parse(await readFile(join(data, 'browse-roots.json'), 'utf8'))
  expect(initial.roots).toHaveLength(34)
  expect(initial.maxRoots).toBe(256)
  await writeFile(join(data, 'browse-roots.json'), JSON.stringify({ ...initial, maxRoots: 34 }))
  const extra = join(workspace, 'extra')
  await ensurePrivateDirectory(extra)
  await expect(updateBrowseRoots(data, { action: 'add', path: extra })).rejects.toThrow('最多 34 个')
  await expect(initializeBrowseRoots(data, extra)).rejects.toThrow('最多 34 个')
  await updateBrowseRoots(data, { action: 'remove', path: join(workspace, '0') })
  await initializeBrowseRoots(data, extra)
  expect(JSON.parse(await readFile(join(data, 'browse-roots.json'), 'utf8')).maxRoots).toBe(34)
  const service = await makeDeviceService({ dataDirectory: data })
  try {
    const report = await service.collect()
    expect(report.roots).toHaveLength(34)
    expect(() => Schema.decodeUnknownSync(RuntimeReport)(report)).not.toThrow()
  } finally {
    await service.close()
  }
})

it('serializes initialization with updates through relative and absolute data paths', async () => {
  const data = await directory(),
    root = await directory(),
    second = await directory(),
    third = await directory()
  const relativeData = relative(process.cwd(), data)
  await Promise.all([
    initializeBrowseRoots(data),
    updateBrowseRoots(relativeData, { action: 'add', path: root, id: 'workspace' }),
    initializeBrowseRoots(data, second),
    updateBrowseRoots(data, { action: 'remove', path: 'home' }),
    initializeBrowseRoots(relativeData, third),
  ])
  expect(new Set((await loadBrowseRoots(data)).map((entry) => entry.path))).toEqual(new Set([root, second, third]))
  await Promise.all([
    updateBrowseRoots(data, { action: 'remove', path: root }),
    updateBrowseRoots(relativeData, { action: 'remove', path: second }),
    updateBrowseRoots(data, { action: 'remove', path: third }),
    initializeBrowseRoots(data),
  ])
  expect(await loadBrowseRoots(data)).toEqual([])
})

it('uses the same process lock for initialization and updates and recovers after a rejected write', async () => {
  const data = await directory(),
    root = await directory()
  const release = await acquireProcessLock(join(data, 'browse-roots.lock'))
  try {
    await expect(initializeBrowseRoots(data, root)).rejects.toThrow('lock')
    await expect(updateBrowseRoots(data, { action: 'add', path: root })).rejects.toThrow('lock')
    await expect(readFile(join(data, 'browse-roots.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await release()
  }
  await Promise.all([initializeBrowseRoots(data, root), updateBrowseRoots(data, { action: 'remove', path: 'home' })])
  expect((await loadBrowseRoots(data)).map((entry) => entry.path)).toEqual([root])
})

it('rejects malformed configurations without replacing them from either write entry', async () => {
  const data = await directory(),
    root = await directory()
  const file = join(data, 'browse-roots.json')
  const raw = JSON.stringify({ roots: [{ id: 'invalid id', path: root }] })
  await writePrivateFileAtomic(file, raw)
  await expect(initializeBrowseRoots(data, root)).rejects.toThrow('配置无效')
  await expect(updateBrowseRoots(data, { action: 'add', path: root })).rejects.toThrow('配置无效')
  expect(await readFile(file, 'utf8')).toBe(raw)
})

it('rejects a registered root replaced with a symlink', async () => {
  const data = await directory(),
    root = await directory(),
    outside = await directory()
  await updateBrowseRoots(data, { action: 'add', path: root })
  await rename(root, `${root}-moved`)
  temporary.push(`${root}-moved`)
  await symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(authorizeDirectory(data, root)).rejects.toThrow('授权目录')
  await expect(authorizeDirectory(data, outside)).rejects.toThrow('授权目录')
})
