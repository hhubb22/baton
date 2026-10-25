import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import {
  COMPACTION_INSTRUCTION,
  DEFAULT_COMPACTION,
  clearedToolResults,
  compactionSettings,
  contextTokens,
  estimateMessages,
  selectThroughSeq,
  summaryText,
} from '../src/compaction.js'
import { modelMessages } from '../src/context.js'
import { modelContext } from '../src/tool-names.js'
import { RuntimeError, type Event } from '../src/protocol.js'
import { Backend, setup, input, assistant } from './fixture.js'

const summary = () =>
  fauxAssistantMessage(
    '用户要求修复登录，Thread thread-123 已在设备 node-b 的 /repo 开启，状态 running。等待测试结果，不要重复新建。用户要求保留现有配置。',
  )
function completedHistory(rounds = 5, chars = 90_000): Event[] {
  const events: Event[] = []
  for (let i = 0; i < rounds; i++) {
    events.push({ ...input(), seq: events.length + 1 })
    events.push({
      seq: events.length + 1,
      kind: 'assistant',
      payload: {
        format: 'pi-ai/1',
        message: fauxAssistantMessage([
          {
            type: 'thinking',
            thinking: '检查 Thread',
            thinkingSignature: 'opaque-provider-signature',
          },
          { type: 'text', text: 'a'.repeat(chars) },
        ]),
      },
    })
  }
  return events
}
class LargeToolBackend extends Backend {
  async call(req: any): Promise<any> {
    const result = await super.call(req)
    if (req.operation === 'call_tool') {
      result.payload.message.content = [{ type: 'text', text: `${req.tool_call_id}:` + 'x'.repeat(30_000) }]
      this.events.find((e) => e.seq === result.seq)!.payload = structuredClone(result.payload)
    }
    return result
  }
}
function toolHistory(rounds: number): Event[] {
  const events: Event[] = []
  for (let i = 0; i < rounds; i++) {
    const id = `tool-${i}`
    events.push({ ...input(), seq: events.length + 1 })
    events.push({
      seq: events.length + 1,
      kind: 'assistant',
      payload: {
        format: 'pi-ai/1',
        message: fauxAssistantMessage([fauxToolCall('devices.list', {}, { id })]),
      },
    })
    events.push({
      seq: events.length + 1,
      kind: 'tool_result',
      payload: {
        format: 'pi-ai/1',
        message: {
          role: 'toolResult',
          toolCallId: id,
          toolName: 'devices.list',
          content: [{ type: 'text', text: 'x'.repeat(30_000) }],
          isError: false,
          timestamp: 0,
        },
      },
    })
    events.push({
      seq: events.length + 1,
      kind: 'assistant',
      payload: { format: 'pi-ai/1', message: assistant() },
    })
  }
  return events
}

test('token 用量包含缓存和输出，压缩后的旧 usage 不再作为基线', () => {
  const b = new Backend()
  b.events = completedHistory(1, 50)
  b.events[1].payload.message = {
    ...assistant(),
    provider: 'faux',
    model: 'faux-model',
    usage: {
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      totalTokens: 100,
    },
  }
  const boot = b.boot()
  assert.equal(contextTokens(boot, b.events), 100)
  const later = { ...input(), seq: 3 }
  assert.ok(contextTokens(boot, [...b.events, later]) > 100)
  const compact: Event = {
    seq: 4,
    kind: 'compaction',
    payload: { through_seq: 0, summary: '', cleared_tool_result_seqs: [] },
  }
  boot.compaction = compact
  assert.equal(
    contextTokens(boot, [...b.events, later, compact]),
    estimateMessages(modelMessages(boot, [...b.events, later, compact])),
  )
  b.events[1].payload.message.usage.totalTokens = 0
  boot.compaction = undefined
  assert.equal(contextTokens(boot, b.events), 100)
})

test('工具缩减保护最近三轮及尚未分析的结果，只选较早的大输出', () => {
  const b = new Backend()
  b.events = toolHistory(5)
  assert.deepEqual(clearedToolResults(b.boot(), b.events, DEFAULT_COMPACTION), [3, 7])
  b.events.splice(-1)
  assert.deepEqual(clearedToolResults(b.boot(), b.events, DEFAULT_COMPACTION), [3, 7])
  b.events[2].payload.message.content = [{ type: 'text', text: '短结果' }]
  assert.deepEqual(clearedToolResults(b.boot(), b.events, DEFAULT_COMPACTION), [7])
})

