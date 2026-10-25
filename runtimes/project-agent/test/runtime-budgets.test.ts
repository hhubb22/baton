import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from '@earendil-works/pi-ai'
import { COMPACTION_INSTRUCTION, estimateMessages } from '../src/compaction.js'
import { RUN_MS } from '../src/runtime.js'
import { RuntimeError, type Event, type Request } from '../src/protocol.js'
import { Backend, setup, input, assistant } from './fixture.js'

class ObservedBackend extends Backend {
  requests: Request[] = []
  async call(request: Request) {
    this.requests.push(structuredClone(request))
    return super.call(request)
  }
}

function history(rounds = 8): Event[] {
  return Array.from({ length: rounds }, (_, index) => [
    { ...input(), seq: index * 2 + 1 },
    {
      seq: index * 2 + 2,
      kind: 'assistant',
      payload: { format: 'pi-ai/1', message: fauxAssistantMessage('历史'.repeat(10000)) },
    } satisfies Event,
  ]).flat()
}
const overflow = () => fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'prompt is too long' })
const summary = () => fauxAssistantMessage('保留用户要求与已完成的操作。')

test('收尾摘要失败保留已完成回复，正常 finish 并留下诊断，下次可继续压缩', async (t) => {
  const warnings: unknown[][] = []
  t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args))
  const backend = new ObservedBackend()
  backend.events = history()
  const fixture = setup(
    backend,
    [() => fauxAssistantMessage('已完成'), ...Array.from({ length: 4 }, () => () => fauxAssistantMessage(' '))],
    { contextWindow: 64000, budget: { maxOutputTokens: 4000 } },
  )
  await fixture.runtime.start()
  assert.equal(backend.events.at(-1)?.payload.message.content[0].text, '已完成')
  assert.ok(!backend.events.some((event) => event.kind === 'compaction'))
  assert.equal(backend.calls.at(-1), 'finish')
  assert.ok(!backend.calls.includes('report_failure'))
  assert.match(JSON.stringify(warnings), /finish_compaction_failed.*model_request_failed/)
  backend.queue = true
  const next = setup(backend, [() => assistant(), summary], { contextWindow: 64000, budget: { maxOutputTokens: 4000 } })
  await next.runtime.start()
  assert.ok(backend.events.some((event) => event.kind === 'compaction'))
  assert.equal(backend.calls.at(-1), 'finish')
})

test('收尾摘要提交丢失租约仍直接退出', async () => {
  const backend = new ObservedBackend()
  backend.queue = false
  backend.events = history()
  const original = backend.call.bind(backend)
  backend.call = async (request) => {
    if (request.operation === 'commit_compaction') throw new RuntimeError('lease_lost')
    return original(request)
  }
  const fixture = setup(backend, [summary], { contextWindow: 32000, budget: { maxOutputTokens: 4000 } })
  await assert.rejects(fixture.runtime.start(), { code: 'lease_lost' })
  assert.ok(!backend.calls.includes('finish'))
  assert.ok(!backend.calls.includes('report_failure'))
})

test('输出预算可提高到 32000 以上并受模型上限约束', async () => {
  for (const [configured, modelLimit, expected] of [
    [48000, 64000, 48000],
    [48000, 12000, 12000],
  ]) {
    const backend = new Backend()
    const fixture = setup(backend, [() => assistant()], {
      budget: { maxOutputTokens: configured },
      maxTokens: modelLimit,
    })
    await fixture.runtime.start()
    assert.equal(fixture.requests[0].maxTokens, expected)
  }
})

test('超量输出降低 token 预算并反馈容量，完整保存恢复结果，失败工具不执行', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const backend = new ObservedBackend()
  const huge = () =>
    fauxAssistantMessage([
      { type: 'text', text: '长'.repeat(70000) },
      fauxToolCall('threads.create', {}, { id: 'discarded' }),
    ])
  const fixture = setup(backend, [huge, () => assistant()])
  await fixture.runtime.start()
  assert.equal(fixture.requests.length, 2)
  assert.ok(fixture.requests[1].maxTokens < fixture.requests[0].maxTokens)
  assert.match(JSON.stringify(fixture.requests[1].context.messages), /160 KiB/)
  assert.equal(backend.effects, 0)
  assert.equal(backend.events.length, 2)
  assert.equal(backend.calls.at(-1), 'finish')
})

test('持续超量输出有界结束，报告明确容量错误', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const backend = new ObservedBackend()
  const fixture = setup(
    backend,
    Array.from({ length: 4 }, () => () => fauxAssistantMessage('x'.repeat(170 * 1024))),
  )
  await fixture.runtime.start()
  assert.equal(fixture.requests.length, 4)
  assert.ok(
    fixture.requests.every((request, index) => !index || request.maxTokens < fixture.requests[index - 1].maxTokens),
  )
  assert.equal(backend.requests.at(-1)?.reason, 'model_output_too_large')
  assert.equal(backend.effects, 0)
  assert.equal(backend.events.length, 1)
})

