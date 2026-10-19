import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Backend, input } from "./fixture.js";
export function history(b: Backend, rounds = 8, toolBytes = 10000, textBytes = 5000) {
  b.queue = false;
  const add = (kind: any, message: any) => b.events.push({ seq: b.events.length + 1, kind, payload: { format: "pi-ai/1", message } });
  for (let i = 0; i < rounds; i++) {
    add("input", { ...input().payload.message, content: `第 ${i} 轮目标：` + "u".repeat(textBytes) });
    add("assistant", fauxAssistantMessage(fauxToolCall("devices.list", {}, { id: `devices-${i}` })));
    add("tool_result", { role: "toolResult", toolCallId: `devices-${i}`, toolName: "devices.list", content: [{ type: "text", text: `原始工具结果-${i}:` + "x".repeat(toolBytes) }], timestamp: 0, isError: false });
    add("assistant", fauxAssistantMessage("已处理" + "a".repeat(textBytes)));
  }
}
