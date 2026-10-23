import { cp, mkdtemp, rm, readdir, realpath, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const root = await mkdtemp(join(tmpdir(), "baton-package-"));
try {
  const installed = join(root, "installed");
  await cp(resolve(process.argv[2] ?? "bin"), installed, {
    recursive: true,
    verbatimSymlinks: true,
  });
  const bundle = await realpath(join(installed, "sidecars/project-agent"));
  async function checkLinks(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if ((await lstat(path)).isSymbolicLink()) {
        const target = relative(bundle, await realpath(path));
        assert.ok(
          !target.startsWith("..") && !isAbsolute(target),
          "bundle 链接指向包外",
        );
      } else if (entry.isDirectory()) await checkLinks(path);
    }
  }
  await checkLinks(bundle);
  const host = join(
    installed,
    process.platform === "win32" ? "batond.exe" : "batond",
  );
  const env = {
    ...process.env,
    BATON_PROJECT_RUNTIME_DATA_DIR: join(root, "credentials"),
    BATON_SIDECAR_HOST: host,
  };
  function run(binary, args, input) {
    const result = spawnSync(binary, args, {
      input,
      env,
      cwd: installed,
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: 16 * 1024,
    });
    assert.equal(result.status, 0, "分发包命令失败");
    return result.stdout;
  }
  const cli = join(bundle, "dist/project-agent/src/cli.js");
  assert.equal(run(process.execPath, [cli, "--version"]).trim(), "0.1.0");
  const dir = env.BATON_PROJECT_RUNTIME_DATA_DIR,
    file = join(dir, "openai-codex.json");
  run(host, ["sidecar-file", "protect-dir", dir]);
  const credential = JSON.stringify({
    type: "oauth",
    access: "fixture-access",
    refresh: "fixture-refresh",
    expires: 0,
  });
  run(host, ["sidecar-file", "write", dir, file], credential);
  assert.equal(run(host, ["sidecar-file", "read", dir, file]), credential);
  const result = JSON.parse(run(process.execPath, [cli, "probe"]));
  assert.equal(result.version, "0.1.0");
  assert.equal(
    result.providers.find((p) => p.provider === "openai-codex").status,
    "available",
  );
  console.log("分发包搬迁、版本、probe 和私有文件验证通过");
} finally {
  await rm(root, { recursive: true, force: true });
}
