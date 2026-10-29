import { test } from 'vitest'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import { frames, writeFrame } from '../src/stdio.js'
import { modelMessages, IDLE_MS, RUN_MS, RETRIES } from '../src/runtime.js'
import { canonical, RuntimeError, type Event } from '../src/protocol.js'
import { Backend, setup, assistant, input } from './fixture.js'
import { toolDefinitions } from '../src/tools.js'

const execCall = () =>
  fauxToolCall(
    'nodes.exec',
    {
      node_id: 'node-b',
      command: 'echo test',
      working_directory: '/repo',
    },
    { id: 'exec-1' },
  )

class ExecBackend extends Backend {
  accepted = false
  waits: any[] = []
  pendingCount = 2
  resultStatus = 'completed'
  async call(req: any): Promise<any> {
    if (
      req.operation === 'call_tool' &&
      req.tool_name === 'nodes.exec' &&
      !this.events.some(
        (event) => event.kind === 'tool_result' && event.payload.message.toolCallId === req.tool_call_id,
      )
    ) {
      assert.equal(req.last_seq, this.events.length)
      assert.ok(this.events.some((event) => event.kind === 'assistant'))
      this.calls.push(req.operation)
      if (!this.accepted) {
        this.accepted = true
        this.effects++
      }
      return { pending: true, thread_id: 'exec-thread-1' }
    }
    if (req.operation === 'wait_tool') {
      this.calls.push(req.operation)
      this.waits.push(structuredClone(req))
      assert.equal(req.tool_call_id, 'exec-1')
      assert.equal(req.last_seq, this.events.length)
      if (!req.payload?.finish_wait && this.waits.length <= this.pendingCount)
        return { pending: true, thread_id: 'exec-thread-1' }
      const event = {
        seq: this.events.length + 1,
        kind: 'tool_result' as const,
        payload: {
          format: 'pi-ai/1',
          message: {
            role: 'toolResult',
            toolCallId: 'exec-1',
            toolName: 'nodes.exec',
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  thread_id: 'exec-thread-1',
                  status: req.payload?.finish_wait ? 'running' : this.resultStatus,
                }),
              },
            ],
            isError: false,
            timestamp: 0,
          },
        },
      }
      this.events.push(event)
      return structuredClone(event)
    }
    return super.call(req)
  }
}

class LocalWaitBackend extends ExecBackend {
  localProtocol: number | undefined = 1
  centerProtocol: number | undefined = 1
  pendingCount = Infinity
  threadVersion = 7
  waitUntil = 30_000
  completeAt = 30_000
  requests: { request: any; at: number }[] = []
  sleeps: number[] = []
  onPoll?: (request: any) => Promise<any>
  remaining = () => Math.max(0, this.waitUntil - this.now)
  boot() {
    return { ...super.boot(), local_wait_protocol: this.localProtocol }
  }
  timer() {
    return {
      now: () => this.now,
      sleep: async (ms: number) => {
        this.sleeps.push(ms)
        this.now += ms
      },
    }
  }
  async call(req: any): Promise<any> {
    this.requests.push({ request: structuredClone(req), at: this.now })
    if (req.operation === 'poll_wake' && req.payload.thread_id) {
      this.calls.push(req.operation)
      assert.equal(req.payload.thread_id, 'exec-thread-1')
      assert.ok(Number.isInteger(req.payload.wait_ms))
      assert.ok(req.payload.wait_ms >= 1 && req.payload.wait_ms <= 25_000)
      if (this.onPoll) return this.onPoll(req)
      this.now += req.payload.wait_ms
      return { reason: 'timeout' }
    }
    if (req.operation === 'wait_tool' && this.now >= this.completeAt) this.pendingCount = 0
    const response = await super.call(req)
    return response?.pending && this.centerProtocol === 1
      ? { ...response, version: this.threadVersion, wait_remaining_ms: this.remaining(), wait_protocol: 1 }
      : response
  }
  threadPolls() {
    return this.requests.filter(({ request }) => request.operation === 'poll_wake' && request.payload.thread_id)
  }
  waitTimes() {
    return this.requests.filter(({ request }) => request.operation === 'wait_tool').map(({ at }) => at)
  }
}

const execResponses = () => [() => fauxAssistantMessage([execCall()]), () => assistant()]

test('每次模型请求自动注入当前快照，失效输出刷新后重试且不执行旧工具', async () => {
  const backend = new Backend()
  backend.memory = '用户要求：不要跳过测试，纯文档改动可以例外。'
  const fixture = setup(backend, [
    () => {
      backend.memory = '用户要求：不要跳过测试，纯文档也要检查格式。'
      backend.coreEpoch++
      return assistant(true)
    },
    () => assistant(true),
    () => assistant(),
  ])
  await fixture.runtime.start()
  assert.equal(fixture.requests.length, 3)
  assert.match(JSON.stringify(fixture.requests[0].context), /纯文档改动可以例外/)
  for (const request of fixture.requests.slice(1)) {
    const texts = request.context.messages.flatMap((message: any) =>
      typeof message.content === 'string'
        ? [message.content]
        : message.content.flatMap((c: any) => (c.type === 'text' ? [c.text] : [])),
    )
    const memories = texts.filter((text: string) => text.startsWith('用户要求：'))
    assert.equal(memories.length, 1)
    assert.match(memories[0], /纯文档也要检查格式/)
    // 记忆放在本批输入之前，系统提示和更早的历史保持同一前缀。
    assert.equal(request.context.messages[1].content[0].text, memories[0])
    assert.doesNotMatch(JSON.stringify(request.context), /纯文档改动可以例外/)
  }
  assert.equal(backend.effects, 1)
  assert.equal(backend.events.filter((e) => e.kind === 'assistant').length, 2)
  for (const event of backend.events.filter((e) => e.kind === 'assistant')) {
    assert.equal(backend.contexts.get(event.payload.memory_context_id)?.core_epoch, backend.coreEpoch)
  }
})

