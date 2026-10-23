import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { FileCredentials } from "../src/credentials.js";
import { probe } from "../src/auth.js";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { XAI_MODELS } from "@earendil-works/pi-ai/providers/xai.models";

test("probe 只读本地凭据，不发网络请求、不刷新 OAuth、不输出凭据", async () => {
  const dir = await mkdtemp(join(tmpdir(), "baton-auth-"));
  try {
    const store = new FileCredentials(dir);
    await store.modify("openai-codex", async () => ({
      type: "oauth",
      refresh: "test-refresh",
      access: "test-access",
      expires: 0,
    }));
    const before = await readFile(join(dir, "openai-codex.json"), "utf8");
    const originalFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = async () => {
      networkCalls++;
      throw new Error("probe 不允许网络");
    };
    try {
      const result = await probe(store);
      assert.equal(result.providers[0].status, "available");
      assert.equal(result.providers[1].status, "login_required");
      for (const [index, catalog] of [
        OPENAI_CODEX_MODELS,
        XAI_MODELS,
      ].entries()) {
        assert.deepEqual(
          result.providers[index].models,
          Object.values(catalog)
            .slice(0, 64)
            .map(({ id, name }) => ({ id, name })),
        );
        assert.ok(result.providers[index].models.length > 0);
        assert.ok(result.providers[index].models.length <= 64);
      }
      assert.equal(networkCalls, 0);
      assert.ok(Buffer.byteLength(JSON.stringify(result)) < 16 * 1024);
      assert.ok(!JSON.stringify(result).includes("test-refresh"));
      assert.equal(
        await readFile(join(dir, "openai-codex.json"), "utf8"),
        before,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    if (process.platform !== "win32") {
      assert.equal((await stat(dir)).mode & 0o777, 0o700);
      assert.equal(
        (await stat(join(dir, "openai-codex.json"))).mode & 0o777,
        0o600,
      );
    }
    const child = spawnSync(
      process.execPath,
      ["dist/project-agent/src/cli.js", "probe"],
      {
        env: {
          ...process.env,
          BATON_PROJECT_RUNTIME_DATA_DIR: dir,
          NODE_OPTIONS: "",
        },
        encoding: "utf8",
        timeout: 1000,
      },
    );
    assert.equal(child.status, 0, child.stderr);
    const report = JSON.parse(child.stdout);
    assert.equal(report.providers[0].status, "available");
    assert.ok(
      report.providers.every(
        (provider: { models: unknown[] }) =>
          provider.models.length > 0 && provider.models.length <= 64,
      ),
    );
    assert.ok(Buffer.byteLength(child.stdout) < 16 * 1024);
    assert.ok(!child.stdout.includes("test-access"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("凭据不可读时仍返回内置模型目录，登录状态为 unknown", async () => {
  class UnreadableCredentials extends FileCredentials {
    async read(): Promise<never> {
      throw new Error("credential_permissions_invalid");
    }
  }
  const result = await probe(new UnreadableCredentials("unused"));
  assert.deepEqual(
    result.providers.map(({ status }) => status),
    ["unknown", "unknown"],
  );
  assert.ok(result.providers.every(({ models }) => models.length > 0));
});

test("凭据刷新串行化，不丢失并发更新", async () => {
  const dir = await mkdtemp(join(tmpdir(), "baton-lock-"));
  try {
    const store = new FileCredentials(dir);
    await Promise.all(
      Array.from({ length: 8 }, () =>
        store.modify("openai-codex", async (value) => ({
          type: "oauth",
          access: "a",
          refresh: "r",
          expires: (value?.expires ?? 0) + 1,
        })),
      ),
    );
    assert.equal((await store.read("openai-codex")).expires, 8);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
