import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { Schema } from 'effect'
import { UUID } from '@baton/protocol'

export function workerPaths(dataDirectory: string, threadId: string) {
  Schema.decodeUnknownSync(UUID)(threadId)
  const root = resolve(dataDirectory)
  const threadDirectory = join(root, 'threads', threadId)
  const ipcDirectory = join(root, 'ipc')
  const id = createHash('sha256').update(`${root}\0${threadId}`).digest('hex').slice(0, 24)
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\baton-${id}` : join(ipcDirectory, `${id}.sock`)
  if (process.platform !== 'win32' && Buffer.byteLength(endpoint) > 103) {
    throw new Error('Worker IPC path is too long; use a shorter data directory')
  }
  return {
    root,
    threadDirectory,
    ipcDirectory,
    endpoint,
    token: join(threadDirectory, 'ipc.token'),
    ledger: join(threadDirectory, 'thread.db'),
    lock: join(threadDirectory, 'worker.lock'),
    launchLock: join(threadDirectory, 'launch.lock'),
    log: join(threadDirectory, 'worker.log'),
  }
}
