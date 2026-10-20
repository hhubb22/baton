import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { frames, writeFrame } from "../../shared/stdio.js";
import { modelMessages, IDLE_MS, RUN_MS, RETRIES } from "../src/runtime.js";
import { canonical, RuntimeError } from "../src/protocol.js";
import { Backend, setup, assistant, input } from "./fixture.js";
import { toolDefinitions } from "../src/tools.js";

const execCall = () => fauxToolCall("nodes.exec", {
  node_id: "node-b", command: "echo test", working_directory: "/repo",
}, { id: "exec-1" });

class ExecBackend extends Backend {
  accepted = false;
  waits: any[] = [];
  pendingCount = 2;
  resultStatus = "completed";
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
          content: [{ type: "text", text: JSON.stringify({ task_id: "exec-task-1", status: req.payload?.finish_wait ? "running" : this.resultStatus }) }],
          isError: false, timestamp: 0,
        } },
      };
      this.events.push(event);
      return structuredClone(event);
    }
    return super.call(req);
  }
}

class LocalWaitBackend extends ExecBackend {
  localProtocol: number | undefined = 1;
  centerProtocol: number | undefined = 1;
  pendingCount = Infinity;
  taskVersion = 7;
  waitUntil = 30_000;
  completeAt = 30_000;
  requests: { request: any; at: number }[] = [];
  sleeps: number[] = [];
  onPoll?: (request: any) => Promise<any>;
  remaining = () => Math.max(0, this.waitUntil - this.now);
  boot() {
    return { ...super.boot(), local_wait_protocol: this.localProtocol };
  }
  timer() {
    return {
      now: () => this.now,
      sleep: async (ms: number) => {
        this.sleeps.push(ms);
        this.now += ms;
      },
    };
  }
  async call(req: any): Promise<any> {
    this.requests.push({ request: structuredClone(req), at: this.now });
    if (req.operation === "poll_wake" && req.payload.task_id) {
      this.calls.push(req.operation);
      assert.equal(req.payload.task_id, "exec-task-1");
      assert.ok(Number.isInteger(req.payload.wait_ms));
      assert.ok(req.payload.wait_ms >= 1 && req.payload.wait_ms <= 25_000);
      if (this.onPoll) return this.onPoll(req);
      this.now += req.payload.wait_ms;
      return { reason: "timeout" };
    }
    if (req.operation === "wait_tool" && this.now >= this.completeAt)
      this.pendingCount = 0;
    const response = await super.call(req);
    return response?.pending && this.centerProtocol === 1
      ? { ...response, task_version: this.taskVersion,
          wait_remaining_ms: this.remaining(), wait_protocol: 1 }
      : response;
  }
  taskPolls() {
    return this.requests.filter(({ request }) =>
      request.operation === "poll_wake" && request.payload.task_id);
  }
  waitTimes() {
    return this.requests.filter(({ request }) => request.operation === "wait_tool")
      .map(({ at }) => at);
  }
}

const execResponses = () => [() => fauxAssistantMessage([execCall()]), () => assistant()];

test("本地等待丢失全部通知，30 秒 pending 仅做初始、周期和截止三次状态查询", async () => {
  const backend = new LocalWaitBackend();
  backend.resultStatus = "running";
  const fixture = setup(backend, execResponses());
  await fixture.runtime.start();
  assert.equal(backend.effects, 1);
  assert.deepEqual(backend.waitTimes(), [0, 25_000, 30_000]);
  assert.deepEqual(backend.taskPolls().map(({ request }) => request.payload), [
    { task_id: "exec-task-1", after_version: 7, wait_ms: 25_000 },
    { task_id: "exec-task-1", after_version: 7, wait_ms: 5_000 },
  ]);
  assert.deepEqual(backend.sleeps, []);
  assert.ok(backend.waits.every((request) => !request.payload));
  assert.equal(fixture.faux.state.callCount, 2);
  assert.equal(backend.events.filter((event) => event.kind === "tool_result").length, 1);
  assert.match(backend.events.find((event) => event.kind === "tool_result")!.payload.message.content[0].text, /running/);
  const idlePolls = backend.requests.filter(({ request }) =>
    request.operation === "poll_wake" && !request.payload.task_id);
  assert.ok(idlePolls.length > 0);
  assert.ok(idlePolls.every(({ request }) => Object.keys(request.payload).join() === "wait_ms"));
});