test('pending 执行跨记忆变化和 Runtime 恢复先续查原 Thread，再请求新上下文', async () => {
  const backend = new LocalWaitBackend()
  backend.memory = '原要求'
  backend.onPoll = async () => {
    backend.memory = '新要求'
    backend.coreEpoch++
    throw new RuntimeError('unavailable')
  }
  await assert.rejects(setup(backend, [() => fauxAssistantMessage([execCall()])]).runtime.start(), {
    code: 'unavailable',
  })
  assert.equal(backend.effects, 1)
  assert.equal(backend.contexts.size, 1)
  backend.onPoll = undefined
  const recovered = setup(backend, [() => assistant()])
  await recovered.runtime.start()
  assert.equal(backend.effects, 1)
  assert.equal(backend.events.filter((e) => e.kind === 'tool_result').length, 1)
  assert.equal(backend.contexts.size, 2)
  assert.match(JSON.stringify(recovered.requests[0].context), /新要求/)
  assert.ok(backend.waits.every((request) => request.tool_call_id === 'exec-1'))
})

test('本地等待丢失全部通知，30 秒 pending 仅做初始、周期和截止三次状态查询', async () => {
  const backend = new LocalWaitBackend()
  backend.resultStatus = 'running'
  const fixture = setup(backend, execResponses())
  await fixture.runtime.start()
  assert.equal(backend.effects, 1)
  assert.deepEqual(backend.waitTimes(), [0, 25_000, 30_000])
  assert.deepEqual(
    backend.threadPolls().map(({ request }) => request.payload),
    [
      { thread_id: 'exec-thread-1', after_version: 7, wait_ms: 25_000 },
      { thread_id: 'exec-thread-1', after_version: 7, wait_ms: 5_000 },
    ],
  )
  assert.deepEqual(backend.sleeps, [])
  assert.ok(backend.waits.every((request) => !request.payload))
  assert.equal(fixture.faux.state.callCount, 2)
  assert.equal(backend.events.filter((event) => event.kind === 'tool_result').length, 1)
  assert.match(backend.events.find((event) => event.kind === 'tool_result')!.payload.message.content[0].text, /running/)
  const idlePolls = backend.requests.filter(
    ({ request }) => request.operation === 'poll_wake' && !request.payload.thread_id,
  )
  assert.ok(idlePolls.length > 0)
  assert.ok(idlePolls.every(({ request }) => Object.keys(request.payload).join() === 'wait_ms'))
})

test('中心或节点未声明新协议时沿用 250ms 查询，Thread 等待不消费通用 wake', async () => {
  for (const [local, center] of [
    [undefined, undefined],
    [undefined, 1],
    [1, undefined],
    [2, 1],
  ]) {
    const backend = new LocalWaitBackend()
    backend.localProtocol = local
    backend.centerProtocol = center
    const fixture = setup(backend, execResponses())
    await fixture.runtime.start()
    assert.equal(backend.threadPolls().length, 0)
    assert.equal(backend.waits.length, 121)
    assert.equal(backend.sleeps.length, 120)
    assert.ok(backend.sleeps.every((ms) => ms === 250))
    const lastWait = backend.requests.findLastIndex(({ request }) => request.operation === 'wait_tool')
    assert.ok(backend.requests.slice(0, lastWait).every(({ request }) => request.operation !== 'poll_wake'))
  }
})

test('初始短查询发现已结束 Thread 时跳过本地等待', async () => {
  const backend = new LocalWaitBackend()
  backend.completeAt = 0
  await setup(backend, execResponses()).runtime.start()
  assert.deepEqual(backend.waitTimes(), [0])
  assert.equal(backend.threadPolls().length, 0)
  assert.deepEqual(backend.sleeps, [])
})

