import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from './build.mjs'

const expected = [
  ['pnpm', ['install', '--frozen-lockfile', '--ignore-scripts']],
  ['pnpm', ['--dir', 'web', 'typecheck']],
  ['pnpm', ['--filter', '@baton/server', 'build']],
  ['pnpm', ['--filter', '@baton/batond', 'build']],
  [process.execPath, ['tools/package-batond.mjs', '--out', 'bin']],
]

test('安装 workspace 锁定依赖，构建中心与节点 bundle 并生成 SEA 安装包', () => {
  const calls = []
  build((command, args) => calls.push([command, args]))
  assert.deepEqual(calls, expected)
})

test('同一发布身份传给中心、节点 bundle 与 SEA 打包，输入不完整时不开始构建', () => {
  const identity = { version: 'v0.1.0-alpha.1', commit: 'a'.repeat(40) }
  const calls = []
  build((command, args) => calls.push([command, args]), identity)
  const suffix = ['--version', identity.version, '--commit', identity.commit]
  assert.deepEqual(
    calls,
    expected.map(([command, args], index) => {
      assert.ok(Array.isArray(args))
      return [command, index >= 2 ? [...args, ...suffix] : args]
    }),
  )
  assert.throws(() => build(() => assert.fail('不应开始构建'), { version: identity.version }))
})

for (const [index, name] of ['依赖安装', '网页类型检查', '中心和网页构建', '节点构建', 'SEA 打包'].entries()) {
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
