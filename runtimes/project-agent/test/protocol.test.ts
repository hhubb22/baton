import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkedRPC } from '../src/protocol.js'

test('Runtime 回复忽略未知字段并保留 data', async () => {
  const rpc = checkedRPC(async () => ({ type: 'project_runtime.result', ok: true, data: { known: 42 }, future: true }))
  assert.deepEqual(await rpc.call({ operation: 'bootstrap' }), { known: 42 })
})
test('Runtime 回复拒绝缺少必填字段和类型错误', async () => {
  for (const result of [
    { ok: true },
    { type: 'project_runtime.result' },
    { type: 'project_runtime.result', ok: 'true' },
    { type: 'project_runtime.result', ok: true, code: 42 },
    null,
  ]) {
    await assert.rejects(checkedRPC(async () => result).call({ operation: 'bootstrap' }))
  }
})