test('节点过滤重复和无关通知后，Thread 变化仍须查询中心并可继续 pending', async () => {
  const backend = new LocalWaitBackend()
  backend.waitUntil = 60_000
  backend.completeAt = 28_000
  const notifications = [
    { at: 1_000, thread_id: 'other-thread', version: 99 },
    { at: 2_000, thread_id: 'exec-thread-1', version: 7 },
    { at: 3_000, thread_id: 'exec-thread-1', version: 8 },
    { at: 4_000, thread_id: 'exec-thread-1', version: 8 },
    { at: 5_000, thread_id: 'exec-thread-1', version: 6 },
    { at: 6_000, thread_id: 'other-thread', version: 100 },
  ]
  backend.onPoll = async ({ payload }) => {
    // 模拟节点过滤通知后的 IPC 边界，Runtime 只收到目标 Thread 的新版本。
    const until = backend.now + payload.wait_ms
    while (notifications.length && notifications[0].at <= until) {
      const notification = notifications.shift()!
      backend.now = notification.at
      if (notification.thread_id === payload.thread_id && notification.version > payload.after_version) {
        backend.threadVersion = notification.version
        return { reason: 'thread_changed', version: notification.version }
      }
    }
    backend.now = until
    return { reason: 'timeout' }
  }
  await setup(backend, execResponses()).runtime.start()
  assert.deepEqual(backend.waitTimes(), [0, 3_000, 28_000])
  assert.deepEqual(
    backend.threadPolls().map(({ request }) => request.payload.after_version),
    [7, 8],
  )
  assert.equal(backend.events.filter((event) => event.kind === 'tool_result').length, 1)
  assert.deepEqual(backend.sleeps, [])
})

test('丢失完成通知后在下个 25 秒周期补读终态', async () => {
  const backend = new LocalWaitBackend()
  backend.waitUntil = 60_000
  backend.completeAt = 26_000
  await setup(backend, execResponses()).runtime.start()
  assert.deepEqual(backend.waitTimes(), [0, 25_000, 50_000])
  assert.equal(backend.threadPolls().length, 2)
})

test('首次请求延迟 1 秒、后续查询耗时 1ms 时重新同步预算并限制 30 秒等待的请求数', async () => {
  for (const [local, center] of [
    [1, 1],
    [undefined, 1],
    [1, undefined],
  ]) {
    const backend = new LocalWaitBackend()
    backend.localProtocol = local
    backend.centerProtocol = center
    // 中心在首次请求到达时建立 30 秒期限，此后保持不变。
    backend.waitUntil = backend.completeAt = 31_000
    let nodeDeadline = Infinity
    backend.onPoll = async ({ payload }) => {
      backend.now += Math.max(0, Math.min(payload.wait_ms, nodeDeadline - backend.now))
      return { reason: 'timeout' }
    }
    const call = backend.call.bind(backend)
    backend.call = async (request) => {
      const started = backend.now
      if (request.operation === 'call_tool') backend.now += 1_000
      if (request.operation === 'wait_tool') backend.now += 1
      const response = await call(request)
      if (response?.pending && response.wait_protocol === 1) nodeDeadline = started + response.wait_remaining_ms
      return response
    }
    await setup(backend, execResponses()).runtime.start()
    assert.ok(backend.waitTimes().at(-1)! >= backend.waitUntil)
    assert.ok(backend.waits.every((request) => !request.payload))
    assert.equal(backend.effects, 1)
    if (local === 1 && center === 1) {
      assert.ok(backend.waits.length <= 6, `状态查询次数过多: ${backend.waits.length}`)
      assert.deepEqual(
        backend.threadPolls().map(({ request }) => request.payload.wait_ms),
        [25_000, 4_997],
      )
      assert.deepEqual(backend.sleeps, [])
    } else {
      assert.equal(backend.threadPolls().length, 0)
      assert.equal(backend.waits.length, 121)
      assert.equal(backend.sleeps.length, 120)
      assert.ok(backend.sleeps.every((ms) => ms === 250))
    }
  }
})

test('本地预算已耗尽而中心仍 pending 时每次退避 250ms，由中心裁决结果', async () => {
  for (const local of [1, undefined]) {
    const backend = new LocalWaitBackend()
    backend.localProtocol = local
    backend.remaining = () => 0
    backend.completeAt = 500
    await setup(backend, execResponses()).runtime.start()
    assert.deepEqual(backend.waitTimes(), [0, 250, 500])
    assert.equal(backend.threadPolls().length, 0)
    assert.deepEqual(backend.sleeps, [250, 250])
    assert.ok(backend.waits.every((request) => !request.payload))
  }
})

test('预算耗尽后的退避受剩余运行预算限制，到期使用 finish_wait', async () => {
  const backend = new LocalWaitBackend()
  backend.remaining = () => 0
  backend.completeAt = Infinity
  const call = backend.call.bind(backend)
  backend.call = async (request) => {
    const response = await call(request)
    if (request.operation === 'call_tool') backend.now = RUN_MS - 100
    return response
  }
  const fixture = setup(backend, execResponses())
  await fixture.runtime.start()
  assert.equal(backend.now, RUN_MS)
  assert.deepEqual(backend.sleeps, [100])
  assert.equal(backend.threadPolls().length, 0)
  assert.deepEqual(
    backend.waits.map((request) => request.payload),
    [undefined, { finish_wait: true }],
  )
  assert.equal(fixture.faux.state.callCount, 1)
  assert.deepEqual(backend.requests.at(-1)?.request, { operation: 'finish', last_seq: 3, reason: 'run_limit' })
})

