import { createHash } from 'node:crypto'
import { BrowseRootsCursor, BrowseRootsPage } from '@baton/protocol'
import { Schema } from 'effect'
import { loadBrowseRoots } from '../daemon/roots.ts'
import { DeviceError } from './config.ts'

export async function readBrowseRootsPage(dataDirectory: string, cursor?: string): Promise<BrowseRootsPage> {
  if (cursor !== undefined && !Schema.is(BrowseRootsCursor)(cursor))
    throw new DeviceError('invalid_request', '目录游标无效')
  const registered = await loadBrowseRoots(dataDirectory)
  const version = createHash('sha256').update(JSON.stringify(registered)).digest('hex')
  let offset = 0
  if (cursor) {
    const [expected, position] = cursor.split(':')
    offset = Number(position)
    if (expected !== version) throw new DeviceError('roots_changed', '授权目录已变化，请重新读取')
    if (!Number.isSafeInteger(offset) || offset <= 0 || offset >= registered.length)
      throw new DeviceError('invalid_request', '目录游标无效')
  }
  const roots: Array<{ root_id: string; path: string }> = []
  let page: BrowseRootsPage = { roots }
  for (let index = offset; index < registered.length; index++) {
    const root = registered[index]
    if (!root) break
    roots.push({ root_id: root.id, path: root.path })
    const candidate: BrowseRootsPage = {
      roots,
      ...(index + 1 < registered.length ? { next_cursor: `${version}:${index + 1}` } : {}),
    }
    if (Buffer.byteLength(JSON.stringify(candidate)) > 48 * 1024) {
      roots.pop()
      if (!roots.length) throw new DeviceError('config_unavailable', '授权目录路径超出容量限制')
      break
    }
    page = candidate
  }
  return Schema.decodeUnknownSync(BrowseRootsPage)(page)
}
