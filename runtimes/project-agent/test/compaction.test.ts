import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Backend, setup, assistant, input } from "./fixture.js";
import { history } from "./compaction-fixture.js";
import { modelMessages } from "../src/runtime.js";
import { contextTokens, summaryThrough, clearedResults, estimatedTokens } from "../src/compaction.js";

test("usage 合计计入缓存 token，新增内容按四字符估算", () => {
  const b = new Backend();
  history(b, 1, 0, 0);
  b.events.at(-1)!.payload.message.usage = { input: 100, cacheRead: 200, cacheWrite: 300 };
  assert.ok(contextTokens(b.boot(), b.events) >= 600);
  assert.ok(contextTokens(b.boot(), b.events) < 1000);
});

test("收尾超过 50% 后先清除旧结果，降到 40% 以下不请求摘要", async () => {
  const b = new Backend();
  history(b, 10, 20000, 10);
  const before = structuredClone(b.events);
  const s = setup(b, [], 90_000);
  await s.runtime.start();
  const compact = b.events.at(-1)!;
  assert.equal(s.requests.length, 0);
  assert.equal(compact.kind, "compaction");
  assert.equal(compact.payload.through_seq, 0);
  assert.equal(compact.payload.cleared_tool_result_seqs.length, 7);
  assert.deepEqual(b.events.slice(0, before.length), before);
  const text = JSON.stringify(modelMessages(b.boot(), b.events));
  assert.ok(text.includes("原文为第 3 条"));
  assert.ok(!text.includes("原始工具结果-0"));
  assert.ok(text.includes("原始工具结果-9"));
  assert.ok(!text.includes("第 1～0"));
});

test("收尾摘要复用上次正常请求前缀，保留两轮与至少 15% 窗口", async () => {
  const b = new Backend();
  history(b, 8, 1000, 5000);
  b.queue = true;
  const s = setup(b, [assistant(), fauxAssistantMessage("目标、决定、task-123、待处理事项")], 50_000);
  await s.runtime.start();
  assert.equal(s.requests.length, 2);
  assert.equal(s.requests[1].toolChoice, "none");
  assert.deepEqual(s.requests[1].model, s.requests[0].model);
  assert.equal(s.requests[1].sessionId, s.requests[0].sessionId);
  assert.deepEqual(s.requests[1].context.messages.slice(0, -1), s.requests[0].context.messages);
  const compact = b.events.at(-1)!;
  assert.equal(compact.kind, "compaction");
  assert.ok(compact.payload.through_seq > 0);
  assert.ok(b.events.filter((e) => e.kind === "input" && e.seq > compact.payload.through_seq).length >= 2);
  const kept = modelMessages({ ...b.boot(), compaction: undefined }, b.events.filter((e) => e.seq > compact.payload.through_seq)).slice(1);
  assert.ok(estimatedTokens(kept) >= 50_000 * .15);
  assert.match(JSON.stringify(modelMessages(b.boot(), b.events)), /程序说明.*history.read.*history.search/);
});

test("请求前超过 80% 先摘要，下一正常请求使用保存后的视图", async () => {
  const b = new Backend();
  history(b, 8, 1000, 5000);
  b.events.push({ ...input(), seq: b.events.length + 1 });
  const s = setup(b, [fauxAssistantMessage("摘要"), assistant()], 25_000);
  await s.runtime.start();
  assert.equal(s.requests[0].toolChoice, "none");
  assert.ok(JSON.stringify(s.requests[1].context).includes("程序说明"));
  assert.equal(b.events.filter((e) => e.kind === "compaction").length, 1);
});

test("阈值以下保持原文，当前轮次的工具调用不会被切开", async () => {
  const b = new Backend();
  history(b, 2, 1000, 5000);
  const before = structuredClone(b.events);
  const s = setup(b, [], 1_000_000);
  await s.runtime.start();
  assert.deepEqual(b.events, before);
  assert.equal(summaryThrough(b.boot(), b.events, 1000), 0);
  assert.deepEqual(clearedResults(b.boot(), b.events), []);
});

test("摘要模型失败重试后报告失败，原文和压缩指针保持原样", async () => {
  const b = new Backend();
  history(b);
  const before = structuredClone(b.events);
  const error = () => fauxAssistantMessage("失败", { stopReason: "error" });
  const s = setup(b, [error, error, error, error], 30_000);
  await s.runtime.start();
  assert.deepEqual(b.events, before);
  assert.equal(b.calls.at(-1), "report_failure");
});

