import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, open, opendir, realpath, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { FileRequest, type FileResult } from '@baton/protocol'
import { Schema } from 'effect'
import { loadBrowseRoots, type BrowseRoot } from './roots.ts'
import { hasCode } from '../platform/errors.ts'
import { containsControl, DeviceError } from './errors.ts'
import { readBrowseRootsPage } from './roots-page.ts'

export const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}
export function relativePath(path: string, platform: NodeJS.Platform = process.platform): string {
  if (
    Buffer.byteLength(path) > 4096 ||
    path.startsWith('/') ||
    (platform === 'win32' && /[\\:]/.test(path)) ||
    containsControl(path) ||
    path.split('/').includes('..')
  )
    throw new DeviceError('invalid_path', '路径不正确')
  return path === '.' ? '' : path.replace(/^\.\//, '').replace(/\/$/, '')
}
const same = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino
const escaped = () => new DeviceError('path_escaped', '路径超出允许的目录')

/** 文件内容只从已校验的句柄读取，返回前复核根、路径与句柄身份。 */
export async function openAuthorized(
  root: BrowseRoot,
  path: string,
): Promise<{
  handle: FileHandle
  actual: string
  info: Stats
  verify: () => Promise<void>
}> {
  const configured = resolve(root.path)
  if ((await realpath(configured)) !== configured) throw escaped()
  const rootBefore = await lstat(configured)
  if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) throw escaped()
  const requested = resolve(configured, path)
  if (!inside(configured, requested)) throw escaped()
  const actual = await realpath(requested)
  if (!inside(configured, actual)) throw escaped()
  const before = await lstat(actual)
  const ancestors: Array<{ path: string; info: Stats }> = []
  let parent = before.isDirectory() ? actual : dirname(actual)
  while (inside(configured, parent)) {
    const info = await lstat(parent)
    if (!info.isDirectory() || info.isSymbolicLink()) throw escaped()
    ancestors.push({ path: parent, info })
    if (parent === configured) break
    parent = dirname(parent)
  }
  if (!before.isFile() && !before.isDirectory()) throw new DeviceError('unsupported_type', '只能浏览目录和普通文件')
  const handle = await open(
    actual,
    constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK),
  )
  const verify = async () => {
    const info = await handle.stat()
    if (
      !same(before, info) ||
      !same(rootBefore, await lstat(configured)) ||
      (await realpath(configured)) !== configured ||
      (await realpath(requested)) !== actual ||
      !same(info, await lstat(actual))
    )
      throw escaped()
    let changed = false
    for (const ancestor of ancestors) {
      const current = await lstat(ancestor.path)
      if (!same(ancestor.info, current) || current.isSymbolicLink()) throw escaped()
      if (current.ctimeMs !== ancestor.info.ctimeMs) changed = true
    }
    if (process.platform === 'linux') {
      const openedPath = await realpath(`/proc/self/fd/${handle.fd}`)
      if (!inside(configured, openedPath)) throw escaped()
    }
    if (changed) throw new DeviceError('path_changed', '目录正在变化，请重试')
  }
  try {
    await verify()
    return { handle, actual, info: await handle.stat(), verify }
  } catch (error) {
    await handle.close()
    throw error
  }
}

export async function withAuthorizedRead<T>(
  root: BrowseRoot,
  path: string,
  read: (file: Awaited<ReturnType<typeof openAuthorized>>) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const file = await openAuthorized(root, path)
      try {
        const result = await read(file)
        await file.verify()
        return result
      } finally {
        await file.handle.close()
      }
    } catch (error) {
      if (!(error instanceof DeviceError) || error.code !== 'path_changed' || attempt >= 2) throw error
    }
  }
}

export async function readBounded(root: BrowseRoot, path: string, maximum: number): Promise<Buffer> {
  return withAuthorizedRead(root, path, async (file) => {
    if (!file.info.isFile() || file.info.size > maximum) throw new DeviceError('unavailable', '文件超出读取限制')
    const bytes = Buffer.alloc(maximum + 1)
    const { bytesRead } = await file.handle.read(bytes, 0, bytes.length, 0)
    if (bytesRead > maximum) throw new DeviceError('unavailable', '文件超出读取限制')
    return bytes.subarray(0, bytesRead)
  })
}

export async function boundedDirectory(
  root: BrowseRoot,
  path: string,
  limit: number,
  signal?: AbortSignal,
): Promise<{ scanned: number; names: string[]; limited: boolean }> {
  return withAuthorizedRead(root, path, async (file) => {
    if (!file.info.isDirectory()) throw new DeviceError('invalid_path', '路径必须是目录')
    const dir = await opendir(process.platform === 'linux' ? `/proc/self/fd/${file.handle.fd}` : file.actual)
    const names: string[] = []
    let limited = false
    let scanned = 0
    try {
      while (scanned < limit) {
        signal?.throwIfAborted()
        const entry = await dir.read()
        if (!entry) break
        scanned++
        if ((process.platform !== 'win32' || !/[\\:]/.test(entry.name)) && !containsControl(entry.name))
          names.push(entry.name)
      }
      limited = scanned === limit
    } finally {
      await dir.close()
    }
    return { names: names.sort(), limited, scanned }
  })
}

const versionOf = (path: string, info: Stats): string =>
  createHash('sha256')
    .update(JSON.stringify([path, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]))
    .digest('hex')

