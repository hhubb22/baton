import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { Effect, Schema } from 'effect'
import * as Reactivity from 'effect/reactivity/Reactivity'
import * as Sqlite from '@baton/sqlite'
import { WorkerOpenConfig } from '@baton/protocol'
import { authorizeDirectory } from '../devices/roots.ts'
import { hasCode } from '../platform/errors.ts'
import { loadIdentity } from './identity.ts'

export class DesktopDirectoryError extends Error {
  constructor(
    readonly code:
      | 'identity_unavailable'
      | 'ledger_unavailable'
      | 'thread_unknown'
      | 'directory_missing'
      | 'path_denied',
    message: string,
  ) {
    super(message)
  }
}

const readWorker = Effect.fnUntraced(function* (filename: string, threadId: string) {
  const sql = yield* Sqlite.make({ filename, readonly: true, busyTimeoutMs: 100 })
  const rows = yield* sql.unsafe<{ thread_id: string; config_json: string }>(
    'SELECT thread_id,config_json FROM threads WHERE thread_id=?',
    [threadId],
  )
  if (!rows[0]) return undefined
  return {
    threadId: rows[0].thread_id,
    config: yield* Effect.try(() => Schema.decodeUnknownSync(WorkerOpenConfig)(JSON.parse(rows[0].config_json))),
  }
})

/** 仅从节点已保存的中心配置读取目录，不发现或启动 Worker。 */
export async function resolveThreadDirectory(dataDirectory: string, threadId: string) {
  const identity = await loadIdentity(dataDirectory).catch(() => {
    throw new DesktopDirectoryError('identity_unavailable', '无法读取已注册的节点身份')
  })
  if (!identity.coordinator_url) throw new DesktopDirectoryError('identity_unavailable', '节点身份缺少中心地址')

  const saved = await Effect.runPromise(
    Effect.scoped(readWorker(join(dataDirectory, 'node.db'), threadId).pipe(Effect.provide(Reactivity.layer))),
  ).catch(() => {
    throw new DesktopDirectoryError('ledger_unavailable', '无法读取已有节点账本')
  })
  if (
    !saved ||
    saved.threadId !== threadId ||
    saved.config.thread_id !== threadId ||
    saved.config.node_id !== identity.node_id
  )
    throw new DesktopDirectoryError('thread_unknown', '节点账本中没有此 Thread 的中心配置')

  let directory: string
  try {
    if (!isAbsolute(saved.config.working_directory)) throw new Error()
    directory = await realpath(saved.config.working_directory)
    if (!(await stat(directory)).isDirectory()) throw new Error()
  } catch (error) {
    if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR'))
      throw new DesktopDirectoryError('directory_missing', 'Thread 工作目录已不存在')
    throw new DesktopDirectoryError('path_denied', '无法访问 Thread 工作目录')
  }
  try {
    directory = await authorizeDirectory(dataDirectory, directory)
  } catch {
    throw new DesktopDirectoryError('path_denied', 'Thread 工作目录不在当前可访问的授权目录内')
  }
  return {
    node_id: identity.node_id,
    employee_id: identity.employee_id,
    coordinator_url: identity.coordinator_url,
    working_directory: directory,
  }
}
