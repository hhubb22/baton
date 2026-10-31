import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import type { Counts } from './usage.js'

type Part = Record<string, unknown>
const text = (content: string): Part => ({ type: 'text', content })

const contentParts = (content: unknown): Part[] => {
  if (typeof content === 'string') return [text(content)]
  if (!Array.isArray(content)) return []
  return content.flatMap((part) => {
    if (!part || typeof part !== 'object') return []
    const value = part as Record<string, unknown>
    if (value.type === 'text' && typeof value.text === 'string') return [text(value.text)]
    if (value.type === 'thinking' && typeof value.thinking === 'string')
      return [{ type: 'reasoning', content: value.thinking }]
    if (value.type === 'toolCall')
      return [{ type: 'tool_call', id: value.id, name: value.name, arguments: value.arguments }]
    return []
  })
}

const message = (role: string, parts: Part[]) => ({ role, parts })

export function modelInputAttributes(messages: Message[]): Record<string, unknown> {
  const instructions = messages
    .filter((entry) => entry.role === 'system')
    .flatMap((entry) => [
      ...contentParts(entry.content).map((part) => part.content),
      ...Object.values(entry.sections ?? {}).filter((section) => typeof section === 'string'),
    ])
    .join('\n')
  const input = messages.flatMap((entry) => {
    if (entry.role === 'system') return []
    if (entry.role === 'toolResult') {
      return [
        message('tool', [
          {
            type: 'tool_call_response',
            id: entry.toolCallId,
            response: entry.content,
          },
        ]),
      ]
    }
    return [message(entry.role, contentParts(entry.content))]
  })
  return {
    ...(instructions ? { 'gen_ai.system_instructions': instructions } : {}),
    'gen_ai.input.messages': JSON.stringify(input),
  }
}

export function modelOutputAttributes(response: AssistantMessage): Record<string, unknown> {
  return {
    'gen_ai.response.model': response.responseModel ?? response.model,
    'gen_ai.response.finish_reasons': [response.stopReason],
    stop_reason: response.stopReason,
    'gen_ai.output.messages': JSON.stringify([
      { ...message('assistant', contentParts(response.content)), finish_reason: response.stopReason },
    ]),
  }
}

export function streamUsageAttributes(usage: Counts): Record<string, unknown> {
  return {
    'baton.usage.reported': true,
    ...(usage.input === undefined ? {} : { 'gen_ai.usage.input_tokens': usage.input }),
    ...(usage.output === undefined ? {} : { 'gen_ai.usage.output_tokens': usage.output }),
    ...(usage.cached === undefined
      ? {}
      : {
          'baton.usage.cached_input_tokens': usage.cached,
          'gen_ai.usage.cache_read.input_tokens': usage.cached,
        }),
    ...(usage.cacheCreation === undefined ? {} : { 'gen_ai.usage.cache_creation_input_tokens': usage.cacheCreation }),
    ...(usage.reasoning === undefined ? {} : { 'gen_ai.usage.reasoning.output_tokens': usage.reasoning }),
  }
}

export const embeddingInputAttributes = (input: string) => ({
  'gen_ai.input.messages': JSON.stringify([message('user', [text(input)])]),
})
