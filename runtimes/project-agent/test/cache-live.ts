// 显式执行的真实订阅观察；输出只包含模型、请求摘要和 usage。
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { runtimeModels } from "../src/auth.js";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { canonical, type Bootstrap, type Event } from "../src/protocol.js";
import { modelMessages } from "../src/runtime.js";
import { summaryContext } from "../src/compaction.js";

if (process.env.BATON_TEST_PROJECT_CACHE !== "1") throw new Error("需显式设置 BATON_TEST_PROJECT_CACHE=1");
const models = await runtimeModels();
models.setProvider(openaiProvider());
await models.refresh();
const model = models.getModel("openai", "gpt-6.1-sol");
assert.ok(model, "订阅模型 gpt-6.1-sol 不可用");
const boot: Bootstrap = {
  project: { title: "上下文缓存观察", goal: "验证摘要前缀复用", agent: { provider: "openai", model: "gpt-6.1-sol" }, conversation: { id: randomUUID() } },
  prompt_version: "1", after_seq: 0, last_seq: 0,
};
const events: Event[] = [];
for (let round = 0; round < 8; round++) {
  const records = Array.from({ length: 60 }, (_, i) => `记录 ${round}-${i}: 用户要求保留原文，决定按序号读取历史，任务 task-${round}-${i} 待验证，目标设备为测试节点。`).join("\n");
  events.push({ seq: events.length + 1, kind: "input", payload: { format: "pi-ai/1", message: { role: "user", content: records, timestamp: 0 } } });
  if (round < 7) events.push({ seq: events.length + 1, kind: "assistant", payload: { format: "pi-ai/1", message: { role: "assistant", content: [{ type: "text", text: "已记录目标和待处理任务。" }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } } });
}
events.at(-1)!.payload.message.content += "\n本次只回复已收到，不调用工具。";
const normal = { messages: modelMessages(boot, events) };
const options = { sessionId: boot.project.conversation.id, maxTokens: 32000, maxRetries: 0 };
const stream = models.streamSimple(model, normal, options);
for await (const _ of stream) { /* 完整消息由 result 返回。 */ }
const response = await stream.result();
assert.equal(response.stopReason, "stop", "正常观察请求失败");
assert.ok(!response.content.some((c) => c.type === "toolCall"), "观察请求不执行工具");
events.push({ seq: events.length + 1, kind: "assistant", payload: { format: "pi-ai/1", message: response } });
const summary = summaryContext(boot, events, 10);
const prefix = summary.messages.slice(0, -1);
assert.deepEqual(prefix, normal.messages);
const summarized = models.streamSimple(model, summary, { ...options, toolChoice: "none" });
for await (const _ of summarized) { /* 仅保存 usage，不输出摘要正文。 */ }
const result = await summarized.result();
assert.equal(result.stopReason, "stop", "摘要观察请求失败");
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
console.log(JSON.stringify({ model: `${model.provider}/${model.id}`, normalPrefixSHA256: hash(normal.messages), summaryPrefixSHA256: hash(prefix), prefixEqual: true, normalUsage: response.usage, summaryUsage: result.usage }, null, 2));
assert.ok(result.usage.cacheRead > 0, "真实订阅 usage 未显示缓存读取");