test("中心或节点未声明新协议时沿用 250ms 查询，任务等待不消费通用 wake", async () => {
  for (const [local, center] of [[undefined, undefined], [undefined, 1], [1, undefined], [2, 1]]) {
    const backend = new LocalWaitBackend();
    backend.localProtocol = local;
    backend.centerProtocol = center;
    const fixture = setup(backend, execResponses());
    await fixture.runtime.start();
    assert.equal(backend.taskPolls().length, 0);
    assert.equal(backend.waits.length, 121);
    assert.equal(backend.sleeps.length, 120);
    assert.ok(backend.sleeps.every((ms) => ms === 250));
    const lastWait = backend.requests.findLastIndex(({ request }) => request.operation === "wait_tool");
    assert.ok(backend.requests.slice(0, lastWait).every(({ request }) => request.operation !== "poll_wake"));
  }
});

test("初始短查询发现已完成任务时跳过本地等待", async () => {
  const backend = new LocalWaitBackend();
  backend.completeAt = 0;
  await setup(backend, execResponses()).runtime.start();
  assert.deepEqual(backend.waitTimes(), [0]);
  assert.equal(backend.taskPolls().length, 0);
  assert.deepEqual(backend.sleeps, []);
});

test("节点过滤重复和无关通知后，任务变化仍须查询中心并可继续 pending", async () => {
  const backend = new LocalWaitBackend();
  backend.waitUntil = 60_000;
  backend.completeAt = 28_000;
  const notifications = [
    { at: 1_000, task_id: "other-task", version: 99 },
    { at: 2_000, task_id: "exec-task-1", version: 7 },
    { at: 3_000, task_id: "exec-task-1", version: 8 },
    { at: 4_000, task_id: "exec-task-1", version: 8 },
    { at: 5_000, task_id: "exec-task-1", version: 6 },
    { at: 6_000, task_id: "other-task", version: 100 },
  ];
  backend.onPoll = async ({ payload }) => {
    // 模拟节点过滤通知后的 IPC 边界，Runtime 只收到目标任务的新版本。
    const until = backend.now + payload.wait_ms;
    while (notifications.length && notifications[0].at <= until) {
      const notification = notifications.shift()!;
      backend.now = notification.at;
      if (notification.task_id === payload.task_id && notification.version > payload.after_version) {
        backend.taskVersion = notification.version;
        return { reason: "task_changed", version: notification.version };
      }
    }
    backend.now = until;
    return { reason: "timeout" };
  };
  await setup(backend, execResponses()).runtime.start();
  assert.deepEqual(backend.waitTimes(), [0, 3_000, 28_000]);
  assert.deepEqual(backend.taskPolls().map(({ request }) => request.payload.after_version), [7, 8]);
  assert.equal(backend.events.filter((event) => event.kind === "tool_result").length, 1);
  assert.deepEqual(backend.sleeps, []);
});

test("丢失完成通知后在下个 25 秒周期补读终态", async () => {
  const backend = new LocalWaitBackend();
  backend.waitUntil = 60_000;
  backend.completeAt = 26_000;
  await setup(backend, execResponses()).runtime.start();
  assert.deepEqual(backend.waitTimes(), [0, 25_000, 50_000]);
  assert.equal(backend.taskPolls().length, 2);
});

