import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "bin");

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} 执行失败：${result.signal ?? result.status}`);
  }
}

export function build(run = runCommand) {
  run("pnpm", ["--dir", "web", "install", "--frozen-lockfile"]);
  run("pnpm", ["--dir", "web", "build"]);
  mkdirSync(output, { recursive: true });
  run("go", ["build", "-o", "bin" + sep, "./cmd/..."]);
}

if (import.meta.main) {
  try {
    build();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
