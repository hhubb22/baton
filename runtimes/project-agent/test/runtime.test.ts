import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { frames, writeFrame } from "../../shared/stdio.js";
import { modelMessages, IDLE_MS, RUN_MS, RETRIES } from "../src/runtime.js";
import { canonical } from "../src/protocol.js";
import { Backend, setup, assistant, input } from "./fixture.js";
import { toolDefinitions } from "../src/tools.js";

const execCall = () => fauxToolCall("nodes.exec", {
  node_id: "node-b", command: "echo test", working_directory: "/repo",
}, { id: "exec-1" });

class ExecBackend extends Backend {
  accepted = false;
  waits: any[] = [];
  pendingCount = 2;
  async call(req: any): Promise<any> {
    if (req.operation === "call_tool" && req.tool_name === "nodes.exec" && !this.events.some((event) => event.kind === "tool_result" && event.payload.message.toolCallId === req.tool_call_id)) {
      assert.equal(req.last_seq, this.events.length);
      assert.ok(this.events.some((event) => event.kind === "assistant"));
      this.calls.push(req.operation);
      if (!this.accepted) { this.accepted = true; this.effects++; }
      return { pending: true, task_id: "exec-task-1" };
    }
    if (req.operation === "wait_tool") {
      this.calls.push(req.operation);
      this.waits.push(structuredClone(req));
      assert.equal(req.tool_call_id, "exec-1");
      assert.equal(req.last_seq, this.events.length);
      if (!req.payload?.finish_wait && this.waits.length <= this.pendingCount)
        return { pending: true, task_id: "exec-task-1" };
      const event = {
        seq: this.events.length + 1,
        kind: "tool_result" as const,
        payload: { format: "pi-ai/1", message: {
          role: "toolResult", toolCallId: "exec-1", toolName: "nodes.exec",
          content: [{ type: "text", text: JSON.stringify({ task_id: "exec-task-1", status: req.payload?.finish_wait ? "running" : "completed" }) }],
          isError: false, timestamp: 0,
        } },
      };
      this.events.push(event);
      return structuredClone(event);
    }
    return super.call(req);
  }
}

test("nodes.exec 工具声明等待范围、默认时限和执行权限", () => {
  const definition = toolDefinitions.find((tool) => tool.name === "nodes.exec")!;
  const properties = definition.parameters.properties;
  assert.equal(properties.wait_seconds.minimum, 0);
  assert.equal(properties.wait_seconds.maximum, 600);
  assert.equal(properties.wait_seconds.default, 30);
  assert.equal(properties.timeout_seconds.default, 7200);
  assert.match(definition.description, /开发工作优先派发给执行 Agent/);
  assert.match(definition.description, /不检查命令内容，也不提供沙箱/);
  const messages = modelMessages(new Backend().boot(), []);
  assert.match(String(messages[0].content), /通过 nodes.exec 管理环境/);
});

test("nodes.exec pending 期间轮询，结果保存后继续模型", async () => {
  const backend = new ExecBackend();
  const fixture = setup(backend, [() => fauxAssistantMessage([execCall()]), () => assistant()]);
  await fixture.runtime.start();
  assert.equal(backend.effects, 1);
  assert.equal(backend.waits.length, 3);
  assert.equal(backend.events.filter((event) => event.kind === "tool_result").length, 1);
  assert.equal(fixture.faux.state.callCount, 2);
  assert.equal(backend.now, 500 + IDLE_MS);
  assert.ok(backend.waits.every((request) => request.last_seq === 2 && !request.payload));
});