function pageOffset(cursor: string | undefined, version: string): number {
  if (!cursor) return 0
  const match = /^v1:(\d+):([a-f0-9]{64})$/.exec(cursor)
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new DeviceError('invalid_path', '浏览游标无效')
  if (match[2] !== version) throw new DeviceError('directory_changed', '目录已变化，请重新读取')
  return Number(match[1])
}
const pageCursor = (offset: number, version: string): string => `v1:${offset}:${version}`

export async function browseFiles(
  dataDirectory: string,
  input: FileRequest,
  signal?: AbortSignal,
): Promise<FileResult> {
  const base = { type: 'files.browse_result' as const, operation_id: input.operation_id }
  try {
    const req = Schema.decodeUnknownSync(FileRequest)(input)
    signal?.throwIfAborted()
    if (!req.root_id) {
      if (req.path || req.offset != null || req.version)
        throw new DeviceError('invalid_path', '列出授权目录时不能指定路径或文件偏移')
      const page = await readBrowseRootsPage(dataDirectory, req.cursor)
      return {
        ...base,
        ok: true,
        kind: 'roots',
        roots: page.roots.map((root) => ({ id: root.root_id, path: root.path })),
        truncated: Boolean(page.next_cursor),
        ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}),
      }
    }
    const roots = await loadBrowseRoots(dataDirectory)
    const root = roots.find((root) => root.id === req.root_id)
    if (!root) throw new DeviceError('root_forbidden', '未授权的目录')
    const path = relativePath(req.path ?? '')
    return await withAuthorizedRead(root, path, async (file): Promise<FileResult> => {
      const result = { ...base, ok: true, root_id: root.id, path }
      if (file.info.isDirectory()) {
        if (req.offset != null || req.version) throw new DeviceError('invalid_path', '目录不支持文件偏移')
        const version = versionOf(file.actual, file.info)
        const offset = pageOffset(req.cursor, version)
        const dir = await opendir(process.platform === 'linux' ? `/proc/self/fd/${file.handle.fd}` : file.actual)
        const entries: NonNullable<FileResult['entries']>[number][] = []
        let scanned = 0
        let position = 0
        let more = false
        try {
          while (true) {
            signal?.throwIfAborted()
            const entry = await dir.read()
            if (!entry) break
            if (position < offset) {
              position++
              continue
            }
            if (scanned >= 4096 || entries.length >= 200) {
              more = true
              break
            }
            scanned++
            position++
            if ((process.platform === 'win32' && /[\\:]/.test(entry.name)) || containsControl(entry.name)) continue
            const child = await lstat(join(file.actual, entry.name)).catch(() => undefined)
            if (!child) continue
            const kind = child.isSymbolicLink()
              ? 'symlink'
              : child.isDirectory()
                ? 'directory'
                : child.isFile()
                  ? 'file'
                  : 'special'
            entries.push({ name: entry.name, kind, ...(child.isFile() ? { size: child.size } : {}) })
          }
        } finally {
          await dir.close()
        }
        if (versionOf(file.actual, await file.handle.stat()) !== version)
          throw new DeviceError('path_changed', '目录正在变化，请重试')
        return {
          ...result,
          kind: 'directory',
          entries,
          truncated: more,
          ...(more
            ? {
                next_cursor: pageCursor(position, version),
                remainder: {
                  root_id: root.id,
                  path,
                  kind: 'directory',
                  listed: entries.length,
                  scan_limited: scanned >= 4096,
                },
              }
            : {}),
        }
      }
      if (req.cursor) throw new DeviceError('invalid_path', '文件预览不支持目录游标')
      const version = versionOf(file.actual, file.info)
      const offset = req.offset ?? 0
      if (req.version && req.version !== version) throw new DeviceError('file_changed', '文件已变化，请重新读取')
      if ((offset > 0 && !req.version) || offset > file.info.size)
        throw new DeviceError('invalid_path', '文件偏移无效或缺少版本')
      const bytes = Buffer.alloc(64 * 1024 + 1)
      const { bytesRead } = await file.handle.read(bytes, 0, bytes.length, offset)
      if (versionOf(file.actual, await file.handle.stat()) !== version)
        throw new DeviceError('file_changed', '文件已变化，请重新读取')
      signal?.throwIfAborted()
      const content = bytes.subarray(0, bytesRead)
      const hasMore = bytesRead > 64 * 1024 || file.info.size > offset + bytesRead
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content.subarray(0, 64 * 1024), {
          stream: hasMore,
        })
        if (Array.from(text).some((char) => char.charCodeAt(0) < 32 && !['\t', '\n', '\r'].includes(char)))
          throw new Error()
      } catch {
        throw new DeviceError('not_text', '该文件不支持文本预览')
      }
      const next = offset + Buffer.byteLength(text)
      const truncated = next < file.info.size
      return {
        ...result,
        kind: 'file',
        content: text,
        size: file.info.size,
        version,
        offset,
        truncated,
        ...(truncated
          ? {
              next_offset: next,
              remainder: { root_id: root.id, path, kind: 'file', offset: next, size: file.info.size },
            }
          : {}),
      }
    })
  } catch (error) {
    if (error instanceof DeviceError) return { ...base, ok: false, code: error.code, message: error.message }
    if (hasCode(error, 'ENOENT')) return { ...base, ok: false, code: 'not_found', message: '找不到该路径' }
    if (hasCode(error, 'ELOOP')) return { ...base, ok: false, code: 'path_escaped', message: '路径超出允许的目录' }
    return { ...base, ok: false, code: 'unavailable', message: '暂时无法浏览该路径' }
  }
}
