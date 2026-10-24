import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import { Backend, setup, assistant } from './fixture.js'
import { toolDefinitions } from '../src/tools.js'
import { modelContext, batonMessage } from '../src/tool-names.js'

test('转换覆盖工具声明、移除、历史调用与结果，保留参数、ID、签名和原始对象', () => {
  const response = fauxAssistantMessage([
    fauxToolCall('memory.search', { query: 'memory.search' }, { id: 'stable-call' }),
  ])
  const context: any = {
    messages: [
      {
        role: 'system',
        content: 'Instructions',
        toolsAdded: toolDefinitions,
        toolsRemoved: [{ name: 'memory.read' }],
        timestamp: 0,
      },
      {
        ...response,
        content: [
          ...response.content,
          {
            type: 'thinking',
            thinking: 'private reasoning',
            thinkingSignature: 'fixture-signature',
          },
        ],
      },
      {
        role: 'toolResult',
        toolName: 'memory.search',
        toolCallId: 'stable-call',
        content: [{ type: 'text', text: 'memory.search' }],
        isError: false,
        timestamp: 0,
      },
    ],
  }
  const before = structuredClone(context)
  const converted = modelContext(context)
  assert.equal(converted.messages[0].toolsRemoved[0].name, 'memory_read')
  assert.equal(converted.messages[1].content[0].name, 'memory_search')
  assert.equal(converted.messages[1].content[0].id, 'stable-call')
  assert.equal(converted.messages[1].content[0].arguments.query, 'memory.search')
  assert.deepEqual(converted.messages[1].content[1], before.messages[1].content[1])
  assert.equal(converted.messages[2].toolName, 'memory_search')
  assert.equal(converted.messages[2].content[0].text, 'memory.search')
  assert.deepEqual(batonMessage(converted.messages[1]), before.messages[1])
  assert.deepEqual(context, before)
  const unknown = fauxAssistantMessage([fauxToolCall('unknown_tool', {})])
  assert.equal((batonMessage(unknown).content[0] as any).name, 'unknown_tool')
})

test('实际模型请求的工具名符合 provider 约束，回复恢复为 Baton 工具名后保存和执行', async () => {
  const backend = new Backend()
  const fixture = setup(backend, [
    (context: any) => {
      const tools = context.messages.flatMap((message: any) => message.toolsAdded ?? [])
      assert.equal(tools.length, toolDefinitions.length)
      assert.equal(new Set(tools.map((tool: any) => tool.name)).size, tools.length)
      assert.ok(tools.every((tool: any) => /^[a-zA-Z0-9_-]+$/.test(tool.name)))
      assert.ok(tools.some((tool: any) => tool.name === 'memory_search'))
      return fauxAssistantMessage([fauxToolCall('memory_search', { query: 'verification' }, { id: 'memory-1' })])
    },
    (context: any) => {
      const call = context.messages
        .flatMap((message: any) => (message.role === 'assistant' ? message.content : []))
        .find((block: any) => block.type === 'toolCall')
      assert.equal(call.name, 'memory_search')
      assert.equal(context.messages.at(-1).toolName, 'memory_search')
      return assistant()
    },
  ])
  await fixture.runtime.start()
  assert.equal(backend.effects, 1)
  assert.ok(backend.calls.includes('finish'))
  assert.ok(!backend.calls.includes('report_failure'))
  const saved = backend.events.find((event) => event.kind === 'assistant')!.payload.message
  assert.equal(saved.content[0].name, 'memory.search')
  assert.equal(backend.events.find((event) => event.kind === 'tool_result')!.payload.message.toolName, 'memory.search')
})
