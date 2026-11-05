import { join, resolve } from 'node:path'
import { Schema } from 'effect'
import { UUID } from '@baton/protocol'

export function executionPaths(dataDirectory: string, executionId: string) {
  Schema.decodeUnknownSync(UUID)(executionId)
  const root = resolve(dataDirectory)
  return { root, directory: join(root, 'executions', executionId) }
}
