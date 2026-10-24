import { Schema } from 'effect'
import { OrchestrationV2ProviderThread, OrchestrationV2ProviderThreadJson } from '@t3tools/contracts'
import type { WorkerOpenConfig } from '@baton/protocol'
import { dirname, isAbsolute, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { ensurePrivateDirectory, readPrivateFile, writePrivateFileAtomic } from '../platform/private.ts'
import { AgentError } from '../worker/agent.ts'

/** Native session attribution persisted before `open` or `resume` returns. */
export const NativeMapping = Schema.Struct({
  version: Schema.Literal(2),
  threadId: Schema.String,
  nativeSessionId: Schema.String,
  cwd: Schema.String,
  statePath: Schema.String,
  agentType: Schema.String,
  profile: Schema.Record(Schema.String, Schema.String),
  /** Upstream `OrchestrationV2ProviderThread`, kept opaque here and decoded by the driver. */
  providerThread: Schema.Json,
})
export type NativeMapping = typeof NativeMapping.Type

export function statePath(config: WorkerOpenConfig, label = 'Agent'): string {
  const path = config.adapter_config.state_path
  if (!path || !isAbsolute(path)) throw new AgentError(`${label} requires an absolute private state_path`)
  return resolve(path)
}

/** Non-secret profile locations must remain the same across host lifetimes. */
const profileFor = (agentType: string): Record<string, string> => {
  const profile: Record<string, string> = { home: homedir() }
  const names =
    agentType === 'pi'
      ? ['PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR']
      : agentType === 'codex'
        ? ['CODEX_HOME']
        : []
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) profile[name] = value
  }
  return profile
}

/** The mapping file stores Thread attribution next to the native session. */
export async function mappingFor(
  config: WorkerOpenConfig,
  nativeSessionId: string,
  providerThread: OrchestrationV2ProviderThread,
  label = 'Agent',
): Promise<NativeMapping> {
  const path = statePath(config, label)
  return Schema.decodeUnknownSync(NativeMapping)({
    version: 2,
    threadId: config.thread_id,
    nativeSessionId,
    cwd: await realpath(config.working_directory),
    statePath: path,
    agentType: config.agent_type,
    profile: profileFor(config.agent_type),
    providerThread: Schema.encodeSync(OrchestrationV2ProviderThreadJson)(providerThread),
  })
}

export async function loadMapping(
  config: WorkerOpenConfig,
  nativeSessionId?: string,
  label = 'Agent',
): Promise<NativeMapping> {
  const path = statePath(config, label)
  const bytes = await readPrivateFile(path)
  if (bytes.byteLength > 64 * 1024) throw new AgentError(`${label} native mapping exceeds size limit`)
  const mapping = Schema.decodeUnknownSync(NativeMapping)(JSON.parse(bytes.toString('utf8')))
  if (
    mapping.threadId !== config.thread_id ||
    mapping.agentType !== config.agent_type ||
    JSON.stringify(mapping.profile) !== JSON.stringify(profileFor(config.agent_type)) ||
    mapping.statePath !== path ||
    mapping.cwd !== (await realpath(config.working_directory)) ||
    (nativeSessionId !== undefined && mapping.nativeSessionId !== nativeSessionId)
  )
    throw new AgentError(`${label} native mapping identity, working directory or profile mismatch`)
  return mapping
}

export const mappingThread = (mapping: NativeMapping): OrchestrationV2ProviderThread =>
  Schema.decodeUnknownSync(OrchestrationV2ProviderThreadJson)(mapping.providerThread)

export async function persistMapping(mapping: NativeMapping): Promise<void> {
  await ensurePrivateDirectory(dirname(mapping.statePath))
  await writePrivateFileAtomic(mapping.statePath, JSON.stringify(mapping))
}
