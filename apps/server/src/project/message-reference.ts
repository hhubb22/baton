import { Predicate, Schema } from 'effect'
import type * as P from '@baton/protocol'
import { ProjectMessageReference, ProjectQueuedInput } from '@baton/protocol'

const marker = '\n\n<baton-reference version="1">\n'
const closing = '\n</baton-reference>'

// 旧正文仅在尾部包含完整且有效的引用时拆分；其他文字原样保留。
export function normalizeProjectMessage<
  T extends { content: string; reference?: P.ProjectMessageReference | null | undefined },
>(message: T): T {
  if ('reference' in message) return message
  const index = message.content.lastIndexOf(marker)
  if (index < 0 || !message.content.endsWith(closing)) return message
  try {
    const reference = Schema.decodeUnknownSync(ProjectMessageReference, { onExcessProperty: 'error' })(
      JSON.parse(message.content.slice(index + marker.length, -closing.length)),
    )
    return { ...message, content: message.content.slice(0, index), reference }
  } catch {
    return message
  }
}

export function normalizeProjectInput(input: P.ProjectQueuedInput): P.ProjectQueuedInput {
  const payload: unknown = input.payload
  if (input.source_type !== 'user_message' || !Predicate.isObject(payload)) return input
  if (typeof payload.content !== 'string') return input
  const normalized = normalizeProjectMessage({
    content: payload.content,
    ...('reference' in payload ? { reference: payload.reference as P.ProjectMessageReference | null } : {}),
  })
  return { ...input, payload: { ...payload, ...normalized } as Schema.Json }
}

export function normalizeProjectEvent(event: P.ProjectEvent): P.ProjectEvent {
  const payload: unknown = event.payload
  if (event.kind !== 'input' || !Predicate.isObject(payload)) return event
  const message = payload.message
  if (!Predicate.isObject(message) || !Array.isArray(message.content)) return event
  const content = message.content.map((block: unknown) => {
    if (!Predicate.isObject(block) || block.type !== 'text' || typeof block.text !== 'string') return block
    try {
      const inputs = Schema.decodeUnknownSync(Schema.Array(ProjectQueuedInput))(JSON.parse(block.text))
      return { ...block, text: JSON.stringify(inputs.map(normalizeProjectInput)) }
    } catch {
      return block
    }
  })
  return { ...event, payload: { ...payload, message: { ...message, content } } as Schema.Json }
}