test("首次请求延迟 1 秒、后续查询耗时 1ms 时重新同步预算并限制 30 秒等待的请求数", async () => {
  for (const [local, center] of [[1, 1], [undefined, 1], [1, undefined]]) {
    const backend = new LocalWaitBackend();
    backend.localProtocol = local;
    backend.centerProtocol = center;
    // 中心在首次请求到达时建立 30 秒期限，此后保持不变。
    backend.waitUntil = backend.completeAt = 31_000;
    let nodeDeadline = Infinity;
    backend.onPoll = async ({ payload }) => {
      backend.now += Math.max(0, Math.min(payload.wait_ms, nodeDeadline - backend.now));
      return { reason: "timeout" };
    };
    const call = backend.call.bind(backend);
    backend.call = async (request) => {
      const started = backend.now;
      if (request.operation === "call_tool") backend.now += 1_000;
      if (request.operation === "wait_tool") backend.now += 1;
      const response = await call(request);
      if (response?.pending && response.wait_protocol === 1)
        nodeDeadline = started + response.wait_remaining_ms;
      return response;
    };
    await setup(backend, execResponses()).runtime.start();
    assert.ok(backend.waitTimes().at(-1)! >= backend.waitUntil);
    assert.ok(backend.waits.every((request) => !request.payload));
    assert.equal(backend.effects, 1);
    if (local === 1 && center === 1) {
      assert.ok(backend.waits.length <= 6, `状态查询次数过多: ${backend.waits.length}`);
      assert.deepEqual(backend.taskPolls().map(({ request }) => request.payload.wait_ms), [25_000, 4_997]);
      assert.deepEqual(backend.sleeps, []);
    } else {
      assert.equal(backend.taskPolls().length, 0);
      assert.equal(backend.waits.length, 121);
      assert.equal(backend.sleeps.length, 120);
      assert.ok(backend.sleeps.every((ms) => ms === 250));
    }
  }
});

test("本地预算已耗尽而中心仍 pending 时每次退避 250ms，由中心裁决结果", async () => {
  for (const local of [1, undefined]) {
    const backend = new LocalWaitBackend();
    backend.localProtocol = local;
    backend.remaining = () => 0;
    backend.completeAt = 500;
    await setup(backend, execResponses()).runtime.start();
    assert.deepEqual(backend.waitTimes(), [0, 250, 500]);
    assert.equal(backend.taskPolls().length, 0);
    assert.deepEqual(backend.sleeps, [250, 250]);
    assert.ok(backend.waits.every((request) => !request.payload));
  }
});

test("预算耗尽后的退避受剩余运行预算限制，到期使用 finish_wait", async () => {
  const backend = new LocalWaitBackend();
  backend.remaining = () => 0;
  backend.completeAt = Infinity;
  const call = backend.call.bind(backend);
  backend.call = async (request) => {
    const response = await call(request);
    if (request.operation === "call_tool") backend.now = RUN_MS - 100;
    return response;
  };
  const fixture = setup(backend, execResponses());
  await fixture.runtime.start();
  assert.equal(backend.now, RUN_MS);
  assert.deepEqual(backend.sleeps, [100]);
  assert.equal(backend.taskPolls().length, 0);
  assert.deepEqual(backend.waits.map((request) => request.payload), [undefined, { finish_wait: true }]);
  assert.equal(fixture.faux.state.callCount, 1);
  assert.deepEqual(backend.requests.at(-1)?.request, { operation: "finish", last_seq: 3, reason: "run_limit" });
});

test("新 pending 协议拒绝非法版本和剩余预算", async () => {
  for (const fields of [
    { task_version: -1 }, { task_version: 0.5 }, { task_version: "7" },
    { wait_remaining_ms: -1 }, { wait_remaining_ms: 0.5 },
    { wait_remaining_ms: undefined }, { wait_remaining_ms: Infinity },
  ]) {
    const backend = new LocalWaitBackend();
    const call = backend.call.bind(backend);
    backend.call = async (request) => {
      const response = await call(request);
      return response?.pending ? { ...response, ...fields } : response;
    };
    await assert.rejects(setup(backend, execResponses()).runtime.start(), { code: "invalid_tool_result" });
    assert.equal(backend.waits.length, 0);
    assert.equal(backend.taskPolls().length, 0);
    assert.equal(backend.events.at(-1)?.kind, "assistant");
  }
});

