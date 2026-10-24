import { Schema } from 'effect'
import type { WorkerOpenConfig } from '@baton/protocol'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'
import { ensurePrivateDirectory, readPrivateFile, writePrivateFileAtomic } from '../../platform/private.ts'
import { AgentError } from '../../worker/agent.ts'
import { NativeMapping, type NativeMapping as Mapping } from './protocol.ts'

export function statePath(config: WorkerOpenConfig): string {
  const path = config.adapter_config.state_path
  if (!path || !isAbsolute(path)) throw new AgentError('Cursor requires an absolute private state_path')
  return resolve(path)
}

export async function mappingFor(config: WorkerOpenConfig, nativeSessionId: string): Promise<Mapping> {
  const path = statePath(config)
  return {
    version: 1,
    threadId: config.thread_id,
    nativeSessionId,
    cwd: await realpath(config.working_directory),
    statePath: path,
    storePath: join(dirname(path), 'cursor-store'),
  }
}

export async function loadMapping(config: WorkerOpenConfig, nativeSessionId?: string): Promise<Mapping> {
  const path = statePath(config)
  const bytes = await readPrivateFile(path)
  if (bytes.byteLength > 16 * 1024) throw new AgentError('Cursor native mapping exceeds size limit')
  const mapping = Schema.decodeUnknownSync(NativeMapping)(JSON.parse(bytes.toString('utf8')))
  const expected = await mappingFor(config, nativeSessionId ?? mapping.nativeSessionId)
  if (JSON.stringify(mapping) !== JSON.stringify(expected))
    throw new AgentError('Cursor native mapping identity or working directory mismatch')
  return mapping
}

export async function persistMapping(mapping: Mapping): Promise<void> {
  await ensurePrivateDirectory(dirname(mapping.statePath))
  await writePrivateFileAtomic(mapping.statePath, JSON.stringify(mapping))
}
