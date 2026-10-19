import assert from "node:assert/strict";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { StdioClient } from "../../shared/stdio.js";
import { checkedRPC } from "../src/protocol.js";
import { ProjectRuntime } from "../src/runtime.js";
const client = new StdioClient(process.stdin, process.stdout);
let now = 0;
const rpc = checkedRPC(async (request) => {
  if (request.operation === "poll_wake") {
    now += (request.payload as any).wait_ms;
    return { type: "project_runtime.result", ok: true, data: {} };
  }
  return client.call(request);
});
const models = createModels();
const faux = fauxProvider({ provider: "openai-codex", models: [{ id: "fake-model", contextWindow: 60_000 }] });
models.setProvider(faux.provider);
let summaries = 0;
faux.setResponses(Array.from({ length: 10 }, () => (context: any, options: any) => {
  if (options.toolChoice === "none") {
    summaries++;
    return fauxAssistantMessage("用户目标：保留历史原文；决定：按原序号读取；任务 task-123 待处理。");
  }
  assert.ok(JSON.stringify(context).includes("程序说明"));
  if (context.messages.at(-1)?.role !== "toolResult")
    return fauxAssistantMessage([
      fauxToolCall("history.read", { after_seq: 2, through_seq: 3 }, { id: "read-original" }),
      fauxToolCall("history.search", { query: "原文标记", through_seq: 3 }, { id: "search-original" }),
    ]);
  assert.ok(JSON.stringify(context.messages).includes("原文标记"));
  return fauxAssistantMessage("已通过只读历史工具找回原文。");
}));
try {
  await new ProjectRuntime(rpc, models, { now: () => now, sleep: async (ms) => { now += ms; } }).start();
  assert.ok(summaries > 0);
} finally { process.stdin.destroy(); }
