import { textFromAgentMessage, type AgentMessage } from '@baton/providers/cursor'
import type { NativeMessage } from './protocol.ts'

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined

function projection(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const toJSON: unknown = Reflect.get(value, 'toJSON')
  return typeof toJSON === 'function' ? Reflect.apply(toJSON, value, []) : value
}

function oneof(value: unknown, key: string, container: string): Record<string, unknown> | undefined {
  const object = record(projection(value))
  if (!object) return undefined
  const direct = record(object[key])
  if (direct) return direct
  const union = record(object[container])
  return union?.case === key ? record(union.value) : undefined
}

/** The SDK can return one ConversationTurn protobuf in an outer user message. */
export function nativeMessagesFromSdk(messages: ReadonlyArray<AgentMessage>): NativeMessage[] {
  const output: NativeMessage[] = []
  for (const message of messages) {
    const turn = oneof(message.message, 'agentConversationTurn', 'turn')
    if (!turn) {
      const text = textFromAgentMessage(message)
      if (text.length > 0) output.push({ id: message.uuid, role: message.type, text })
      continue
    }
    const user = record(turn.userMessage)
    if (typeof user?.text === 'string') output.push({ id: `${message.uuid}:user`, role: 'user', text: user.text })
    if (!Array.isArray(turn.steps)) continue
    for (let index = 0; index < turn.steps.length; index++) {
      const assistant = oneof(turn.steps[index], 'assistantMessage', 'message')
      if (typeof assistant?.text === 'string') {
        output.push({ id: `${message.uuid}:assistant:${index}`, role: 'assistant', text: assistant.text })
      }
    }
  }
  return output
}
