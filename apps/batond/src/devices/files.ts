import { constants, type Stats } from 'node:fs'
import { lstat, open, opendir, realpath, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { FileRequest, type FileResult } from '@baton/protocol'
import { Schema } from 'effect'
import { loadBrowseRoots, type BrowseRoot } from '../daemon/roots.ts'
import { hasCode } from '../platform/errors.ts'
import { containsControl, DeviceError } from './config.ts'

export const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}
export function relativePath(path: string): string {
  if (
    Buffer.byteLength(path) > 4096 ||
    isAbsolute(path) ||
    /[\\:]/.test(path) ||
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
    for (const ancestor of ancestors) {
      const current = await lstat(ancestor.path)
      if (!same(ancestor.info, current) || current.isSymbolicLink() || current.ctimeMs !== ancestor.info.ctimeMs)
        throw escaped()
    }
    if (process.platform === 'linux') {
      const openedPath = await realpath(`/proc/self/fd/${handle.fd}`)
      if (!inside(configured, openedPath)) throw escaped()
    }
  }
  try {
    await verify()
    return { handle, actual, info: await handle.stat(), verify }
  } catch (error) {
    await handle.close()
    throw error
  }
}

export async function readBounded(root: BrowseRoot, path: string, maximum: number): Promise<Buffer> {
  const file = await openAuthorized(root, path)
  try {
    if (!file.info.isFile() || file.info.size > maximum) throw new DeviceError('unavailable', '文件超出读取限制')
    const bytes = Buffer.alloc(maximum + 1)
    const { bytesRead } = await file.handle.read(bytes, 0, bytes.length, 0)
    if (bytesRead > maximum) throw new DeviceError('unavailable', '文件超出读取限制')
    await file.verify()
    return bytes.subarray(0, bytesRead)
  } finally {
    await file.handle.close()
  }
}

export async function boundedDirectory(
  root: BrowseRoot,
  path: string,
  limit: number,
  signal?: AbortSignal,
): Promise<{ scanned: number; names: string[]; limited: boolean }> {
  const file = await openAuthorized(root, path)
  try {
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
        if (!/[\\:]/.test(entry.name) && !containsControl(entry.name)) names.push(entry.name)
      }
      limited = scanned === limit
    } finally {
      await dir.close()
    }
    await file.verify()
    return { names: names.sort(), limited, scanned }
  } finally {
    await file.handle.close()
  }
}

export async function browseFiles(
  dataDirectory: string,
  input: FileRequest,
  signal?: AbortSignal,
): Promise<FileResult> {
  const base = { type: 'files.browse_result' as const, operation_id: input.operation_id }
  try {
    const req = Schema.decodeUnknownSync(FileRequest)(input)
    signal?.throwIfAborted()
    const roots = await loadBrowseRoots(dataDirectory)
    if (!req.root_id) {
      if (req.path || req.cursor) throw new DeviceError('invalid_path', '列出授权目录时不能指定路径')
      return { ...base, ok: true, kind: 'roots', roots }
    }
    const root = roots.find((root) => root.id === req.root_id)
    if (!root) throw new DeviceError('root_forbidden', '未授权的目录')
    const path = relativePath(req.path ?? '')
    if (req.cursor && (Buffer.byteLength(req.cursor) > 4096 || /[/\\]/.test(req.cursor) || containsControl(req.cursor)))
      throw new DeviceError('invalid_path', '目录游标无效')
    const file = await openAuthorized(root, path)
    try {
      const result = { ...base, ok: true, root_id: root.id, path }
      if (file.info.isDirectory()) {
        const listing = await boundedDirectory(root, path, 4096, signal)
        const names = listing.names.filter((name) => !req.cursor || name > req.cursor)
        const entries: NonNullable<FileResult['entries']>[number][] = []
        for (const name of names.slice(0, 200)) {
          signal?.throwIfAborted()
          const child = await lstat(join(file.actual, name)).catch(() => undefined)
          if (!child) continue
          const kind = child.isSymbolicLink()
            ? 'symlink'
            : child.isDirectory()
              ? 'directory'
              : child.isFile()
                ? 'file'
                : 'special'
          entries.push({ name, kind, ...(child.isFile() ? { size: child.size } : {}) })
        }
        await file.verify()
        const truncated = listing.limited || names.length > 200
        return {
          ...result,
          kind: 'directory',
          entries,
          truncated,
          ...(names.length > 200 ? { next_cursor: names[199] } : {}),
          ...(truncated
            ? {
                remainder: {
                  root_id: root.id,
                  path,
                  kind: 'directory',
                  listed: entries.length,
                  scan_limited: listing.limited,
                },
              }
            : {}),
        }
      }
      if (req.cursor) throw new DeviceError('invalid_path', '文件预览不支持目录游标')
      const bytes = Buffer.alloc(64 * 1024 + 1)
      const { bytesRead } = await file.handle.read(bytes, 0, bytes.length, 0)
      await file.verify()
      signal?.throwIfAborted()
      const content = bytes.subarray(0, bytesRead)
      const truncated = bytesRead > 64 * 1024 || file.info.size > bytesRead
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(content.subarray(0, 64 * 1024), { stream: truncated })
        if (Array.from(text).some((char) => char.charCodeAt(0) < 32 && !['\t', '\n', '\r'].includes(char)))
          throw new Error()
      } catch {
        throw new DeviceError('not_text', '该文件不支持文本预览')
      }
      return {
        ...result,
        kind: 'file',
        content: text,
        size: file.info.size,
        truncated,
        ...(truncated
          ? {
              remainder: {
                root_id: root.id,
                path,
                kind: 'file',
                offset: Buffer.byteLength(text),
                size: file.info.size,
              },
            }
          : {}),
      }
    } finally {
      await file.handle.close()
    }
  } catch (error) {
    if (error instanceof DeviceError) return { ...base, ok: false, code: error.code, message: error.message }
    if (hasCode(error, 'ENOENT')) return { ...base, ok: false, code: 'not_found', message: '找不到该路径' }
    if (hasCode(error, 'ELOOP')) return { ...base, ok: false, code: 'path_escaped', message: '路径超出允许的目录' }
    return { ...base, ok: false, code: 'unavailable', message: '暂时无法浏览该路径' }
  }
}
