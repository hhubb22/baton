import * as NodeModule from 'node:module'
import { dirname, join } from 'node:path'
import { isSea } from 'node:sea'
export { inspectCursorSdk } from './sdk-inspection.ts'

// The complete SDK and its chunks live on disk beside the SEA executable.
const requireCursorSdk = NodeModule.createRequire(
  isSea() ? join(dirname(process.execPath), 'package.json') : import.meta.url,
)
export const {
  Agent,
  AuthenticationError,
  ConfigurationError,
  createAgentPlatform,
  Cursor,
  CursorSdkError,
  InMemoryCredentialStore,
} = requireCursorSdk('@cursor/sdk') as typeof import('@cursor/sdk')
export const { SqliteLocalAgentStore } = requireCursorSdk('@cursor/sdk/sqlite') as typeof import('@cursor/sdk/sqlite')
