import { randomUUID } from 'node:crypto'
import { readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vite-plus/test'
import type { FileRequest, FileResult } from '@baton/protocol'
import { updateBrowseRoots } from './roots.ts'
import { browseFiles, relativePath, withAuthorizedRead } from './files.ts'
import { ensurePrivateDirectory } from '../platform/private.ts'
import { makePrivateTempDirectory } from '../testing/private.ts'

const temporary: string[] = []
async function directory() {
  const path = await realpath(await makePrivateTempDirectory('baton-file-pages-'))
  temporary.push(path)
  return path
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function setup() {
  const data = await directory()
  const root = await directory()
  const [registered] = await updateBrowseRoots(data, { action: 'add', path: root })
  if (!registered) throw new Error('missing root')
  const request = (query: Partial<FileRequest> = {}): FileRequest => ({
    type: 'files.browse',
    operation_id: randomUUID(),
    root_id: registered.id,
    ...query,
  })
  return { data, root, registered, request }
}

it('continues past the scan limit without omitting or duplicating directory entries', async () => {
  const { data, root, request } = await setup()
  for (let batch = 0; batch < 42; batch++) {
    await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(join(root, `entry-${batch * 100 + i}`), '')))
  }
  const names: string[] = []
  let cursor: string | undefined
  do {
    const page = await browseFiles(data, request(cursor ? { cursor } : {}))
    expect(page.ok).toBe(true)
    expect(page.entries?.length).toBeLessThanOrEqual(200)
    names.push(...(page.entries ?? []).map((entry) => entry.name))
    cursor = page.next_cursor
  } while (cursor)
  expect(names).toHaveLength(4200)
  expect(new Set(names).size).toBe(4200)
  const first = await browseFiles(data, request())
  if (!first.next_cursor) throw new Error('missing cursor')
  await writeFile(join(root, 'new-entry'), '')
  expect(await browseFiles(data, request({ cursor: first.next_cursor }))).toMatchObject({
    ok: false,
    code: 'directory_changed',
  })
})

it('reads UTF-8 chunks to completion and rejects stale versions and missing version checks', async () => {
  const { data, root, request } = await setup()
  const content = '\uFEFF' + 'a'.repeat(65532) + '中文'.repeat(18000)
  await writeFile(join(root, 'large.txt'), content)
  const chunks: string[] = []
  let page: FileResult = await browseFiles(data, request({ path: 'large.txt' }))
  const firstVersion = page.version
  if (!firstVersion) throw new Error('missing version')
  for (;;) {
    expect(page.ok).toBe(true)
    expect(Buffer.byteLength(page.content ?? '')).toBeLessThanOrEqual(65536)
    chunks.push(page.content ?? '')
    if (page.next_offset == null) break
    if (!page.version) throw new Error('missing version')
    page = await browseFiles(data, request({ path: 'large.txt', offset: page.next_offset, version: page.version }))
  }
  expect(chunks.join('')).toBe(content)
  expect(await browseFiles(data, request({ path: 'large.txt', offset: 65535 }))).toMatchObject({
    ok: false,
    code: 'invalid_path',
  })
  await writeFile(join(root, 'large.txt'), 'new version')
  expect(await browseFiles(data, request({ path: 'large.txt', offset: 65535, version: firstVersion }))).toMatchObject({
    ok: false,
    code: 'file_changed',
  })
})

// Windows 把冒号解释为 ADS、反斜杠解释为分隔符，不能创建这些 POSIX 文件名。
it.skipIf(process.platform === 'win32')('preserves POSIX colons and backslashes in listings and reads', async () => {
  const { data, root, request } = await setup()
  for (const name of ['time:12.txt', 'literal\\name.txt']) {
    await writeFile(join(root, name), name)
    expect(await browseFiles(data, request({ path: name }))).toMatchObject({ ok: true, content: name })
  }
  const page = await browseFiles(data, request())
  expect(page.entries?.map((entry) => entry.name).sort()).toEqual(['literal\\name.txt', 'time:12.txt'])
})

it('keeps Windows drive, ADS and alternate separator protection', () => {
  for (const path of ['C:/secret', 'log.txt:stream', '..\\secret', '\\\\host\\share', '/absolute', '../secret']) {
    expect(() => relativePath(path, 'win32')).toThrow('路径不正确')
  }
  expect(relativePath('time:12\\name', 'linux')).toBe('time:12\\name')
})

it('discards a read after unrelated directory churn and reopens under full authorization', async () => {
  const { root, registered } = await setup()
  await writeFile(join(root, 'log.txt'), 'verified content')
  let attempts = 0
  const content = await withAuthorizedRead(registered, 'log.txt', async (file) => {
    attempts++
    if (attempts === 1) {
      await writeFile(join(root, 'unrelated'), '')
      return 'discard this read'
    }
    return file.handle.readFile('utf8')
  })
  expect(content).toBe('verified content')
  expect(await readFile(join(root, 'log.txt'), 'utf8')).toBe('verified content')
})

it('bounds repeated ctime churn and refuses ancestor replacement with an outside symlink', async () => {
  const { root, registered } = await setup()
  await writeFile(join(root, 'log.txt'), 'inside')
  let attempts = 0
  await expect(
    withAuthorizedRead(registered, 'log.txt', async () => {
      await writeFile(join(root, `churn-${attempts++}`), '')
      return 'unverified'
    }),
  ).rejects.toMatchObject({ code: 'path_changed' })
  await ensurePrivateDirectory(join(root, 'nested'))
  await writeFile(join(root, 'nested/log.txt'), 'inside')
  const outside = await directory()
  await writeFile(join(outside, 'log.txt'), 'secret')
  // Windows 不允许重命名仍被打开句柄占用的目录（EPERM），无法在读取窗口内替换祖先。
  if (process.platform !== 'win32')
    await expect(
      withAuthorizedRead(registered, 'nested/log.txt', async () => {
        await rename(join(root, 'nested'), join(root, 'moved'))
        await symlink(outside, join(root, 'nested'), 'dir')
        return 'unverified'
      }),
    ).rejects.toMatchObject({ code: 'path_escaped' })
})
