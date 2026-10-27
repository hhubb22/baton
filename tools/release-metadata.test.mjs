import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildServer } from './build/server.mjs'
import { buildBatond } from './build/batond.mjs'
import { releaseMetadata } from '../packages/protocol/src/release.mjs'
import { isolatedEnv } from './lib/installation.mjs'

// 使用实际 bundle 验证编译身份与诊断，探测只读取本地目录，不登录或请求模型。
test('开发与发布 bundle 的中心、节点、子进程及 Runtime 诊断使用同一份身份', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'baton-release-metadata-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const server = join(directory, 'server.cjs')
  const batond = join(directory, 'batond.cjs')
  const run = (file, args) =>
    JSON.parse(
      execFileSync(process.execPath, [file, ...args], {
        cwd: directory,
        env: isolatedEnv(directory),
        encoding: 'utf8',
        timeout: 15000,
      }),
    )
  for (const input of [{}, { version: 'v0.1.0-alpha.1', commit: 'a'.repeat(40) }]) {
    await buildServer(server, input)
    await buildBatond(batond, input)
    const expected = releaseMetadata(input.version ? input : undefined)
    assert.deepEqual(run(server, ['--version']), { ...expected, node: process.version })
    const node = { ...expected, sea: false, node: process.version }
    assert.deepEqual(run(batond, ['--version']), node)
    for (const role of ['worker', 'agent-host', 'watchdog', 'project-runtime'])
      assert.deepEqual(run(batond, [role, '--version']), node)
    const runtime = run(batond, ['project-runtime', 'probe'])
    assert.equal(runtime.version, expected.version)
    assert.deepEqual(runtime.release, expected)
  }
})
