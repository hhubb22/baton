import { test } from "node:test";
import assert from "node:assert/strict";
import { createModels, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { requestContext } from "../src/model-tools.js";
import { toolDefinitions } from "../src/tools.js";
import { Backend, setup, assistant } from "./fixture.js";

test("OpenAI 实际序列化的工具定义和历史调用使用合法名称，正文不改写", async () => {
  const context = {
    messages: [
      { role: "system" as const, content: "memory.search", timestamp: 0, toolsAdded: toolDefinitions },
      fauxAssistantMessage([fauxToolCall("memory.search", { query: "memory.search" }, { id: "call-1" })]),
      { role: "toolResult" as const, toolCallId: "call-1", toolName: "memory.search", content: [{ type: "text" as const, text: "memory.search" }], isError: false, timestamp: 0 },
    ],
  };
  const before = structuredClone(context);
  const models = createModels();
  models.setProvider(openaiProvider());
  const model = models.getModel("openai", "gpt-6.1-sol")!;
  let requests = 0;
  const stream = models.streamSimple(model, requestContext(context), {
    apiKey: "sk-test-placeholder", maxRetries: 0,
    fetch: async (_url, init) => {
      requests++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.tools.length, toolDefinitions.length);
      assert.equal(new Set(body.tools.map((t: any) => t.name)).size, toolDefinitions.length);
      assert.ok(body.tools.every((t: any) => /^[a-zA-Z0-9_-]+$/.test(t.name)));
      const call = body.input.find((item: any) => item.type === "function_call");
      assert.equal(call.name, "memory_search");
      assert.equal(JSON.parse(call.arguments).query, "memory.search");
      assert.ok(JSON.stringify(body.input).includes("memory.search"));
      return new Response('data: {"type":"response.completed","response":{"id":"test-response","status":"completed","output":[]}}\n\n', { headers: { "content-type": "text/event-stream" } });
    },
  });
  for await (const _ of stream) { /* 等待真实 provider 的序列化与响应解析。 */ }
  assert.equal((await stream.result()).stopReason, "stop");
  assert.equal(requests, 1);
  assert.deepEqual(context, before);
});

test("模型返回别名后先保存点号名称，后续请求再编码，工具只执行一次", async () => {
  const b = new Backend();
  const s = setup(b, [
    fauxAssistantMessage([fauxToolCall("tasks_dispatch", {
      target_node_id: "node-b", agent_type: "codex", working_directory: "/repo",
      description: "任务", expected_outputs: "验证结果",
    }, { id: "dispatch-1" })]),
    assistant(),
  ]);
  await s.runtime.start();
  const saved = b.events.find((e) => e.kind === "assistant")!.payload.message;
  assert.equal(saved.content[0].name, "tasks.dispatch");
  const result = b.events.find((e) => e.kind === "tool_result")!.payload.message;
  assert.equal(result.toolName, "tasks.dispatch");
  const history = s.requests[1].context.messages;
  assert.equal(history.find((m: any) => m.role === "assistant").content[0].name, "tasks_dispatch");
  assert.equal(history.find((m: any) => m.role === "toolResult").toolName, "tasks_dispatch");
  assert.equal(b.effects, 1);
});