test('pending 响应在调用和后续查询时均校验 Thread、版本和剩余预算', async () => {
  for (const phase of ['call_tool', 'wait_tool']) {
    for (const fields of [
      { thread_id: undefined },
      { thread_id: '' },
      { thread_id: 1 },
      { version: undefined },
      { version: -1 },
      { version: 0.5 },
      { version: '7' },
      { version: Infinity },
      { version: NaN },
      { version: Number.MAX_SAFE_INTEGER + 1 },
      { wait_remaining_ms: -1 },
      { wait_remaining_ms: 0.5 },
      { wait_remaining_ms: undefined },
      { wait_remaining_ms: Infinity },
      { wait_remaining_ms: NaN },
      { wait_remaining_ms: '30' },
      { wait_remaining_ms: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      const backend = new LocalWaitBackend()
      const call = backend.call.bind(backend)
      backend.call = async (request) => {
        const response = await call(request)
        return request.operation === phase && response?.pending ? { ...response, ...fields } : response
      }
      await assert.rejects(setup(backend, execResponses()).runtime.start(), { code: 'invalid_tool_result' })
      assert.equal(backend.waits.length, phase === 'call_tool' ? 0 : 1)
      assert.equal(backend.threadPolls().length, 0)
      assert.equal(backend.events.at(-1)?.kind, 'assistant')
    }
  }
})

test('未声明等待协议的 pending 仍要求非空 Thread ID', async () => {
  for (const thread_id of [undefined, '', 1]) {
    const backend = new ExecBackend()
    const call = backend.call.bind(backend)
    backend.call = async (request) => {
      const response = await call(request)
      return response?.pending ? { ...response, thread_id } : response
    }
    await assert.rejects(setup(backend, execResponses()).runtime.start(), { code: 'invalid_tool_result' })
    assert.equal(backend.waits.length, 0)
  }
})

test('只有 nodes.exec 可以返回 pending', async () => {
  const backend = new Backend()
  const call = backend.call.bind(backend)
  backend.call = async (request) =>
    request.operation === 'call_tool'
      ? { pending: true, thread_id: 'thread-1', version: 0, wait_remaining_ms: 30_000, wait_protocol: 1 }
      : call(request)
  await assert.rejects(setup(backend).runtime.start(), { code: 'invalid_tool_result' })
  assert.equal(backend.events.at(-1)?.kind, 'assistant')
})

test('Thread 版本允许为零，亚毫秒运行预算将本地等待取整为 1ms', async () => {
  const backend = new LocalWaitBackend()
  backend.threadVersion = 0
  backend.remaining = () => 60_000
  backend.completeAt = Infinity
  backend.waitUntil = RUN_MS + 60_000
  const call = backend.call.bind(backend)
  backend.call = async (request) => {
    const response = await call(request)
    if (request.operation === 'call_tool') backend.now = RUN_MS - 0.5
    return response
  }
  await setup(backend, execResponses()).runtime.start()
  assert.deepEqual(
    backend.threadPolls().map(({ request }) => request.payload),
    [{ thread_id: 'exec-thread-1', after_version: 0, wait_ms: 1 }],
  )
  assert.deepEqual(backend.waits.at(-1).payload, { finish_wait: true })
})

test('本地新协议在运行期限保存当前状态，恢复和普通执行均停止后续工具与模型', async () => {
  for (const recovery of [false, true]) {
    const backend = new LocalWaitBackend()
    backend.completeAt = Infinity
    backend.waitUntil = RUN_MS + 60_000
    const message = fauxAssistantMessage([execCall(), fauxToolCall('devices.list', {}, { id: 'later-tool' })])
    if (recovery) {
      backend.queue = false
      backend.events.push(input(), { seq: 2, kind: 'assistant', payload: { format: 'pi-ai/1', message } })
    }
    const call = backend.call.bind(backend)
    backend.call = async (request) => {
      const result = await call(request)
      if (request.operation === 'call_tool') backend.now = RUN_MS - 100
      return result
    }
    const fixture = setup(backend, [() => message])
    await fixture.runtime.start()
    assert.equal(backend.now, RUN_MS)
    assert.deepEqual(
      backend.threadPolls().map(({ request }) => request.payload.wait_ms),
      [100],
    )
    assert.deepEqual(
      backend.waits.map((request) => request.payload),
      [undefined, { finish_wait: true }],
    )
    assert.equal(backend.effects, 1)
    assert.equal(fixture.faux.state.callCount, recovery ? 0 : 1)
    assert.deepEqual(backend.requests.at(-1)?.request, { operation: 'finish', last_seq: 3, reason: 'run_limit' })
    assert.ok(!backend.calls.includes('threads.stop'))
  }
})

test('运行期限已到或状态请求跨过期限时跳过本地等待并保留 finish_wait', async () => {
  for (const phase of ['call_tool', 'wait_tool']) {
    const backend = new LocalWaitBackend()
    backend.completeAt = Infinity
    const call = backend.call.bind(backend)
    backend.call = async (request) => {
      const result = await call(request)
      if (request.operation === phase) backend.now = RUN_MS
      return result
    }
    const fixture = setup(backend, execResponses())
    await fixture.runtime.start()
    assert.equal(backend.threadPolls().length, 0)
    assert.deepEqual(backend.waits.at(-1).payload, { finish_wait: true })
    assert.equal(fixture.faux.state.callCount, 1)
  }
})

test('Thread 变化通知可无 version，停止结果由中心保存后返回模型', async () => {
  const backend = new LocalWaitBackend()
  backend.completeAt = 1_000
  backend.resultStatus = 'stopped'
  backend.onPoll = async () => {
    backend.now += 1_000
    return { reason: 'thread_changed' }
  }
  const fixture = setup(backend, execResponses())
  await fixture.runtime.start()
  assert.deepEqual(backend.waitTimes(), [0, 1_000])
  assert.match(backend.events.find((event) => event.kind === 'tool_result')!.payload.message.content[0].text, /stopped/)
  assert.equal(fixture.faux.state.callCount, 2)
})
test('等待被停止或租约丢失时直接退出，不写工具结果或 finish', async () => {
  for (const phase of ['poll_wake', 'wait_tool']) {
    const backend = new LocalWaitBackend()
    const call = backend.call.bind(backend)
    backend.call = async (request) => {
      if (request.operation === phase && (phase === 'poll_wake' || backend.threadPolls().length > 0))
        throw new RuntimeError(phase === 'poll_wake' ? 'aborted' : 'lease_lost')
      return call(request)
    }
    await assert.rejects(setup(backend, execResponses()).runtime.start(), {
      code: phase === 'poll_wake' ? 'aborted' : 'lease_lost',
    })
    assert.equal(backend.events.at(-1)?.kind, 'assistant')
    assert.ok(!backend.calls.includes('finish'))
    assert.ok(!backend.calls.includes('threads.stop'))
  }
})

test('nodes.exec 工具声明等待范围、默认时限和执行权限', () => {
  const definition = toolDefinitions.find((tool) => tool.name === 'nodes.exec')!
  const properties = definition.parameters.properties
  assert.equal(properties.wait_seconds.minimum, 0)
  assert.equal(properties.wait_seconds.maximum, 600)
  assert.equal(properties.wait_seconds.default, 30)
  assert.equal(properties.timeout_seconds.default, 7200)
  assert.match(definition.description, /开发工作优先派发给执行 Agent/)
  assert.match(definition.description, /不检查命令内容，也不提供沙箱/)
  const messages = modelMessages(new Backend().boot(), [])
  assert.ok(typeof messages[0].content === 'string')
  assert.match(messages[0].content, /通过 nodes.exec 管理环境/)
  assert.match(messages[0].content, /退出 Runtime 不停止已开启的 Thread/)
  assert.match(messages[0].content, /不向用户已停止或归档的 Thread 继续发消息，除非用户在对话里要求/)
  assert.match(definition.description, /结果可用 threads.read 查询/)
})

test('nodes.exec pending 期间轮询，结果保存后继续模型', async () => {
  const backend = new ExecBackend()
  const fixture = setup(backend, [() => fauxAssistantMessage([execCall()]), () => assistant()])
  await fixture.runtime.start()
  assert.equal(backend.effects, 1)
  assert.equal(backend.waits.length, 3)
  assert.equal(backend.events.filter((event) => event.kind === 'tool_result').length, 1)
  assert.equal(fixture.faux.state.callCount, 2)
  assert.equal(backend.now, 500 + IDLE_MS)
  assert.ok(backend.waits.every((request) => request.last_seq === 2 && !request.payload))
})

test('等待时到达运行上限立即保存仍在执行结果，不再调用模型', async () => {
  for (const recovery of [false, true]) {
    const backend = new ExecBackend()
    backend.pendingCount = Infinity
    if (recovery) {
      backend.queue = false
      backend.events.push(input(), {
        seq: 2,
        kind: 'assistant',
        payload: {
          format: 'pi-ai/1',
          message: fauxAssistantMessage([execCall(), fauxToolCall('devices.list', {}, { id: 'later-tool' })]),
        },
      })
      const original = backend.call.bind(backend)
      backend.call = async (request) => {
        const result = await original(request)
        if (request.operation === 'call_tool') backend.now = RUN_MS - 100
        return result
      }
    }
    const fixture = setup(backend, [
      () => {
        backend.now = RUN_MS - 100
        return fauxAssistantMessage([execCall(), fauxToolCall('devices.list', {}, { id: 'later-tool' })])
      },
    ])
    await fixture.runtime.start()
    assert.equal(backend.now, RUN_MS)
    assert.equal(backend.effects, 1)
    assert.equal(fixture.faux.state.callCount, recovery ? 0 : 1)
    assert.equal(backend.waits.length, 2)
    assert.deepEqual(backend.waits[1].payload, { finish_wait: true })
    assert.equal(backend.events.at(-1)?.kind, 'tool_result')
    assert.match(backend.events.at(-1)?.payload.message.content[0].text, /running/)
    assert.equal(backend.calls.at(-1), 'finish')
    assert.ok(!backend.calls.includes('threads.stop'))
  }
})

for (const crashPoint of ['wait_tool', 'poll_wake']) {
  test(`等待期间在 ${crashPoint} 杀掉实际 Runtime 进程，恢复使用原调用 ID 和 Thread`, async () => {
    const backend = new LocalWaitBackend()
    backend.pendingCount = 2
    backend.completeAt = Infinity
    for (const crash of [true, false]) {
      const child = spawn(process.execPath, ['--import', 'tsx', 'test/worker.ts'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, BATON_TEST_PROJECT_EXEC: '1' },
      })
      let stderr = ''
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      const exited = once(child, 'exit')
      for await (const raw of frames(child.stdout)) {
        const frame = raw as any
        const data = await backend.call(frame.request)
        await writeFrame(child.stdin, { id: frame.id, result: { type: 'project_runtime.result', ok: true, data } })
        if (crash && frame.request.operation === crashPoint) {
          child.kill('SIGKILL')
          break
        }
      }
      child.stdin.end()
      const [code] = await exited
      if (!crash) assert.equal(code, 0, stderr)
    }
    assert.equal(backend.effects, 1)
    assert.equal(backend.calls.filter((operation) => operation === 'call_tool').length, 2)
    assert.equal(backend.events.filter((event) => event.kind === 'tool_result').length, 1)
    assert.deepEqual(
      backend.waits.map((request) => request.tool_call_id),
      ['exec-1', 'exec-1', 'exec-1'],
    )
    assert.ok(backend.threadPolls().length > 0)
    assert.equal(backend.events.at(-1)?.kind, 'assistant')
  })
}

test('faux 恢复结尾表的四种情况和部分工具结果', async () => {
  for (const ending of ['assistant', 'pending', 'input', 'tool_result', 'compaction', 'partial']) {
    const b = new Backend()
    b.queue = false
    if (ending !== 'compaction') b.events.push(input())
    if (['assistant', 'pending', 'tool_result', 'partial'].includes(ending))
      b.events.push({
        seq: 2,
        kind: 'assistant',
        payload: {
          format: 'pi-ai/1',
          message: assistant(ending !== 'assistant'),
        },
      })
    if (ending === 'tool_result' || ending === 'partial') {
      await b.call({
        operation: 'call_tool',
        last_seq: 2,
        tool_call_id: 'create-1',
        tool_name: 'threads.create',
      })
      if (ending === 'partial')
        b.events[1].payload.message.content.push(fauxToolCall('devices.list', {}, { id: 'devices-2' }))
    }
    if (ending === 'compaction') {
      const compact = {
        seq: 1,
        kind: 'compaction' as const,
        payload: { through_seq: 0, summary: '摘要', memory_index: '' },
      }
      b.events.push(compact)
      const boot = b.boot.bind(b)
      b.boot = () => ({ ...boot(), compaction: compact })
    }
    const s = setup(b, [() => assistant()])
    await s.runtime.start()
    assert.equal(b.effects, ending === 'partial' ? 2 : ['pending', 'tool_result'].includes(ending) ? 1 : 0, ending)
    assert.equal(
      s.faux.state.callCount,
      ['pending', 'input', 'tool_result', 'partial'].includes(ending) ? 1 : 0,
      ending,
    )
    assert.equal(
      new Set(b.events.filter((e) => e.kind === 'tool_result').map((e) => e.payload.message.toolCallId)).size,
      b.effects,
    )
    assert.equal(b.now, IDLE_MS)
  }
})

for (const threadTool of ['threads.create', 'threads.send']) {
  for (const point of ['append-before', 'append-after', 'tool-before', 'tool-after', 'result-after']) {
    test(`${threadTool} 在 ${point} 杀掉实际子进程，恢复不重复执行副作用`, async () => {
      const b = new Backend()
      let killed = false
      async function run(crash: boolean) {
        const child = spawn(process.execPath, ['--import', 'tsx', 'test/worker.ts'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, BATON_TEST_PROJECT_THREAD_TOOL: threadTool },
        })
        let stderr = ''
        child.stderr.on('data', (value) => {
          stderr += value
        })
        const exited = once(child, 'exit')
        try {
          for await (const raw of frames(child.stdout)) {
            const frame = raw as any,
              op = frame.request.operation
            const matches =
              (op === 'append_event' && point.startsWith('append')) ||
              (op === 'call_tool' && !point.startsWith('append'))
            if (crash && matches && !killed && point.endsWith('before')) {
              killed = true
              child.kill('SIGKILL')
              break
            }
            const data = await b.call(frame.request)
            if (crash && matches && !killed && point.endsWith('after') && point !== 'result-after') {
              killed = true
              child.kill('SIGKILL')
              break
            }
            await writeFrame(child.stdin, {
              id: frame.id,
              result: { type: 'project_runtime.result', ok: true, data },
            })
            if (crash && matches && !killed && point === 'result-after') {
              killed = true
              child.kill('SIGKILL')
              break
            }
          }
        } finally {
          child.stdin.end()
        }
        const [code] = await exited
        if (!crash) assert.equal(code, 0, stderr)
      }
      await run(true)
      assert.equal(killed, true, point)
      await run(false)
      assert.equal(b.effects, 1, point)
      assert.equal(b.events.find((event) => event.kind === 'tool_result')?.payload.message.toolName, threadTool)
      assert.equal(b.events.filter((e) => e.kind === 'tool_result').length, 1, point)
      assert.equal(b.events.at(-1)?.kind, 'assistant')
      assert.deepEqual(
        b.events.map((e) => e.seq),
        b.events.map((_, i) => i + 1),
      )
    })
  }
}