test('切分保留最近两轮；超长单轮按完整工具批次切分，不留孤立结果', () => {
  const b = new Backend()
  const history = toolHistory(6)
  assert.equal(selectThroughSeq(b.boot(), history, 128000, DEFAULT_COMPACTION), 12)
  const single = history.filter((e, i) => e.kind !== 'input' || i === 0).map((e, i) => ({ ...e, seq: i + 1 }))
  const cut = selectThroughSeq(b.boot(), single, 128000, DEFAULT_COMPACTION)!
  assert.ok(cut > 1)
  const kept = single.filter((e) => e.seq > cut)
  assert.notEqual(kept[0].kind, 'tool_result')
  const partial = toolHistory(1).slice(0, 2)
  assert.equal(selectThroughSeq(b.boot(), partial, 100, DEFAULT_COMPACTION), undefined)
})

test('50% 收尾生成摘要，复用原前缀及签名，新提示词与记忆索引随摘要保存', async () => {
  const b = new Backend()
  b.queue = false
  b.events = completedHistory()
  for (const e of b.events)
    if (e.kind === 'assistant') e.payload.prompt = { version: '1', title: '旧标题', goal: '旧目标' }
  const original = structuredClone(b.events),
    boot = b.boot()
  const base = b.boot.bind(b)
  b.boot = () => ({ ...base(), memory_index: '- 部署约定' })
  const fixture = setup(b, [() => summary()], { contextWindow: 200000 })
  await fixture.runtime.start()
  const compact = b.events.findLast((e) => e.kind === 'compaction')!
  assert.ok(compact)
  assert.equal(compact.payload.through_seq, 6)
  assert.ok(compact.payload.tokens_after < compact.payload.tokens_before)
  assert.ok(compact.payload.usage)
  assert.equal(compact.payload.memory_index, '- 部署约定')
  assert.equal(compact.payload.prompt.title, 'Baton')
  assert.deepEqual(b.events.slice(0, original.length), original)
  const request = fixture.requests[0]
  assert.equal(request.toolChoice, 'none')
  assert.equal(request.sessionId, 'conversation-stable')
  assert.equal(request.context.messages.at(-1).content, COMPACTION_INSTRUCTION)
  assert.match(request.context.messages.at(-1).content, /准确 Thread ID、设备、目录、当前状态和最后的结论/)
  assert.match(
    request.context.messages.at(-1).content,
    /不向用户已停止或归档的 Thread 继续发消息，除非用户在对话里要求/,
  )
  assert.deepEqual(
    request.context.messages.slice(0, -1),
    modelContext({
      messages: modelMessages(
        boot,
        original.filter((e) => e.seq <= compact.payload.through_seq),
      ),
    }).messages,
  )
  const next = modelMessages(b.boot(), b.events)
  assert.ok(typeof next[0].content === 'string')
  assert.match(next[0].content, /项目标题：Baton/)
  assert.match(JSON.stringify(next), /thread-123/)
  assert.equal(b.calls.at(-1), 'finish')
  const recovered = setup(b, [], { contextWindow: 200000 })
  await recovered.runtime.start()
  assert.equal(recovered.requests.length, 0)
})

test('较早的大工具输出省略后足够小，持久化清除记录而不调用摘要模型', async () => {
  const b = new Backend()
  b.queue = false
  b.events = toolHistory(10)
  const original = structuredClone(b.events)
  const fixture = setup(b, [], { contextWindow: 128000 })
  await fixture.runtime.start()
  assert.equal(fixture.requests.length, 0)
  const compact = b.events.at(-1)!
  assert.equal(compact.kind, 'compaction')
  assert.equal(compact.payload.through_seq, 0)
  assert.equal(compact.payload.summary, '')
  assert.deepEqual(compact.payload.cleared_tool_result_seqs, [3, 7, 11, 15, 19, 23, 27])
  assert.deepEqual(b.events.slice(0, original.length), original)
  const view = modelMessages(b.boot(), b.events)
  assert.match(JSON.stringify(view), /工具结果已清除/)
  assert.doesNotMatch(JSON.stringify(view), /以下摘要替换了第 1～0/)
})

