import { randomUUID } from 'node:crypto'
import { lstat, open, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { parseThreadAttachments } from './attachments.ts'
import { updateBrowseRoots } from './roots.ts'
import { ensurePrivateDirectory } from '../platform/private.ts'
import { makePrivateTempDirectory } from '../testing/private.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, open: vi.fn(fs.open) }
})

const temporary: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.mocked(open).mockReset()
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(open).mockImplementation(fs.open)
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function directory() {
  const path = await realpath(await makePrivateTempDirectory('baton-attachments-'))
  temporary.push(path)
  return path
}
async function setup() {
  const data = await directory()
  const root = await directory()
  await ensurePrivateDirectory(join(root, 'nested'))
  const artifact = join(root, 'nested/artifact.log')
  await writeFile(artifact, 'private artifact content')
  const [registered] = await updateBrowseRoots(data, { action: 'add', path: root })
  if (!registered) throw new Error('Missing registered root')
  const nodeId = randomUUID()
  const parse = () => parseThreadAttachments(data, nodeId, root, '`nested/artifact.log`')
  return {
    root,
    artifact,
    parse,
    attachment: {
      kind: 'file',
      node_id: nodeId,
      root_id: registered.id,
      path: 'nested/artifact.log',
      access_status: 'available',
    },
  }
}

// 在祖先快照建立后、首次句柄校验前操作真实文件，不依赖调度时机。
async function onArtifactOpen(artifact: string, change: () => Promise<void>) {
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await fs.open(...args)
    if (args[0] === artifact) {
      try {
        await change()
      } catch (error) {
        await handle.close()
        throw error
      }
    }
    return handle
  })
}
async function churn(path: string) {
  const before = await lstat(path)
  for (let i = 0; i < 1000; i++) {
    await writeFile(join(path, `unrelated-${randomUUID()}`), '')
    const after = await lstat(path)
    expect(after.ino).toBe(before.ino)
    if (after.ctimeMs !== before.ctimeMs) return
  }
  throw new Error('Directory ctime did not change after file creation')
}

it('keeps the attachment when an unrelated write changes ancestor ctime during authorization', async () => {
  const { root, artifact, parse, attachment } = await setup()
  let changed = false
  await onArtifactOpen(artifact, async () => {
    if (changed) return
    changed = true
    await churn(join(root, 'nested'))
  })
  expect(await parse()).toEqual([attachment])
})

it('omits the attachment when ancestor ctime keeps changing', async () => {
  const { root, artifact, parse } = await setup()
  const diagnostics = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  await onArtifactOpen(artifact, () => churn(join(root, 'nested')))
  expect(await parse()).toEqual([])
  expect(diagnostics.mock.calls).toHaveLength(1)
  expect(JSON.stringify(diagnostics.mock.calls)).toContain('path_changed')
  expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('private artifact content')
})

it('rejects a symlink replacement while retrying a changed directory', async () => {
  const { root, artifact, parse } = await setup()
  const outside = await directory()
  await writeFile(join(outside, 'artifact.log'), 'outside private content')
  let changed = false
  await onArtifactOpen(artifact, async () => {
    if (!changed) {
      changed = true
      await churn(join(root, 'nested'))
      return
    }
    await rename(join(root, 'nested'), join(root, 'moved'))
    await symlink(outside, join(root, 'nested'), process.platform === 'win32' ? 'junction' : 'dir')
  })
  const diagnostics = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  expect(await parse()).toEqual([])
  expect(JSON.stringify(diagnostics.mock.calls)).toContain('path_escaped')
})

it('rejects an outside symlink and an ancestor replaced during authorization', async () => {
  const { root, artifact, parse } = await setup()
  const outside = await directory()
  await writeFile(join(outside, 'artifact.log'), 'outside private content')
  await onArtifactOpen(artifact, async () => {
    await rename(join(root, 'nested'), join(root, 'moved'))
    await symlink(outside, join(root, 'nested'), process.platform === 'win32' ? 'junction' : 'dir')
  })
  const diagnostics = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  expect(await parse()).toEqual([])
  expect(await parse()).toEqual([])
  expect(JSON.stringify(diagnostics.mock.calls)).toContain('path_escaped')
  expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('outside private content')
})