test('写入屏障失败后停止，不调用工具', async () => {
  const b = new Backend()
  b.failAt = 'append_event'
  const s = setup(b)
  await assert.rejects(s.runtime.start())
  assert.equal(b.effects, 0)
  assert.equal(b.events.length, 1)
})

test('模型失败按 5、15、45 秒重试，失败输出不保存', async () => {
  const b = new Backend()
  const error = () =>
    fauxAssistantMessage('错误中包含工具', {
      stopReason: 'error',
      errorMessage: 'temporary',
    })
  const s = setup(b, [error, error, error, error])
  await s.runtime.start()
  assert.equal(s.faux.state.callCount, 4)
  assert.equal(
    b.now,
    RETRIES.reduce((a, b) => a + b, 0),
  )
  assert.equal(b.calls.at(-1), 'report_failure')
  assert.equal(b.events.length, 1)
})

test('超限输出按请求失败处理，工具不执行', async () => {
  const b = new Backend()
  const huge = () => fauxAssistantMessage('x'.repeat(170 * 1024))
  const s = setup(b, [huge, huge, huge, huge])
  await s.runtime.start()
  assert.equal(b.effects, 0)
  assert.equal(b.events.length, 1)
  assert.equal(b.calls.at(-1), 'report_failure')
})

test('15 分钟上限处理完当前轮次，不领取下一轮也不停止 Thread', async () => {
  const b = new Backend()
  const s = setup(b, [
    () => {
      b.now = RUN_MS
      return assistant(true)
    },
    () => {
      b.now += 1000
      return assistant()
    },
  ])
  await s.runtime.start()
  assert.equal(b.effects, 1)
  assert.equal(b.calls.filter((c) => c === 'claim_inputs').length, 1)
  assert.equal(b.calls.at(-1), 'finish')
  assert.equal(b.events.at(-1)?.kind, 'assistant')
  assert.ok(!b.calls.includes('threads.stop'))
})

