import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import { toolDefinitions } from './tools.js'

// Provider 只接收字母、数字、下划线和连字符；中心协议与持久历史保留点号名称。
const modelNames = new Map(toolDefinitions.map(({ name }) => [name, name.replaceAll('.', '_')]))
const batonNames = new Map([...modelNames].map(([name, modelName]) => [modelName, name]))
if (batonNames.size !== modelNames.size) throw new Error('model_tool_name_collision')

export function modelContext<T extends { messages: Message[] }>(context: T): T {
  const nameForModel = (name: string) => modelNames.get(name) ?? name
  return {
    ...context,
    messages: context.messages.map((message): Message => {
      if (message.role === 'system')
        return {
          ...message,
          ...(message.toolsAdded
            ? {
                toolsAdded: message.toolsAdded.map((tool) => ({
                  ...tool,
                  name: nameForModel(tool.name),
                })),
              }
            : {}),
          ...(message.toolsRemoved
            ? {
                toolsRemoved: message.toolsRemoved.map((tool) => ({
                  ...tool,
                  name: nameForModel(tool.name),
                })),
              }
            : {}),
        }
      if (message.role === 'assistant')
        return {
          ...message,
          content: message.content.map((block) =>
            block.type === 'toolCall' ? { ...block, name: nameForModel(block.name) } : block,
          ),
        }
      if (message.role === 'toolResult') return { ...message, toolName: nameForModel(message.toolName) }
      return message
    }),
  }
}

export function batonMessage(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    content: message.content.map((block) =>
      block.type === 'toolCall' ? { ...block, name: batonNames.get(block.name) ?? block.name } : block,
    ),
  }
}
