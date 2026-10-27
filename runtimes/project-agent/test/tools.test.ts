import { test } from 'vitest'
import assert from 'node:assert/strict'
import { fauxToolCall, validateToolCall } from '@earendil-works/pi-ai'
import { toolDefinitions } from '../src/tools.js'

const validate = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  validateToolCall(toolDefinitions, fauxToolCall(name, args))

const create = {
  node_id: 'node-b',
  agent_type: 'pi',
  working_directory: '/repo',
  message: '修复登录并运行测试',
}
const ask = {
  title: '请决定',
  content: '[详情](https://example.org)',
  options: [{ id: 'go', label: '继续', recommended: true }],
  allow_text: true,
}

test('Inbox 工具允许超过五个选项并保留数量预算', () => {
  const options = Array.from({ length: 50 }, (_, index) => ({ id: `option-${index}`, label: `选项 ${index}` }))
  assert.deepEqual(validate('inbox.ask', { ...ask, options }), { ...ask, options })
  assert.throws(() => validate('inbox.ask', { ...ask, options: [...options, { id: 'extra', label: '更多' }] }))
})

test('固定工具顺序与 Thread、Inbox 契约一致', () => {
  assert.deepEqual(
    toolDefinitions.map((tool) => tool.name),
    [
      'memory.recall',
      'memory.read',
      'memory.remember',
      'memory.correct',
      'memory.retire',
      'memory.restore',
      'history.search',
      'history.read',
      'devices.list',
      'threads.create',
      'threads.send',
      'threads.withdraw',
      'threads.resume',
      'threads.stop',
      'threads.archive',
      'threads.list',
      'threads.get',
      'threads.read',
      'threads.trace',
      'nodes.exec',
      'inbox.ask',
      'inbox.list',
      'inbox.get',
      'inbox.withdraw',
    ],
  )
  for (const [name, args] of [
    ['threads.create', create],
    ['threads.create', { ...create, execution_timeout_seconds: 1 }],
    ['threads.create', { ...create, model: 'model-a' }],
    ['threads.send', { thread_id: 'thread-1', message: '继续', model: 'model-b' }],
    ['threads.send', { thread_id: 'thread-1', message: '继续' }],
    ['threads.send', { thread_id: 'thread-1', message: '继续', mode: 'queue' }],
    ['threads.send', { thread_id: 'thread-1', message: '调整目标', mode: 'steer' }],
    ['threads.stop', { thread_id: 'thread-1' }],
    ['threads.archive', { thread_id: 'thread-1' }],
    ['threads.list', { status: 'running', after_id: 'thread-1', offset: 0, max_bytes: 32768 }],
    ['threads.get', { thread_id: 'thread-1', offset: 0, max_bytes: 1 }],
    ['threads.read', { thread_id: 'thread-1', after_turn: 0, through_turn: 1, offset: 0, max_bytes: 32768 }],
    ['threads.trace', { thread_id: 'thread-1', worker_turn_seq: 1 }],
    ['threads.trace', { thread_id: 'thread-1', worker_turn_seq: 1, cursor: 'page-2', offset: 1, max_bytes: 32768 }],
    ['inbox.ask', ask],
    ['inbox.ask', { ...ask, thread_id: 'thread-1' }],
  ] as const) {
    assert.deepEqual(validate(name, args), args)
  }
})

test('Thread 工具拒绝旧参数、缺少必填字段及无效模式和读取范围', () => {
  for (const [name, args] of [
    ['threads.create', { ...create, target_node_id: 'node-b' }],
    ['threads.create', { node_id: 'node-b', agent_type: 'pi', working_directory: '/repo' }],
    ['threads.create', { ...create, execution_timeout_seconds: 0 }],
    ['threads.create', { ...create, model: {} }],
    ['threads.send', { thread_id: 'thread-1', message: '继续', model: {} }],
    ['threads.send', { thread_id: 'thread-1', message: '继续', mode: 'insert' }],
    ['threads.stop', {}],
    ['threads.archive', { task_id: 'task-1' }],
    ['threads.get', { thread_id: 'thread-1', version: 1 }],
    ['threads.read', { thread_id: 'thread-1', after_turn: -1 }],
    ['threads.read', { thread_id: 'thread-1', through_turn: 0 }],
    ['threads.read', { thread_id: 'thread-1', max_bytes: 32769 }],
    ['threads.trace', { thread_id: 'thread-1' }],
    ['threads.trace', { thread_id: 'thread-1', worker_turn_seq: 0 }],
    ['threads.trace', { thread_id: 'thread-1', worker_turn_seq: 1, max_bytes: 32769 }],
    ['threads.trace', { thread_id: 'thread-1', worker_turn_seq: 1, employee_id: 'other' }],
    ['inbox.ask', { ...ask, summary: '旧摘要' }],
    ['inbox.ask', { ...ask, task_id: 'task-1' }],
  ] as const) {
    assert.throws(() => validate(name, args), name)
  }
})
