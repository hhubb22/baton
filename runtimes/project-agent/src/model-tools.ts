import type { AssistantMessage, Context, Message } from "@earendil-works/pi-ai";
import { toolDefinitions } from "./tools.js";

const names = new Map(toolDefinitions.map(({ name }) => [name, name.replaceAll(".", "_")]));
const originalNames = new Map([...names].map(([name, wire]) => [wire, name]));
const wireName = (name: string) => names.get(name) ?? name;

// 模型接口使用兼容的函数名；中心事件、工具参数和正文保持原样。
export function requestContext(context: Context): Context {
  const tool = <T extends { name: string }>(value: T): T => ({ ...value, name: wireName(value.name) });
  return {
    ...context,
    ...(context.tools ? { tools: context.tools.map(tool) } : {}),
    messages: context.messages.map((message): Message => {
      if (message.role === "system") return {
        ...message,
        ...(message.toolsAdded ? { toolsAdded: message.toolsAdded.map(tool) } : {}),
        ...(message.toolsRemoved ? { toolsRemoved: message.toolsRemoved.map(tool) } : {}),
      };
      if (message.role === "assistant") return {
        ...message,
        content: message.content.map((block) => block.type === "toolCall" ? tool(block) : block),
      };
      if (message.role === "toolResult") return { ...message, toolName: wireName(message.toolName) };
      return message;
    }),
  };
}

export function responseMessage(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    content: message.content.map((block) => block.type === "toolCall"
      ? { ...block, name: originalNames.get(block.name) ?? block.name }
      : block),
  };
}
