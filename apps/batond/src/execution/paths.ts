import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { Schema } from 'effect'
import { UUID } from '@baton/protocol'

export function executionPaths(dataDirectory: string, executionId: string) {
  Schema.decodeUnknownSync(UUID)(executionId)
  const root = resolve(dataDirectory)
  const directory = join(root, 'executions', executionId)
  const ipcDirectory = join(root, 'ipc')
  const id = createHash('sha256').update(`${root}\0execution\0${executionId}`).digest('hex').slice(0, 24)
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\baton-${id}` : join(ipcDirectory, `${id}.sock`)
  if (process.platform !== 'win32' && Buffer.byteLength(endpoint) > 103)
    throw new Error('Execution IPC path is too long')
  return {
    root,
    directory,
    ipcDirectory,
    endpoint,
    token: join(directory, 'ipc.token'),
    ledger: join(directory, 'execution.db'),
    lock: join(directory, 'worker.lock'),
    launchLock: join(directory, 'launch.lock'),
  }
}