test("清除视图中的保留内容达到 15%，重复摘要合并旧摘要且范围增长", async () => {
  const b = new Backend();
  history(b, 12, 20000, 6000);
  const first = setup(b, [fauxAssistantMessage("旧摘要")], 100_000);
  await first.runtime.start();
  const compact = b.events.at(-1)!;
  assert.equal(compact.kind, "compaction");
  const oldThrough = compact.payload.through_seq;
  // 新增六轮输入，仍使用同一对话原文和上次摘要。
  const more = new Backend();
  history(more, 6, 20000, 6000);
  for (const e of more.events) b.events.push({ ...e, seq: b.events.length + 1 });
  const second = setup(b, [fauxAssistantMessage("合并后的摘要")], 100_000);
  await second.runtime.start();
  const next = b.events.at(-1)!;
  assert.ok(next.payload.through_seq > oldThrough);
  assert.ok(JSON.stringify(second.requests[0].context).includes("旧摘要"));
  assert.ok(second.requests[0].context.messages.at(-1).content.includes("前 "));
});

test("实际 Runtime 子进程在 compaction 提交前后被杀，恢复不改原文或重复压缩", async () => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const { frames, writeFrame } = await import("../../shared/stdio.js");
  for (const mode of ["clear", "summary"]) {
    for (const point of ["before", "after"]) {
      const b = new Backend();
      if (mode === "clear") history(b, 10, 20000, 10);
      else history(b, 8, 1000, 5000);
      const original = structuredClone(b.events);
      const run = async (crash: boolean) => {
        const child = spawn(process.execPath, ["--import", "tsx", "test/compaction-process-worker.ts"], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, BATON_TEST_COMPACTION_WINDOW: mode === "clear" ? "90000" : "40000" },
        });
        const exit = once(child, "exit");
        let stderr = "";
        child.stderr.on("data", (data) => { stderr += data; });
        for await (const raw of frames(child.stdout)) {
          const frame = raw as any;
          if (crash && point === "before" && frame.request.operation === "append_compaction") { child.kill("SIGKILL"); break; }
          const data = await b.call(frame.request);
          if (crash && point === "after" && frame.request.operation === "append_compaction") { child.kill("SIGKILL"); break; }
          await writeFrame(child.stdin, { id: frame.id, result: { type: "project_runtime.result", ok: true, data } });
        }
        child.stdin.end();
        const [code] = await exit;
        if (!crash) assert.equal(code, 0, stderr);
      };
      await run(true);
      await run(false);
      assert.deepEqual(b.events.slice(0, original.length), original);
      assert.equal(b.events.filter((e) => e.kind === "compaction").length, 1, mode + point);
    }
  }
});

test("清除工具结果后和进程恢复后继续以真实 usage 为基准扣减", () => {
  const b = new Backend();
  history(b, 8, 1000, 10);
  b.events.at(-1)!.payload.message.usage = { input: 80_000, cacheRead: 10_000, cacheWrite: 0 };
  const before = contextTokens(b.boot(), b.events);
  const cleared = clearedResults(b.boot(), b.events);
  b.events.push({ seq: b.events.length + 1, kind: "compaction", payload: { through_seq: 0, summary: "", cleared_tool_result_seqs: cleared } });
  const after = contextTokens(b.boot(), b.events);
  assert.ok(after < before);
  assert.ok(after > 80_000);
  assert.equal(contextTokens(structuredClone(b.boot()), structuredClone(b.events)), after);
});

test("15% 保留窗口按工具结果清除后的内容计算", async () => {
  const b = new Backend();
  history(b, 12, 50000, 10000);
  b.events.at(-1)!.payload.message.usage = { input: 400_000, cacheRead: 0, cacheWrite: 0 };
  const s = setup(b, [fauxAssistantMessage("摘要")], 400_000);
  await s.runtime.start();
  const boot = b.boot();
  assert.ok(boot.compaction!.payload.through_seq > 0);
  assert.ok(boot.compaction!.payload.cleared_tool_result_seqs.length > 0);
  const retained = b.events.filter((e) => e.seq > boot.compaction!.payload.through_seq);
  const view = { ...boot, compaction: { ...boot.compaction!, payload: { ...boot.compaction!.payload, through_seq: 0 } } };
  assert.ok(estimatedTokens(modelMessages(view, retained).slice(1)) >= 400_000 * .15);
});