test("等待时到达运行上限立即保存仍在执行结果，不再调用模型", async () => {
  for (const recovery of [false, true]) {
    const backend = new ExecBackend();
    backend.pendingCount = Infinity;
    if (recovery) {
      backend.queue = false;
      backend.events.push(input(), { seq: 2, kind: "assistant", payload: { format: "pi-ai/1", message: fauxAssistantMessage([execCall(), fauxToolCall("devices.list", {}, { id: "later-tool" })]) } });
      const original = backend.call.bind(backend);
      backend.call = async (request) => {
        const result = await original(request);
        if (request.operation === "call_tool") backend.now = RUN_MS - 100;
        return result;
      };
    }
    const fixture = setup(backend, [() => {
      backend.now = RUN_MS - 100;
      return fauxAssistantMessage([execCall(), fauxToolCall("devices.list", {}, { id: "later-tool" })]);
    }]);
    await fixture.runtime.start();
    assert.equal(backend.now, RUN_MS);
    assert.equal(backend.effects, 1);
    assert.equal(fixture.faux.state.callCount, recovery ? 0 : 1);
    assert.equal(backend.waits.length, 2);
    assert.deepEqual(backend.waits[1].payload, { finish_wait: true });
    assert.equal(backend.events.at(-1)?.kind, "tool_result");
    assert.match(backend.events.at(-1)?.payload.message.content[0].text, /running/);
    assert.equal(backend.calls.at(-1), "finish");
    assert.ok(!backend.calls.includes("tasks.cancel"));
  }
});

test("等待期间实际 Runtime 进程被杀，恢复使用原调用 ID 和任务", async () => {
  const backend = new ExecBackend();
  backend.pendingCount = 1;
  for (const crash of [true, false]) {
    const child = spawn(process.execPath, ["--import", "tsx", "test/worker.ts"], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, BATON_TEST_PROJECT_EXEC: "1" },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exited = once(child, "exit");
    for await (const raw of frames(child.stdout)) {
      const frame = raw as any;
      const data = await backend.call(frame.request);
      await writeFrame(child.stdin, { id: frame.id, result: { type: "project_runtime.result", ok: true, data } });
      if (crash && frame.request.operation === "wait_tool") {
        child.kill("SIGKILL");
        break;
      }
    }
    child.stdin.end();
    const [code] = await exited;
    if (!crash) assert.equal(code, 0, stderr);
  }
  assert.equal(backend.effects, 1);
  assert.equal(backend.calls.filter((operation) => operation === "call_tool").length, 2);
  assert.equal(backend.events.filter((event) => event.kind === "tool_result").length, 1);
  assert.deepEqual(backend.waits.map((request) => request.tool_call_id), ["exec-1", "exec-1"]);
  assert.equal(backend.events.at(-1)?.kind, "assistant");
});

test("faux 恢复结尾表的四种情况和部分工具结果", async () => {
  for (const ending of [
    "assistant",
    "pending",
    "input",
    "tool_result",
    "compaction",
    "partial",
  ]) {
    const b = new Backend();
    b.queue = false;
    if (ending !== "compaction") b.events.push(input());
    if (["assistant", "pending", "tool_result", "partial"].includes(ending))
      b.events.push({
        seq: 2,
        kind: "assistant",
        payload: {
          format: "pi-ai/1",
          message: assistant(ending !== "assistant"),
        },
      });
    if (ending === "tool_result" || ending === "partial") {
      await b.call({
        operation: "call_tool",
        last_seq: 2,
        tool_call_id: "dispatch-1",
        tool_name: "tasks.dispatch",
      });
      if (ending === "partial")
        b.events[1].payload.message.content.push(
          fauxToolCall("devices.list", {}, { id: "devices-2" }),
        );
    }
    if (ending === "compaction") {
      const compact = {
        seq: 1,
        kind: "compaction" as const,
        payload: { through_seq: 0, summary: "摘要", memory_index: "" },
      };
      b.events.push(compact);
      const boot = b.boot.bind(b);
      b.boot = () => ({ ...boot(), compaction: compact });
    }
    const s = setup(b, [() => assistant()]);
    await s.runtime.start();
    assert.equal(
      b.effects,
      ending === "partial"
        ? 2
        : ["pending", "tool_result"].includes(ending)
          ? 1
          : 0,
      ending,
    );
    assert.equal(
      s.faux.state.callCount,
      ["pending", "input", "tool_result", "partial"].includes(ending) ? 1 : 0,
      ending,
    );
    assert.equal(
      new Set(
        b.events
          .filter((e) => e.kind === "tool_result")
          .map((e) => e.payload.message.toolCallId),
      ).size,
      b.effects,
    );
    assert.equal(b.now, IDLE_MS);
  }
});