test('长单轮在请求前自动压缩，保留未分析的工具批次，不重复执行副作用', async () => {
  const b = new LargeToolBackend()
  let tools = 0
  const response = (context: any) => {
    if (context.messages.at(-1)?.content === COMPACTION_INSTRUCTION) return summary()
    if (tools === 18) return assistant()
    return fauxAssistantMessage([fauxToolCall('devices.list', {}, { id: `call-${++tools}` })])
  }
  const fixture = setup(
    b,
    Array.from({ length: 30 }, () => response),
    { contextWindow: 128000 },
  )
  await fixture.runtime.start()
  assert.equal(b.effects, 18)
  assert.ok(b.events.some((e) => e.kind === 'compaction'))
  assert.equal(b.events.filter((e) => e.kind === 'tool_result').length, 18)
  assert.equal(b.events.findLast((e) => e.kind !== 'compaction')?.kind, 'assistant')
  assert.ok(!b.calls.includes('report_failure'))
  const requests = fixture.requests
  const index = requests.findIndex((r) => r.toolChoice === 'none')
  assert.ok(index > 0)
  const prefix = requests[index].context.messages.slice(0, -1)
  assert.deepEqual(prefix, requests[index - 1].context.messages.slice(0, prefix.length))
  for (const e of b.events.filter((e) => e.kind === 'compaction')) {
    const retained = b.events.find((event) => event.seq > e.payload.through_seq && event.kind !== 'compaction')
    assert.notEqual(retained?.kind, 'tool_result')
  }
})

test('收尾的空、截断、工具调用和未缩短摘要不替换历史，耗尽重试后正常结束', async () => {
  const invalid = [
    () => fauxAssistantMessage('  '),
    () => fauxAssistantMessage('未完成', { stopReason: 'length' }),
    () => fauxAssistantMessage([fauxToolCall('threads.create', {}, { id: 'bad' })]),
    () => fauxAssistantMessage('x'.repeat(500_000)),
  ]
  for (const response of invalid) {
    const b = new Backend()
    b.queue = false
    b.events = completedHistory()
    const before = structuredClone(b.events)
    const fixture = setup(
      b,
      Array.from({ length: 4 }, () => response),
      { contextWindow: 200000 },
    )
    await fixture.runtime.start()
    assert.deepEqual(b.events, before)
    assert.equal(fixture.requests.length, 4)
    assert.equal(b.calls.at(-1), 'finish')
    assert.ok(!b.calls.includes('report_failure'))
    assert.equal(b.effects, 0)
  }
})

test('摘要提交丢失回执重发同一 ID，恢复后仍只有一个压缩事件', async () => {
  const b = new Backend()
  b.queue = false
  b.events = completedHistory()
  const call = b.call.bind(b),
    ids: string[] = []
  b.call = async (req: any) => {
    const result = await call(req)
    if (req.operation === 'commit_compaction') {
      ids.push(req.client_event_id)
      if (ids.length === 1) throw new RuntimeError('unavailable')
    }
    return result
  }
  const fixture = setup(b, [() => summary()], { contextWindow: 200000 })
  await fixture.runtime.start()
  assert.equal(ids.length, 2)
  assert.equal(ids[0], ids[1])
  assert.equal(b.events.filter((e) => e.kind === 'compaction').length, 1)
  assert.equal(fixture.requests.length, 1)
})

test('提交时历史变化会丢弃摘要、重新读取并计算，保留新输入', async () => {
  const b = new Backend()
  b.queue = false
  b.events = completedHistory()
  const call = b.call.bind(b)
  let conflict = true
  b.call = async (req: any) => {
    if (req.operation === 'commit_compaction' && conflict) {
      conflict = false
      b.events.push({ ...input(), seq: b.events.length + 1 })
      throw new RuntimeError('conflict')
    }
    return call(req)
  }
  const fixture = setup(b, [() => summary(), () => summary()], {
    contextWindow: 200000,
  })
  await fixture.runtime.start()
  assert.equal(fixture.requests.length, 2)
  assert.equal(b.events.filter((e) => e.kind === 'compaction').length, 1)
  assert.equal(b.events.findLast((e) => e.kind !== 'compaction')?.kind, 'input')
})

test('超过窗口的恢复历史分批生成摘要，每次请求均留出输出空间并合并旧摘要', async () => {
  const b = new Backend()
  b.queue = false
  b.events = completedHistory(12)
  const fixture = setup(
    b,
    Array.from({ length: 4 }, () => () => summary()),
    { contextWindow: 200000 },
  )
  await fixture.runtime.start()
  assert.equal(fixture.requests.length, 2)
  assert.equal(b.events.filter((e) => e.kind === 'compaction').length, 2)
  for (const request of fixture.requests)
    assert.ok(estimateMessages(request.context.messages) + request.maxTokens <= 200000)
  assert.match(JSON.stringify(fixture.requests[1].context.messages), /对话摘要/)
  assert.match(JSON.stringify(fixture.requests[1].context.messages), /thread-123/)
})