test('分页历史、jsonb 键顺序、进程切换保持实际模型请求一致', async () => {
  const b = new Backend()
  b.queue = false
  const snapshot = Array.from({ length: 21 }, (_, i) =>
    i % 2 === 0
      ? { ...input(), seq: i + 1 }
      : {
          seq: i + 1,
          kind: 'assistant' as const,
          payload: {
            format: 'pi-ai/1',
            message: {
              ...fauxAssistantMessage(
                [
                  {
                    type: 'thinking',
                    thinking: '分析',
                    thinkingSignature: 'signed-provider-data',
                  },
                  { type: 'text', text: '历史记录'.repeat(10_000) },
                ],
                { timestamp: 100 + i },
              ),
              providerExtension: { signature: 'opaque-data' },
            },
          },
        },
  )
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) > 1024 * 1024)
  b.events = structuredClone(snapshot)
  const first = setup(b, [() => assistant()])
  await first.runtime.start()
  // 每次请求读取同一中心快照；反转对象键模拟 jsonb 和另一设备的读取顺序。
  const reverse = (x: any): any =>
    Array.isArray(x)
      ? x.map(reverse)
      : x && typeof x === 'object'
        ? Object.fromEntries(
            Object.entries(x)
              .reverse()
              .map(([k, v]) => [k, reverse(v)]),
          )
        : x
  const frozen = new Backend()
  frozen.queue = false
  frozen.events = reverse(snapshot)
  frozen.pageSize = 1
  const second = setup(frozen, [() => assistant()])
  await second.runtime.start()
  assert.deepEqual(first.requests, second.requests)
  assert.equal(first.requests[0].maxTokens, 32000)
  assert.equal(first.requests[0].sessionId, 'conversation-stable')
  assert.equal(first.requests[0].maxRetries, 0)
  const bytes = JSON.stringify(canonical(first.requests[0]))
  const hash = createHash('sha256').update(bytes).digest('hex')
  if (process.env.BATON_UPDATE_REQUEST_FIXTURE) writeFileSync('test/request.sha256', hash + '\n')
  assert.equal(hash, readFileSync('test/request.sha256', 'utf8').trim())
  if (process.env.BATON_REQUEST_ARTIFACT) writeFileSync(process.env.BATON_REQUEST_ARTIFACT, bytes)
})

