import { resolve, join } from 'node:path'
import { Schema } from 'effect'
import { UUID } from '@baton/protocol'

export function workerPaths(dataDirectory: string, threadId: string) {
  Schema.decodeUnknownSync(UUID)(threadId)
  const root = resolve(dataDirectory)
  return { root, threadDirectory: join(root, 'threads', threadId) }
}
