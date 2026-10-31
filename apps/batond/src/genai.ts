import type { ThreadTurnItem } from '@baton/protocol'

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const fields = (data: Record<string, unknown>, names: string[]) =>
  Object.fromEntries(names.filter((name) => data[name] !== undefined).map((name) => [name, data[name]]))

const toolTypes = new Set([
  'command_execution',
  'file_change',
  'dynamic_tool',
  'file_search',
  'web_search',
  'subagent',
  'mcp_tool_call',
  'tool_call',
])
const approvalTypes = new Set(['approval_request', 'user_input_request'])

export function itemToolTelemetry(item: ThreadTurnItem) {
  if (!toolTypes.has(item.type) && !approvalTypes.has(item.type)) return undefined
  const data = record(item.data)
  const customName = item.type === 'dynamic_tool' || item.type === 'mcp_tool_call' || item.type === 'tool_call'
  const name =
    customName && typeof data.toolName === 'string' && data.toolName
      ? data.toolName
      : customName && typeof data.name === 'string' && data.name
        ? data.name
        : customName && item.title
          ? item.title
          : item.type
  let arguments_: Record<string, unknown>
  let result: Record<string, unknown>
  switch (item.type) {
    case 'command_execution':
      arguments_ = fields(data, ['input'])
      result = fields(data, ['output', 'exitCode'])
      break
    case 'file_change':
      arguments_ = fields(data, ['fileName', 'oldStr', 'newStr'])
      result = fields(data, ['diffStr', 'changes', 'additions', 'deletions'])
      break
    case 'dynamic_tool':
    case 'mcp_tool_call':
    case 'tool_call':
      arguments_ = fields(data, ['input'])
      result = fields(data, ['output'])
      break
    case 'file_search':
      arguments_ = fields(data, ['pattern'])
      result = fields(data, ['results'])
      break
    case 'web_search':
      arguments_ = fields(data, ['patterns'])
      result = fields(data, ['results'])
      break
    case 'subagent':
      arguments_ = fields(data, ['prompt'])
      result = fields(data, ['progress', 'result'])
      break
    case 'user_input_request':
      arguments_ = fields(data, ['questions'])
      result = fields(data, ['questionAnswer'])
      break
    default:
      arguments_ = fields(data, ['prompt', 'reason', 'options'])
      result = {}
  }
  result.status = item.status
  return {
    name,
    approval: approvalTypes.has(item.type),
    attributes: {
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': name,
      'gen_ai.tool.call.id': item.id,
      'gen_ai.tool.call.arguments': JSON.stringify(arguments_),
      'gen_ai.tool.call.result': JSON.stringify(result),
    },
    parts: [
      { type: 'tool_call', id: item.id, name, arguments: arguments_ },
      { type: 'tool_call_response', id: item.id, response: result },
    ],
  }
}

export function itemOutputParts(item: ThreadTurnItem): Record<string, unknown>[] {
  const data = record(item.data)
  if (item.type === 'reasoning' && typeof data.text === 'string') return [{ type: 'reasoning', content: data.text }]
  if ((item.type === 'assistant_message' || item.type === 'proposed_plan') && typeof data.text === 'string')
    return [{ type: 'text', content: data.text }]
  if (item.type === 'proposed_plan' && typeof data.markdown === 'string')
    return [{ type: 'text', content: data.markdown }]
  if (item.type === 'todo_list')
    return [{ type: 'text', content: JSON.stringify(fields(data, ['steps', 'explanation'])) }]
  return itemToolTelemetry(item)?.parts ?? []
}

export const userInputMessages = (text: string) =>
  JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: text }] }])

export const assistantOutputMessages = (parts: Record<string, unknown>[], finishReason: string) =>
  JSON.stringify([{ role: 'assistant', parts, finish_reason: finishReason }])

export function tokenUsageAttributes(usage: unknown): Record<string, number> {
  const data = record(usage)
  const attributes: Record<string, number> = {}
  const add = (source: string, target: string) => {
    const value = data[source]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) attributes[target] = value
  }
  add('inputTokens', 'gen_ai.usage.input_tokens')
  add('outputTokens', 'gen_ai.usage.output_tokens')
  add('cachedInputTokens', 'baton.usage.cached_input_tokens')
  add('cachedInputTokens', 'gen_ai.usage.cache_read.input_tokens')
  add('cacheCreationTokens', 'gen_ai.usage.cache_creation_input_tokens')
  add('reasoningTokens', 'gen_ai.usage.reasoning.output_tokens')
  return attributes
}
