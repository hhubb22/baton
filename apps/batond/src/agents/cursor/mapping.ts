import type { OrchestrationV2ProviderThread } from '@t3tools/contracts'
import type { WorkerOpenConfig } from '@baton/protocol'
import {
  loadMapping as loadAgentMapping,
  mappingFor as agentMappingFor,
  mappingThread,
  persistMapping,
  statePath as agentStatePath,
  NativeMapping,
} from '../../agent-host/mapping.ts'

export { mappingThread, persistMapping, NativeMapping }
export type { NativeMapping as NativeMappingType } from '../../agent-host/mapping.ts'

export function statePath(config: WorkerOpenConfig): string {
  return agentStatePath(config, 'Cursor')
}

export function mappingFor(
  config: WorkerOpenConfig,
  nativeSessionId: string,
  providerThread: OrchestrationV2ProviderThread,
) {
  return agentMappingFor(config, nativeSessionId, providerThread, 'Cursor')
}

export function loadMapping(config: WorkerOpenConfig, nativeSessionId?: string) {
  return loadAgentMapping(config, nativeSessionId, 'Cursor')
}
