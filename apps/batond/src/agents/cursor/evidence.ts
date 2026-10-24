import type { Preparation } from '../../agent-host/protocol.ts'
import type { AgentMessage } from '../../worker/agent.ts'
import { AgentError } from '../../worker/agent.ts'
import type { SnapshotMessage } from './protocol.ts'

export function validatePreparation(message: AgentMessage, preparation: Preparation): void {
  if (
    !preparation.nativeSessionId ||
    Buffer.byteLength(JSON.stringify(preparation)) > 4096 ||
    !Number.isSafeInteger(preparation.confirmedSends) ||
    preparation.confirmedSends < 0
  )
    throw new AgentError('Cursor input preparation is invalid')
}

/**
 * Confirms this input only when the native snapshot has more user messages than
 * the Worker already confirmed and the next user message carries this text.
 */
export function findSent(
  message: AgentMessage,
  preparation: Preparation,
  messages: ReadonlyArray<SnapshotMessage>,
): { nativeSessionId: string; executionId: string } | undefined {
  validatePreparation(message, preparation)
  const users = messages.filter((entry) => entry.role === 'user')
  if (users.length <= preparation.confirmedSends) return undefined
  const candidate = users[preparation.confirmedSends]
  if (!candidate || candidate.text !== message.text) return undefined
  return { nativeSessionId: preparation.nativeSessionId, executionId: candidate.id }
}
