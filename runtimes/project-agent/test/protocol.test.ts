import { test } from 'vitest'
import assert from 'node:assert/strict'
import { checkedRPC, eventMessage, RuntimeError, type Bootstrap, type Event, type Operation } from '../src/protocol.js'

const bootstrap: Bootstrap = {
  project: {
    memory_embedding: null,
    title: 'Baton',
    goal: '验证',
    agent: { provider: 'faux', model: 'local' },
    conversation: { id: 'local' },
  },
  input_seq: 0,
  memory_settings: { core_tokens: 1500, related_tokens: 3500, max_bytes: 40960 },
  prompt_version: '1',
  after_seq: 0,
  last_seq: 0,
}
const event = (kind: Event['kind']): Event => ({
  seq: 1,
  kind,
  payload: { format: 'pi-ai/1', message: { role: 'user', content: '本地输入', timestamp: 0 } },
})
const reply = (data: unknown) => ({ type: 'project_runtime.result', ok: true, data })

test('按 operation 校验结果结构，保留 data、事件和 pi-ai payload 的扩展字段', async () => {
  const input = event('input')
  input.payload.future = { signature: 'payload-signature' }
  input.payload.message.future = { reasoning: ['opaque', { signature: 'provider-signature' }] }
  const page = { events: [{ ...input, future: true }], last_seq: 1, next_after_seq: 1, has_more: false, future: 42 }
  const rpc = checkedRPC(async () => ({ ...reply(page), future: true }))
  const result = await rpc.call({ operation: 'read_events' })
  assert.strictEqual(result, page)
  assert.deepEqual(result, page)
  assert.deepEqual(eventMessage(result.events![0]), input.payload.message)

  const boot = { ...bootstrap, project: { ...bootstrap.project, future: { field: true } }, future: 42 }
  const typedBootstrap: Bootstrap = await checkedRPC(async () => reply(boot)).call({ operation: 'bootstrap' })
  assert.strictEqual(typedBootstrap, boot)
  const typedEvent: Event = await checkedRPC(async () => reply(event('assistant'))).call({ operation: 'append_event' })
  assert.equal(typedEvent.kind, 'assistant')
})

test('所有 Runtime operation 接受现行结果形状', async () => {
  const cases: [Operation, unknown][] = [
    ['bootstrap', bootstrap],
    ['bootstrap', { ...bootstrap, compaction: null, local_wait_protocol: 1 }],
    ['read_events', { events: null, last_seq: 0, next_after_seq: 0, has_more: false }],
    ['claim_inputs', { payload_bytes: 0, input_count: 0 }],
    ['claim_inputs', { event: event('input'), payload_bytes: 100, input_count: 1 }],
    [
      'embedding_query',
      {
        query: 'original text',
        query_hash: 'hash',
        query_truncated: false,
        last_seq: 0,
        input_seq: 0,
        memory_embedding: null,
      },
    ],
    [
      'prepare_context',
      {
        context_id: 'context',
        last_seq: 0,
        input_seq: 0,
        core_epoch: 0,
        budget: { core_tokens: 1500, related_tokens: 3500, max_bytes: 40960 },
        expires_at: null,
        content: 'core requirements',
        memory_refs: [],
        view_refs: [],
        degraded: [],
        core_complete: true,
        query: 'original text',
        algorithm: 'orama-3.1.18-nfkc-v1',
      },
    ],
    ['append_event', event('assistant')],
    ['commit_compaction', { seq: 2, kind: 'compaction', payload: { through_seq: 1, future: true } }],
    ['call_tool', event('tool_result')],
    ['wait_tool', { pending: true, thread_id: 'thread-local' }],
    ['call_tool', { pending: true, thread_id: 'thread-local', wait_protocol: 1, version: 0, wait_remaining_ms: 10 }],
    ['poll_wake', { wake: false }],
    ['poll_wake', { reason: 'thread_changed', version: 2 }],
    ['poll_wake', { reason: 'timeout', version: 2 }],
    ['preview', {}],
    ['finish', {}],
    ['report_failure', {}],
  ]
  for (const [operation, data] of cases) {
    const result = await checkedRPC(async () => reply(data)).call({ operation })
    assert.strictEqual(result, data, operation)
  }
})

test('拒绝缺少必填字段和类型错误的外层回复，错误码只接受字符串', async () => {
  for (const result of [
    { ok: true },
    { type: 'project_runtime.result' },
    { type: 'project_runtime.result', ok: 'true' },
    { type: 'project_runtime.result', ok: true, code: 42 },
    { type: 'project_runtime.result', ok: false, code: { private: true } },
    [],
    null,
  ]) {
    await assert.rejects(
      checkedRPC(async () => result).call({ operation: 'bootstrap' }),
      (error: unknown) => error instanceof RuntimeError && error.code === 'invalid_response',
    )
  }
  await assert.rejects(
    checkedRPC(async () => ({ type: 'project_runtime.result', ok: false, code: 'lease_lost' })).call({
      operation: 'bootstrap',
    }),
    (error: unknown) => error instanceof RuntimeError && error.code === 'lease_lost',
  )
})

test('在 RPC seam 拒绝 operation 结果错配与损坏结构', async () => {
  const cases: [Operation, unknown][] = [
    ['bootstrap', { known: 42 }],
    ['bootstrap', { ...bootstrap, project: { ...bootstrap.project, agent: { provider: 42, model: 'local' } } }],
    ['read_events', { events: [], last_seq: 0, next_after_seq: 0, has_more: 'false' }],
    ['read_events', { events: [{ ...event('input'), seq: -1 }], last_seq: 1, next_after_seq: 1, has_more: false }],
    ['claim_inputs', {}],
    ['claim_inputs', { event: event('assistant'), payload_bytes: 1, input_count: 1 }],
    ['append_event', event('compaction')],
    ['commit_compaction', event('assistant')],
    ['call_tool', event('assistant')],
    ['wait_tool', { pending: true, thread_id: '' }],
    ['wait_tool', { pending: true, thread_id: 'local', wait_protocol: 1 }],
    ['wait_tool', { pending: true, thread_id: 'local', wait_protocol: 1, version: -1, wait_remaining_ms: 0 }],
    ['call_tool', { ...event('tool_result'), payload: null }],
    ['poll_wake', { wake: 'true' }],
    ['preview', null],
    ['finish', undefined],
    ['report_failure', []],
  ]
  for (const [operation, data] of cases) {
    await assert.rejects(
      checkedRPC(async () => reply(data)).call({ operation }),
      (error: unknown) => error instanceof RuntimeError && error.code === 'invalid_response',
      operation,
    )
  }
})