test('已保存的提示词快照跨标题变更保持稳定，未知版本拒绝', () => {
  const b = new Backend(),
    boot = b.boot()
  const events = [
    input(),
    {
      seq: 2,
      kind: 'assistant' as const,
      payload: {
        format: 'pi-ai/1',
        message: assistant(),
        prompt: {
          version: '1',
          title: boot.project.title,
          goal: boot.project.goal,
        },
      },
    },
  ]
  const before = modelMessages(boot, events)
  boot.project.title = '新标题'
  assert.deepEqual(before, modelMessages(boot, events))
  boot.prompt_version = '99'
  assert.throws(() => modelMessages(boot, []))
})

test('记忆变化只替换读到旧版本的记忆工具结果，摘要保留，记忆块位于本批输入之前', () => {
  const b = new Backend(),
    boot = b.boot()
  boot.compaction = {
    seq: 1,
    kind: 'compaction',
    payload: { through_seq: 0, summary: '已确认部署目录。', cleared_tool_result_seqs: [], memory_index: '' },
  }
  const recall = (seq: number, id: string, revision: number, mode = 'current'): Event => ({
    seq,
    kind: 'tool_result',
    payload: {
      format: 'pi-ai/1',
      derived: true,
      memory_refs: [{ item_id: id, revision, mode }],
      message: {
        role: 'toolResult',
        toolCallId: `call-${seq}`,
        toolName: 'memory.recall',
        content: [{ type: 'text', text: `结果 ${seq}` }],
        isError: false,
        timestamp: 0,
      },
    },
  })
  const call = (seq: number): Event => ({
    seq,
    kind: 'assistant',
    payload: {
      format: 'pi-ai/1',
      message: fauxAssistantMessage([fauxToolCall('memory.recall', { query: 'deploy' }, { id: `call-${seq + 1}` })]),
    },
  })
  const later: Event = { ...input(), seq: 8 }
  const events = [
    { ...input(), seq: 2 },
    call(3),
    recall(4, 'a', 1),
    call(5),
    recall(6, 'b', 1, 'history'),
    call(7),
    later,
  ]
  const text = (messages: ReturnType<typeof modelMessages>) => JSON.stringify(messages)
  const fresh = modelMessages(boot, events, {
    view_refs: [{ item_id: 'a', revision: 1 }],
    content: '记忆块',
    input_seq: 8,
  })
  assert.match(text(fresh), /已确认部署目录/)
  assert.match(text(fresh), /结果 4/)
  const last = fresh.at(-1) as { content: { text: string }[] }
  assert.deepEqual(
    last.content.map((c) => c.text),
    ['记忆块', '请开启 Thread 并验证结果'],
  )
  const stale = modelMessages(boot, events, { view_refs: [], content: '记忆块', input_seq: 8 })
  assert.match(text(stale), /已确认部署目录/)
  assert.doesNotMatch(text(stale), /结果 4/)
  assert.match(text(stale), /结果 6/)
  assert.deepEqual(fresh.slice(0, 3), stale.slice(0, 3))
})