test("实际子进程在写入和工具事务前后被杀，恢复不重复执行副作用", async () => {
  for (const point of [
    "append-before",
    "append-after",
    "tool-before",
    "tool-after",
    "result-after",
  ]) {
    const b = new Backend();
    let killed = false;
    async function run(crash: boolean) {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "test/worker.ts"],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (value) => {
        stderr += value;
      });
      const exited = once(child, "exit");
      try {
        for await (const raw of frames(child.stdout)) {
          const frame = raw as any,
            op = frame.request.operation;
          const matches =
            (op === "append_event" && point.startsWith("append")) ||
            (op === "call_tool" && !point.startsWith("append"));
          if (crash && matches && !killed && point.endsWith("before")) {
            killed = true;
            child.kill("SIGKILL");
            break;
          }
          const data = await b.call(frame.request);
          if (
            crash &&
            matches &&
            !killed &&
            point.endsWith("after") &&
            point !== "result-after"
          ) {
            killed = true;
            child.kill("SIGKILL");
            break;
          }
          await writeFrame(child.stdin, {
            id: frame.id,
            result: { type: "project_runtime.result", ok: true, data },
          });
          if (crash && matches && !killed && point === "result-after") {
            killed = true;
            child.kill("SIGKILL");
            break;
          }
        }
      } finally {
        child.stdin.end();
      }
      const [code] = await exited;
      if (!crash) assert.equal(code, 0, stderr);
    }
    await run(true);
    assert.equal(killed, true, point);
    await run(false);
    assert.equal(b.effects, 1, point);
    assert.equal(
      b.events.filter((e) => e.kind === "tool_result").length,
      1,
      point,
    );
    assert.equal(b.events.at(-1)?.kind, "assistant");
    assert.deepEqual(
      b.events.map((e) => e.seq),
      b.events.map((_, i) => i + 1),
    );
  }
});

test("写入屏障失败后停止，不调用工具", async () => {
  const b = new Backend();
  b.failAt = "append_event";
  const s = setup(b);
  await assert.rejects(s.runtime.start());
  assert.equal(b.effects, 0);
  assert.equal(b.events.length, 1);
});

test("模型失败按 5、15、45 秒重试，失败输出不保存", async () => {
  const b = new Backend();
  const error = () =>
    fauxAssistantMessage("错误中包含工具", {
      stopReason: "error",
      errorMessage: "temporary",
    });
  const s = setup(b, [error, error, error, error]);
  await s.runtime.start();
  assert.equal(s.faux.state.callCount, 4);
  assert.equal(
    b.now,
    RETRIES.reduce((a, b) => a + b, 0),
  );
  assert.equal(b.calls.at(-1), "report_failure");
  assert.equal(b.events.length, 1);
});

test("超限输出按请求失败处理，工具不执行", async () => {
  const b = new Backend();
  const huge = () => fauxAssistantMessage("x".repeat(170 * 1024));
  const s = setup(b, [huge, huge, huge, huge]);
  await s.runtime.start();
  assert.equal(b.effects, 0);
  assert.equal(b.events.length, 1);
  assert.equal(b.calls.at(-1), "report_failure");
});

test("15 分钟上限处理完当前轮次，不领取下一轮也不取消任务", async () => {
  const b = new Backend();
  const s = setup(b, [
    () => {
      b.now = RUN_MS;
      return assistant(true);
    },
    () => {
      b.now += 1000;
      return assistant();
    },
  ]);
  await s.runtime.start();
  assert.equal(b.effects, 1);
  assert.equal(b.calls.filter((c) => c === "claim_inputs").length, 1);
  assert.equal(b.calls.at(-1), "finish");
  assert.equal(b.events.at(-1)?.kind, "assistant");
  assert.ok(!b.calls.includes("tasks.cancel"));
});

