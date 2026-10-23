import assert from "node:assert/strict";
import { join, sep } from "node:path";
import { test } from "node:test";
import { build } from "./build.mjs";

const expected = [
  ["pnpm", ["--dir", "web", "install", "--frozen-lockfile"]],
  ["pnpm", ["--dir", "web", "build"]],
  [
    "pnpm",
    [
      "--dir",
      "runtimes/project-agent",
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
    ],
  ],
  ["go", ["build", "-o", "bin" + sep, "./cmd/..."]],
  [
    process.execPath,
    [
      "tools/package-sidecar.mjs",
      "runtimes/project-agent",
      join("bin", "sidecars", "project-agent"),
      "project-agent",
    ],
  ],
];

test("安装锁定依赖、构建前端、编译一次 Go 并打包 Project Runtime", () => {
  const calls = [];
  build((command, args) => calls.push([command, args]));
  assert.deepEqual(calls, expected);
});

for (const [index, name] of [
  "前端依赖安装",
  "前端构建",
  "Runtime 依赖安装",
  "Go 编译",
  "Runtime 打包",
].entries()) {
  test(`${name}失败时停止构建并保留错误`, () => {
    const calls = [];
    const failure = new Error(`${name}失败`);
    assert.throws(
      () =>
        build((command, args) => {
          calls.push([command, args]);
          if (calls.length === index + 1) throw failure;
        }),
      (error) => error === failure,
    );
    assert.deepEqual(calls, expected.slice(0, index + 1));
  });
}
