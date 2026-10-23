import { test } from "node:test";
import assert from "node:assert/strict";
import { createLoginInteraction } from "../src/login.js";

const options = [
  { id: "browser", label: "Browser login (default)" },
  { id: "device_code", label: "Device code login (headless)" },
];

test("登录方式显示选项，支持编号、ID 和默认选择", async () => {
  for (const [answer, expected] of [
    ["", "browser"],
    ["1", "browser"],
    ["2", "device_code"],
    [" device_code ", "device_code"],
  ]) {
    let menu = "";
    const interaction = createLoginInteraction(
      async (message) => {
        menu = message;
        return answer;
      },
      () => {},
    );
    assert.equal(
      await interaction.prompt({ type: "select", message: "Method", options }),
      expected,
    );
    assert.match(menu, /1\. Browser login/);
    assert.match(menu, /2\. Device code login/);
  }
});

test("无效选择重新提示，不回显输入", async () => {
  const answers = ["sensitive-input", "0", "1.0", "99", "2"];
  let output = "";
  const interaction = createLoginInteraction(
    async () => answers.shift()!,
    (text) => {
      output += text;
    },
  );
  assert.equal(
    await interaction.prompt({ type: "select", message: "Method", options }),
    "device_code",
  );
  assert.equal(answers.length, 0);
  assert.ok(!output.includes("sensitive-input"));
});

test("授权输入原样传递，取消信号传给终端读取", async () => {
  const controller = new AbortController();
  const cancelled = new Error("cancelled");
  const interaction = createLoginInteraction(
    async (message, signal) => {
      assert.equal(message, "Callback\n");
      assert.equal(signal, controller.signal);
      if (signal?.aborted) throw cancelled;
      return " https://localhost/callback?code=fixture ";
    },
    () => {},
  );
  const question = {
    type: "manual_code" as const,
    message: "Callback",
    signal: controller.signal,
  };
  assert.equal(
    await interaction.prompt(question),
    " https://localhost/callback?code=fixture ",
  );
  controller.abort(cancelled);
  await assert.rejects(
    interaction.prompt(question),
    (error) => error === cancelled,
  );
});

test("登录方式选择支持取消，空列表拒绝启动", async () => {
  const controller = new AbortController();
  controller.abort();
  const interaction = createLoginInteraction(
    async (_message, signal) => {
      signal?.throwIfAborted();
      return "";
    },
    () => {},
  );
  await assert.rejects(
    interaction.prompt({
      type: "select",
      message: "Method",
      options,
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
  await assert.rejects(
    interaction.prompt({ type: "select", message: "Method", options: [] }),
    /login_options_missing/,
  );
});

test("整个登录流程的取消信号也能中断未指定 signal 的选择提示", async () => {
  const controller = new AbortController();
  const interaction = createLoginInteraction(
    async (_message, signal) => {
      assert.equal(signal, controller.signal);
      return new Promise<string>((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), {
          once: true,
        });
      });
    },
    () => {},
    controller.signal,
  );
  assert.equal(interaction.signal, controller.signal);
  const pending = interaction.prompt({
    type: "select",
    message: "Method",
    options,
  });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("授权链接、设备验证码和进度写入诊断输出", () => {
  let output = "";
  const interaction = createLoginInteraction(
    async () => "",
    (text) => {
      output += text;
    },
  );
  interaction.notify({
    type: "auth_url",
    url: "https://example.test/authorize",
    instructions: "Open this URL",
  });
  interaction.notify({
    type: "device_code",
    verificationUri: "https://example.test/device",
    userCode: "FIXTURE-CODE",
  });
  interaction.notify({ type: "progress", message: "Waiting" });
  assert.equal(
    output,
    "Open this URL\nhttps://example.test/authorize\nhttps://example.test/device\nFIXTURE-CODE\nWaiting\n",
  );
});
