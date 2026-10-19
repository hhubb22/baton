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