test('输出预算造成工具参数截断时要求完整调用，原工具不执行', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const backend = new ObservedBackend()
  const fixture = setup(backend, [
    () => fauxAssistantMessage([fauxToolCall('threads.create', {}, { id: 'truncated' })], { stopReason: 'length' }),
    () => assistant(),
  ])
  await fixture.runtime.start()
  assert.equal(fixture.requests.length, 2)
  assert.match(JSON.stringify(fixture.requests[1].context.messages), /截断了工具参数/)
  assert.equal(backend.effects, 0)
  assert.equal(backend.events.length, 2)
  assert.equal(backend.calls.at(-1), 'finish')
})

test('请求前必须生成的摘要失败仍报告模型错误', async () => {
  const backend = new ObservedBackend()
  backend.queue = false
  backend.events = [...history(20), { ...input(), seq: 41 }]
  const before = structuredClone(backend.events)
  const fixture = setup(
    backend,
    Array.from({ length: 4 }, () => () => fauxAssistantMessage(' ')),
    {
      contextWindow: 64000,
      budget: { maxOutputTokens: 4000 },
    },
  )
  await fixture.runtime.start()
  assert.deepEqual(backend.events, before)
  assert.equal(backend.requests.at(-1)?.reason, 'model_request_failed')
  assert.ok(!backend.calls.includes('finish'))
})

test('普通生成与重试也受模型调用总预算限制', async () => {
  const backend = new ObservedBackend()
  const fixture = setup(backend, [() => fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'temporary' })], {
    budget: { maxModelCalls: 1 },
  })
  await fixture.runtime.start()
  assert.equal(fixture.requests.length, 1)
  assert.equal(backend.requests.at(-1)?.reason, 'model_call_budget_exhausted')
})

test('连续上下文溢出可按压缩进展恢复多次', async () => {
  const backend = new ObservedBackend()
  backend.queue = false
  backend.events = [...history(), { ...input(), seq: 17 }]
  let failures = 0
  const response = (context: TranscriptContext) => {
    if (context.messages.at(-1)?.content === COMPACTION_INSTRUCTION) return summary()
    return failures++ < 2 ? overflow() : assistant()
  }
  const fixture = setup(
    backend,
    Array.from({ length: 10 }, () => response),
    { contextWindow: 128000 },
  )
  await fixture.runtime.start()
  const normal = fixture.requests.filter((request) => request.toolChoice !== 'none')
  assert.equal(normal.length, 3)
  assert.ok(estimateMessages(normal[1].context.messages) < estimateMessages(normal[0].context.messages))
  assert.ok(estimateMessages(normal[2].context.messages) < estimateMessages(normal[1].context.messages))
  assert.ok(!backend.events.some((event) => event.payload.message?.stopReason === 'error'))
  assert.equal(backend.calls.at(-1), 'finish')
})

test('长历史可连续压缩超过三批，所有摘要共用总预算', async () => {
  const backend = new ObservedBackend()
  backend.queue = false
  backend.events = history(50)
  const fixture = setup(
    backend,
    Array.from({ length: 20 }, () => summary),
    {
      contextWindow: 64000,
      budget: { maxOutputTokens: 4000, maxModelCalls: 20 },
    },
  )
  await fixture.runtime.start()
  assert.ok(backend.events.filter((event) => event.kind === 'compaction').length > 3)
  assert.ok(fixture.requests.length <= 20)
  for (const request of fixture.requests)
    assert.ok(estimateMessages(request.context.messages) + request.maxTokens <= 64000)
  assert.equal(backend.calls.at(-1), 'finish')
})

test('无法继续压缩时报告上下文无进展，避免重复请求', async () => {
  const backend = new ObservedBackend()
  const fixture = setup(backend, [overflow])
  await fixture.runtime.start()
  assert.equal(fixture.requests.length, 1)
  assert.equal(backend.requests.at(-1)?.reason, 'context_overflow_no_progress')
})

test('上下文恢复与摘要共用调用总预算，时间耗尽时停止恢复', async () => {
  for (const timedOut of [false, true]) {
    const backend = new ObservedBackend()
    backend.queue = false
    backend.events = [...history(), { ...input(), seq: 17 }]
    const fixture = setup(
      backend,
      [
        () => {
          if (timedOut) backend.now = RUN_MS
          return overflow()
        },
        summary,
        overflow,
      ],
      { contextWindow: 128000, budget: { maxModelCalls: 2 } },
    )
    await fixture.runtime.start()
    assert.equal(fixture.requests.length, timedOut ? 1 : 2)
    assert.equal(backend.requests.at(-1)?.reason, 'context_overflow_budget_exhausted')
  }
})

test('无效模型调用与输出预算在启动前拒绝', () => {
  for (const value of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => setup(new Backend(), [], { budget: { maxModelCalls: value } }))
    assert.throws(() => setup(new Backend(), [], { budget: { maxOutputTokens: value } }))
  }
})
