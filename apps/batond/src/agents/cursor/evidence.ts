import { createHash } from 'node:crypto'
import type { AgentMessage, InputPreparation, InputAcceptance } from '../../worker/agent.ts'
import { AgentError } from '../../worker/agent.ts'
import type { NativeMapping, NativeMessage } from './protocol.ts'

export function prefixDigest(messages: ReadonlyArray<NativeMessage>): string {
  return createHash('sha256')
    .update(JSON.stringify(messages.map(({ id, role, text }) => [id, role, text])))
    .digest('hex')
}

export function messageBinding(message: AgentMessage, mapping: NativeMapping): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        mapping.threadId,
        mapping.nativeSessionId,
        mapping.cwd,
        mapping.statePath,
        mapping.storePath,
        message.id,
        message.text,
        message.epoch,
        message.operationId,
        message.mode,
        message.model ?? null,
      ]),
    )
    .digest('hex')
}

export function prepare(
  message: AgentMessage,
  mapping: NativeMapping,
  history: ReadonlyArray<NativeMessage>,
): InputPreparation {
  return {
    nativeSessionId: mapping.nativeSessionId,
    preparationId: messageBinding(message, mapping),
    userCount: history.filter((entry) => entry.role === 'user').length,
    prefixDigest: prefixDigest(history),
    evidence: { prefixLength: history.length },
  }
}

export function validatePreparation(
  message: AgentMessage,
  mapping: NativeMapping,
  preparation: InputPreparation,
): number {
  const evidence = preparation.evidence
  const prefixLength =
    evidence && typeof evidence === 'object' && !Array.isArray(evidence)
      ? (Reflect.get(evidence, 'prefixLength') as unknown)
      : undefined
  if (
    preparation.nativeSessionId !== mapping.nativeSessionId ||
    preparation.preparationId !== messageBinding(message, mapping) ||
    !Number.isSafeInteger(preparation.userCount) ||
    preparation.userCount < 0 ||
    typeof prefixLength !== 'number' ||
    !Number.isSafeInteger(prefixLength) ||
    prefixLength < preparation.userCount ||
    !/^[a-f0-9]{64}$/.test(preparation.prefixDigest) ||
    Buffer.byteLength(JSON.stringify(preparation)) > 4096
  ) {
    throw new AgentError('Cursor input preparation does not match this input and native mapping')
  }
  return prefixLength
}

/** Only the first user record after the unchanged complete prefix can confirm input. */
export function findSent(
  message: AgentMessage,
  mapping: NativeMapping,
  preparation: InputPreparation,
  history: ReadonlyArray<NativeMessage>,
): InputAcceptance | undefined {
  const prefixLength = validatePreparation(message, mapping, preparation)
  const prefix = history.slice(0, prefixLength)
  if (
    prefix.length !== prefixLength ||
    prefixDigest(prefix) !== preparation.prefixDigest ||
    prefix.filter((entry) => entry.role === 'user').length !== preparation.userCount
  )
    return undefined
  const candidate = history.slice(prefixLength).find((entry) => entry.role === 'user')
  if (!candidate || candidate.text !== message.text) return undefined
  return { nativeSessionId: mapping.nativeSessionId, executionId: candidate.id }
}
