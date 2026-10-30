import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { measurementPassed } from './measure/stats.mjs'

const command = fileURLToPath(new URL('./measure/worker-startup.mjs', import.meta.url))

test('性能超标只记录结果，缺失样本、清理或账本错误仍使测量失败', () => {
  const result = {
    samples: 1,
    timings: [20000],
    shutdownTimings: [100],
    ledgerTransactions: 2,
    fullLedger: { transactions: 2, exceeds50Ms: true },
  }
  assert.equal(measurementPassed(result), true)
  assert.equal(measurementPassed({ ...result, shutdownTimings: [] }), false)
  assert.equal(measurementPassed({ ...result, failure: { message: 'cleanup failed' } }), false)
  assert.equal(measurementPassed({ ...result, ledgerFailure: { message: 'invalid pragma' } }), false)
  assert.equal(measurementPassed({ ...result, fullLedger: undefined }), false)
})

test('Worker 测量要求实际安装包，预构建驱动可从仓库外执行', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'baton-measure-driver-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const options = { cwd: directory, encoding: 'utf8', timeout: 30_000 }
  for (const args of [[], ['--prepared', directory]]) {
    const result = spawnSync(process.execPath, [command, ...args], options)
    assert.ifError(result.error)
    assert.equal(result.status, 1, result.stderr)
    assert.match(JSON.parse(result.stdout).failure.message, /--package directory/)
  }
  const prepared = spawnSync(process.execPath, [command, '--prepare', directory], options)
  assert.ifError(prepared.error)
  assert.equal(prepared.status, 0, prepared.stderr)
  const report = JSON.parse(prepared.stdout)
  assert.equal(report.prepared, true)
  assert.equal(report.driver, join(directory, 'measurement.cjs'))
  assert.ok((await stat(report.driver)).size > 0)
  const syntax = spawnSync(process.execPath, ['--check', report.driver], options)
  assert.ifError(syntax.error)
  assert.equal(syntax.status, 0, syntax.stderr)
})
