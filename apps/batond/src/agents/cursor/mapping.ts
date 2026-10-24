import { Schema } from 'effect'
import { OrchestrationV2ProviderThread, OrchestrationV2ProviderThreadJson } from '@t3tools/contracts'
import type { WorkerOpenConfig } from '@baton/protocol'
import { dirname, isAbsolute, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'
import { ensurePrivateDirectory, readPrivateFile, writePrivateFileAtomic } from '../../platform/private.ts'
import { AgentError } from '../../worker/agent.ts'
import { NativeMapping, type NativeMapping as Mapping } from './protocol.ts'

export function statePath(config: WorkerOpenConfig): string {
  const path = config.adapter_config.state_path
  if (!path || !isAbsolute(path)) throw new AgentError('Cursor requires an absolute private state_path')
  return resolve(path)
}

/** The mapping file stores Thread attribution next to the native session. */
export async function mappingFor(
  config: WorkerOpenConfig,
  nativeSessionId: string,
  providerThread: OrchestrationV2ProviderThread,
): Promise<Mapping> {
  const path = statePath(config)
  return Schema.decodeUnknownSync(NativeMapping)({
    version: 2,
    threadId: config.thread_id,
    nativeSessionId,
    cwd: await realpath(config.working_directory),
    statePath: path,
    providerThread: Schema.encodeSync(OrchestrationV2ProviderThreadJson)(providerThread),
  })
}

export async function loadMapping(config: WorkerOpenConfig, nativeSessionId?: string): Promise<Mapping> {
  const path = statePath(config)
  const bytes = await readPrivateFile(path)
  if (bytes.byteLength > 64 * 1024) throw new AgentError('Cursor native mapping exceeds size limit')
  const mapping = Schema.decodeUnknownSync(NativeMapping)(JSON.parse(bytes.toString('utf8')))
  if (
    mapping.threadId !== config.thread_id ||
    mapping.statePath !== path ||
    mapping.cwd !== (await realpath(config.working_directory)) ||
    (nativeSessionId !== undefined && mapping.nativeSessionId !== nativeSessionId)
  )
    throw new AgentError('Cursor native mapping identity or working directory mismatch')
  return mapping
}

export const mappingThread = (mapping: Mapping): OrchestrationV2ProviderThread =>
  Schema.decodeUnknownSync(OrchestrationV2ProviderThreadJson)(mapping.providerThread)

export async function persistMapping(mapping: Mapping): Promise<void> {
  await ensurePrivateDirectory(dirname(mapping.statePath))
  await writePrivateFileAtomic(mapping.statePath, JSON.stringify(mapping))
}