test('模型文本先形成临时预览，完整回复保存后才进入历史', async () => {
  const b = new Backend()
  const previews: any[] = []
  const call = b.call.bind(b)
  b.call = async (req: any) => {
    if (req.operation === 'preview') {
      previews.push(structuredClone(req))
      assert.equal(b.events.at(-1)?.kind, 'input')
    }
    return call(req)
  }
  await setup(b, [() => fauxAssistantMessage('临时文本与完整回复')]).runtime.start()
  assert.ok(previews.some((p) => p.payload.text.length > 0))
  assert.equal(previews[0].last_seq, 1)
  assert.equal(b.events.length, 2)
  assert.equal(b.events[1].kind, 'assistant')
  assert.equal(b.effects, 0)
})

test('Thread 工具按 assistant 中的顺序保存参数和结果，再继续模型', async () => {
  const backend = new Backend()
  const calls = [
    fauxToolCall(
      'threads.create',
      {
        node_id: 'node-b',
        agent_type: 'pi',
        working_directory: '/repo',
        message: '修复登录并运行测试',
        model: 'model-a',
        execution_timeout_seconds: 600,
      },
      { id: 'create' },
    ),
    fauxToolCall('threads.send', { thread_id: 'thread-1', message: '继续', model: 'model-b' }, { id: 'send' }),
    fauxToolCall('threads.send', { thread_id: 'thread-1', message: '调整目标', mode: 'steer' }, { id: 'steer' }),
    fauxToolCall('threads.stop', { thread_id: 'thread-1' }, { id: 'stop' }),
    fauxToolCall('threads.archive', { thread_id: 'thread-1' }, { id: 'archive' }),
    fauxToolCall('threads.list', { status: 'archived', after_id: 'thread-0', max_bytes: 1024 }, { id: 'list' }),
    fauxToolCall('threads.get', { thread_id: 'thread-1', offset: 0 }, { id: 'get' }),
    fauxToolCall(
      'threads.read',
      { thread_id: 'thread-1', after_turn: 0, through_turn: 2, offset: 0, max_bytes: 1024 },
      { id: 'read' },
    ),
  ]
  const requests: any[] = []
  const call = backend.call.bind(backend)
  backend.call = async (request) => {
    if (request.operation === 'call_tool') requests.push(structuredClone(request))
    return call(request)
  }
  const fixture = setup(backend, [
    () => fauxAssistantMessage(calls),
    (context: any) => {
      const results = context.messages.filter((message: any) => message.role === 'toolResult')
      assert.deepEqual(
        results.map((message: any) => message.toolCallId),
        calls.map((call) => call.id),
      )
      return assistant()
    },
  ])
  await fixture.runtime.start()
  assert.deepEqual(
    requests.map((request) => ({
      id: request.tool_call_id,
      name: request.tool_name,
      arguments: request.arguments,
    })),
    calls.map(({ id, name, arguments: args }) => ({ id, name, arguments: args })),
  )
  assert.deepEqual(
    requests.map((request) => request.last_seq),
    calls.map((_, i) => i + 2),
  )
  assert.equal(backend.effects, calls.length)
  assert.equal(fixture.faux.state.callCount, 2)
})
