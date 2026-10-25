import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fauxAssistantMessage, fauxToolCall, validateToolCall } from '@earendil-works/pi-ai'
import { toolDefinitions } from '../src/tools.js'
import { Backend, setup, assistant } from './fixture.js'

const validate = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  validateToolCall(toolDefinitions, fauxToolCall(name, args))

test('Thread 撤回与恢复工具校验必填参数并拒绝额外身份字段', () => {
  const withdraw = { thread_id: 'thread-1', message_id: 'message-1' }
  const resume = { thread_id: 'thread-1' }
  assert.deepEqual(validate('threads.withdraw', withdraw), withdraw)
  assert.deepEqual(validate('threads.resume', resume), resume)
  assert.throws(() => validate('threads.withdraw', { thread_id: 'thread-1' }))
  assert.throws(() => validate('threads.withdraw', { ...withdraw, project_id: 'other' }))
  assert.throws(() => validate('threads.resume', {}))
  assert.throws(() => validate('threads.resume', { ...resume, employee_id: 'other' }))
})

for (const name of ['threads.withdraw', 'threads.resume', 'threads.trace'])
  test(`${name} 从模型名称转换后保存调用与结果`, async () => {
    const backend = new Backend()
    const args: Parameters<typeof fauxToolCall>[1] =
      name === 'threads.withdraw'
        ? { thread_id: 'thread-1', message_id: 'message-1' }
        : name === 'threads.trace'
          ? { thread_id: 'thread-1', worker_turn_seq: 1 }
          : { thread_id: 'thread-1' }
    const { runtime } = setup(backend, [
      fauxAssistantMessage([fauxToolCall(name.replaceAll('.', '_'), args, { id: 'control-1' })]),
      assistant(),
    ])
    await runtime.start()
    assert.equal(backend.effects, 1)
    assert.ok(backend.calls.includes('finish'))
    assert.ok(!backend.calls.includes('report_failure'))
    const saved = backend.events.find((event) => event.kind === 'assistant')
    const result = backend.events.find((event) => event.kind === 'tool_result')
    assert.equal(saved?.payload.message.content[0].name, name)
    assert.deepEqual(saved?.payload.message.content[0].arguments, args)
    assert.equal(result?.payload.message.toolName, name)
  })