test("分页历史、jsonb 键顺序、进程切换保持实际模型请求一致", async () => {
  const b = new Backend();
  b.queue = false;
  const snapshot = Array.from({ length: 21 }, (_, i) =>
    i % 2 === 0
      ? { ...input(), seq: i + 1 }
      : {
          seq: i + 1,
          kind: "assistant" as const,
          payload: {
            format: "pi-ai/1",
            message: {
              ...fauxAssistantMessage(
                [
                  {
                    type: "thinking",
                    thinking: "分析",
                    thinkingSignature: "signed-provider-data",
                  },
                  { type: "text", text: "历史记录".repeat(10_000) },
                ],
                { timestamp: 100 + i },
              ),
              providerExtension: { signature: "opaque-data" },
            },
          },
        },
  );
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) > 1024 * 1024);
  b.events = structuredClone(snapshot);
  const first = setup(b, [() => assistant()]);
  await first.runtime.start();
  // 每次请求读取同一中心快照；反转对象键模拟 jsonb 和另一设备的读取顺序。
  const reverse = (x: any): any =>
    Array.isArray(x)
      ? x.map(reverse)
      : x && typeof x === "object"
        ? Object.fromEntries(
            Object.entries(x)
              .reverse()
              .map(([k, v]) => [k, reverse(v)]),
          )
        : x;
  const frozen = new Backend();
  frozen.queue = false;
  frozen.events = reverse(snapshot);
  frozen.pageSize = 1;
  const second = setup(frozen, [() => assistant()]);
  await second.runtime.start();
  assert.deepEqual(first.requests, second.requests);
  assert.equal(first.requests[0].maxTokens, 32000);
  assert.equal(first.requests[0].sessionId, "conversation-stable");
  assert.equal(first.requests[0].maxRetries, 0);
  const bytes = JSON.stringify(canonical(first.requests[0]));
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (process.env.BATON_UPDATE_REQUEST_FIXTURE)
    writeFileSync("test/request.sha256", hash + "\n");
  assert.equal(hash, readFileSync("test/request.sha256", "utf8").trim());
  if (process.env.BATON_REQUEST_ARTIFACT)
    writeFileSync(process.env.BATON_REQUEST_ARTIFACT, bytes);
});

test("已保存的提示词快照跨标题变更保持稳定，未知版本拒绝", () => {
  const b = new Backend(),
    boot = b.boot();
  const events = [
    input(),
    {
      seq: 2,
      kind: "assistant" as const,
      payload: {
        format: "pi-ai/1",
        message: assistant(),
        prompt: {
          version: "1",
          title: boot.project.title,
          goal: boot.project.goal,
        },
      },
    },
  ];
  const before = modelMessages(boot, events);
  boot.project.title = "新标题";
  assert.deepEqual(before, modelMessages(boot, events));
  boot.prompt_version = "99";
  assert.throws(() => modelMessages(boot, []));
});

test("模型文本先形成临时预览，完整回复保存后才进入历史", async () => {
  const b = new Backend();
  const previews: any[] = [];
  const call = b.call.bind(b);
  b.call = async (req: any) => {
    if (req.operation === 'preview') {
      previews.push(structuredClone(req));
      assert.equal(b.events.at(-1)?.kind, 'input');
    }
    return call(req);
  };
  await setup(b, [() => fauxAssistantMessage('临时文本与完整回复')]).runtime.start();
  assert.ok(previews.some((p) => p.payload.text.length > 0));
  assert.equal(previews[0].last_seq, 1);
  assert.equal(b.events.length, 2);
  assert.equal(b.events[1].kind, 'assistant');
  assert.equal(b.effects, 0);
});

test("模型创建事项后继续调用 Inbox 工具，参数和结果经中心保存", async () => {
  const backend = new Backend();
  const calls = [
    fauxToolCall("inbox.ask", {
      title: "请决定", summary: "测试结果", content: "[证据](https://example.org)",
      options: [{ id: "go", label: "继续" }], allow_text: true,
    }, { id: "ask" }),
    fauxToolCall("inbox.list", {}, { id: "list" }),
    fauxToolCall("inbox.get", { request_id: "request-1" }, { id: "get" }),
    fauxToolCall("inbox.withdraw", { request_id: "request-1", reason: "情况变化" }, { id: "withdraw" }),
  ];
  const fixture = setup(backend, [() => fauxAssistantMessage(calls), () => assistant()]);
  await fixture.runtime.start();
  const saved = backend.events.find((event) => event.kind === "assistant");
  assert.deepEqual(saved?.payload.message.content, calls);
  assert.deepEqual(backend.events.filter((event) => event.kind === "tool_result").map((event) => event.payload.message.toolName),
    ["inbox.ask", "inbox.list", "inbox.get", "inbox.withdraw"]);
  assert.equal(backend.effects, 4);
  assert.equal(fixture.faux.state.callCount, 2);
});
