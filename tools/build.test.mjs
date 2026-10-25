import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from './build.mjs'

const expected = [
  ['pnpm', ['install', '--frozen-lockfile', '--ignore-scripts']],
  ['pnpm', ['--dir', 'web', 'typecheck']],
  ['pnpm', ['--filter', '@baton/server', 'build']],
  ['pnpm', ['--filter', '@baton/batond', 'build']],
]

test('安装 workspace 锁定依赖，检查网页类型并构建中心与节点 bundle', () => {
  const calls = []
  build((command, args) => calls.push([command, args]))
  assert.deepEqual(calls, expected)
})

for (const [index, name] of ['依赖安装', '网页类型检查', '中心和网页构建', '节点构建'].entries()) {
  test(`${name}失败时停止构建并保留错误`, () => {
    const calls = []
    const failure = new Error(`${name}失败`)
    assert.throws(
      () =>
        build((command, args) => {
          calls.push([command, args])
          if (calls.length === index + 1) throw failure
        }),
      (error) => error === failure,
    )
    assert.deepEqual(calls, expected.slice(0, index + 1))
  })
}
