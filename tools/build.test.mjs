import assert from "node:assert/strict";
import { sep } from "node:path";
import { test } from "node:test";
import { build } from "./build.mjs";

const expected = [
  ["pnpm", ["--dir", "web", "install", "--frozen-lockfile"]],
  ["pnpm", ["--dir", "web", "build"]],
  ["go", ["build", "-o", "bin" + sep, "./cmd/..."]],
];

test("先安装锁定的前端依赖、构建静态文件，再编译 Go 二进制", () => {
  const calls = [];
  build((command, args) => calls.push([command, args]));
  assert.deepEqual(calls, expected);
});

for (const [index, name] of ["依赖安装", "前端构建", "Go 编译"].entries()) {
  test(`${name}失败时停止构建并保留错误`, () => {
    const calls = [];
    const failure = new Error(`${name}失败`);
    assert.throws(() => build((command, args) => {
      calls.push([command, args]);
      if (calls.length === index + 1) throw failure;
    }), (error) => error === failure);
    assert.deepEqual(calls, expected.slice(0, index + 1));
  });
}