test("本地新协议在运行期限保存当前状态，恢复和普通执行均停止后续工具与模型", async () => {
  for (const recovery of [false, true]) {
    const backend = new LocalWaitBackend();
    backend.completeAt = Infinity;
    backend.waitUntil = RUN_MS + 60_000;
    const message = fauxAssistantMessage([execCall(), fauxToolCall("devices.list", {}, { id: "later-tool" })]);
    if (recovery) {
      backend.queue = false;
      backend.events.push(input(), { seq: 2, kind: "assistant", payload: { format: "pi-ai/1", message } });
    }
    const call = backend.call.bind(backend);
    backend.call = async (request) => {
      const result = await call(request);
      if (request.operation === "call_tool") backend.now = RUN_MS - 100;
      return result;
    };
    const fixture = setup(backend, [() => message]);
    await fixture.runtime.start();
    assert.equal(backend.now, RUN_MS);
    assert.deepEqual(backend.taskPolls().map(({ request }) => request.payload.wait_ms), [100]);
    assert.deepEqual(backend.waits.map((request) => request.payload), [undefined, { finish_wait: true }]);
    assert.equal(backend.effects, 1);
    assert.equal(fixture.faux.state.callCount, recovery ? 0 : 1);
    assert.deepEqual(backend.requests.at(-1)?.request, { operation: "finish", last_seq: 3, reason: "run_limit" });
    assert.ok(!backend.calls.includes("tasks.cancel"));
  }
});

test("运行期限已到或状态请求跨过期限时跳过本地等待并保留 finish_wait", async () => {
  for (const phase of ["call_tool", "wait_tool"]) {
    const backend = new LocalWaitBackend();
    backend.completeAt = Infinity;
    const call = backend.call.bind(backend);
    backend.call = async (request) => {
      const result = await call(request);
      if (request.operation === phase) backend.now = RUN_MS;
      return result;
    };
    const fixture = setup(backend, execResponses());
    await fixture.runtime.start();
    assert.equal(backend.taskPolls().length, 0);
    assert.deepEqual(backend.waits.at(-1).payload, { finish_wait: true });
    assert.equal(fixture.faux.state.callCount, 1);
  }
});

test("任务变化通知可无 version，取消结果由中心保存后返回模型", async () => {
  const backend = new LocalWaitBackend();
  backend.completeAt = 1_000;
  backend.resultStatus = "cancelled";
  backend.onPoll = async () => {
    backend.now += 1_000;
    return { reason: "task_changed" };
  };
  const fixture = setup(backend, execResponses());
  await fixture.runtime.start();
  assert.deepEqual(backend.waitTimes(), [0, 1_000]);
  assert.match(backend.events.find((event) => event.kind === "tool_result")!.payload.message.content[0].text, /cancelled/);
  assert.equal(fixture.faux.state.callCount, 2);
});

test("等待被停止或租约丢失时直接退出，不写工具结果或 finish", async () => {
  for (const phase of ["poll_wake", "wait_tool"]) {
    const backend = new LocalWaitBackend();
    const call = backend.call.bind(backend);
    backend.call = async (request) => {
      if (request.operation === phase && (phase === "poll_wake" || backend.taskPolls().length > 0))
        throw new RuntimeError(phase === "poll_wake" ? "aborted" : "lease_lost");
      return call(request);
    };
    await assert.rejects(setup(backend, execResponses()).runtime.start(),
      { code: phase === "poll_wake" ? "aborted" : "lease_lost" });
    assert.equal(backend.events.at(-1)?.kind, "assistant");
    assert.ok(!backend.calls.includes("finish"));
    assert.ok(!backend.calls.includes("tasks.cancel"));
  }
});

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
