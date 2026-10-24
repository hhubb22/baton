import type { Preparation } from '../../agent-host/protocol.ts'
import type { WorkerOpenConfig } from '@baton/protocol'
import type { AgentMessage } from '../../worker/agent.ts'
import { AgentError } from '../../worker/agent.ts'
import { preparationId } from '../../agent-host/preparation.ts'
import type { NativeMapping, NativeMessage } from './protocol.ts'

export function validatePreparation(
  config: WorkerOpenConfig,
  message: AgentMessage,
  mapping: NativeMapping,
  preparation: Preparation,
): void {
  if (
    preparation.nativeSessionId !== mapping.nativeSessionId ||
    preparation.preparationId !== preparationId(config, mapping.nativeSessionId, message) ||
    !Number.isSafeInteger(preparation.confirmedSends) ||
    preparation.confirmedSends < 0 ||
    Buffer.byteLength(JSON.stringify(preparation)) > 4096
  ) {
    throw new AgentError('Cursor input preparation does not match this input and native mapping')
  }
}

/**
 * Only the next user record after the already confirmed ones can prove this
 * input reached the native session.
 */
export function findSent(
  config: WorkerOpenConfig,
  message: AgentMessage,
  mapping: NativeMapping,
  preparation: Preparation,
  history: ReadonlyArray<NativeMessage>,
): { nativeSessionId: string; executionId: string } | undefined {
  validatePreparation(config, message, mapping, preparation)
  const users = history.filter((entry) => entry.role === 'user')
  if (users.length <= preparation.confirmedSends) return undefined
  const candidate = users[preparation.confirmedSends]
  if (!candidate || candidate.text !== message.text) return undefined
  return { nativeSessionId: mapping.nativeSessionId, executionId: candidate.id }
}