test('模型确认上下文溢出时有效压缩后重试，无进展时结束且不保存失败回复', async () => {
  for (const failAgain of [false, true]) {
    const b = new Backend()
    b.queue = false
    b.events = [...completedHistory(5, 20000), { ...input(), seq: 11 }]
    const overflow = () =>
      fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: 'Your input exceeds the context window of this model',
      })
    const fixture = setup(b, [overflow, () => summary(), failAgain ? overflow : () => assistant()], {
      contextWindow: 128000,
    })
    await fixture.runtime.start()
    assert.equal(fixture.requests.length, 3)
    assert.equal(b.events.filter((e) => e.kind === 'compaction').length, 1)
    assert.ok(!b.events.some((e) => e.payload.message?.stopReason === 'error'))
    assert.equal(b.calls.at(-1), failAgain ? 'report_failure' : 'finish')
  }
})

test('溢出恢复的摘要耗尽重试后结束运行，不再重发原来的超限请求', async () => {
  const b = new Backend()
  b.queue = false
  b.events = [...completedHistory(5, 20000), { ...input(), seq: 11 }]
  const fixture = setup(
    b,
    [
      () =>
        fauxAssistantMessage('', {
          stopReason: 'error',
          errorMessage: 'prompt is too long',
        }),
      ...Array.from({ length: 4 }, () => () => fauxAssistantMessage(' ')),
    ],
    { contextWindow: 128000 },
  )
  await fixture.runtime.start()
  assert.equal(fixture.faux.state.callCount, 5)
  assert.equal(b.calls.at(-1), 'report_failure')
  assert.ok(!b.events.some((e) => e.kind === 'compaction'))
})

test('压缩提交失去租约立即退出，不再次请求模型或执行工具', async () => {
  const b = new LargeToolBackend()
  b.events = toolHistory(13)
  b.events.push({ ...input(), seq: b.events.length + 1 })
  b.queue = false
  const call = b.call.bind(b)
  b.call = async (req: any) => {
    if (req.operation === 'commit_compaction') throw new RuntimeError('lease_lost')
    return call(req)
  }
  const fixture = setup(b, [], { contextWindow: 128000 })
  await assert.rejects(fixture.runtime.start(), (error: any) => error.code === 'lease_lost')
  assert.equal(fixture.requests.length, 0)
  assert.equal(b.effects, 0)
  assert.ok(!b.calls.includes('finish') && !b.calls.includes('report_failure'))
})

test('轮内压缩已提交后崩溃，另一个实例继续分析保留的工具结果', async () => {
  const b = new Backend()
  b.queue = false
  b.events = toolHistory(18)
    .filter((e, i) => e.kind !== 'input' || i === 0)
    .slice(0, -1)
    .map((e, i) => ({ ...e, seq: i + 1 }))
  const call = b.call.bind(b)
  let crash = true
  b.call = async (req: any) => {
    const result = await call(req)
    if (req.operation === 'commit_compaction' && crash) {
      crash = false
      throw new RuntimeError('crash')
    }
    return result
  }
  const first = setup(b, [() => summary()], { contextWindow: 128000 })
  await assert.rejects(first.runtime.start(), (error: any) => error.code === 'crash')
  assert.equal(b.events.at(-1)?.kind, 'compaction')
  assert.equal(b.events.findLast((e) => e.kind !== 'compaction')?.kind, 'tool_result')
  const expected = modelContext({
    messages: modelMessages(b.boot(), b.events),
  }).messages
  const second = setup(b, [() => assistant(), () => summary()], {
    contextWindow: 128000,
  })
  await second.runtime.start()
  assert.equal(second.requests.filter((r) => r.toolChoice !== 'none').length, 1)
  assert.deepEqual(second.requests[0].context.messages, expected)
  assert.equal(b.effects, 0)
  assert.equal(b.events.filter((e) => e.kind === 'tool_result').length, 18)
  assert.equal(b.calls.at(-1), 'finish')
})

test('压缩配置和摘要结构拒绝无效值', () => {
  assert.throws(() => compactionSettings({ requestRatio: NaN }))
  assert.throws(() => compactionSettings({ targetRatio: 0.6 }))
  assert.throws(() => summaryText(fauxAssistantMessage('', { stopReason: 'error' })))
})
