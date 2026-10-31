import { describe, expect, it } from 'vite-plus/test'
import { itemOutputParts, itemToolTelemetry, tokenUsageAttributes } from './genai.ts'
import type { ThreadTurnItem } from '@baton/protocol'

const item = (type: string, data: ThreadTurnItem['data']): ThreadTurnItem => ({
  id: `${type}-id`,
  type,
  status: 'completed',
  ordinal: 0,
  data,
})

describe('GenAI agent activity', () => {
  it('records tool names, arguments and results for canonical process items', () => {
    const command = itemToolTelemetry(item('command_execution', { input: 'pwd', output: '/work', exitCode: 0 }))!
    expect(command.approval).toBe(false)
    expect(command.attributes).toMatchObject({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'command_execution',
      'gen_ai.tool.call.id': 'command_execution-id',
    })
    expect(JSON.parse(command.attributes['gen_ai.tool.call.arguments'])).toEqual({ input: 'pwd' })
    expect(JSON.parse(command.attributes['gen_ai.tool.call.result'])).toEqual({
      output: '/work',
      exitCode: 0,
      status: 'completed',
    })
    const dynamic = itemToolTelemetry(
      item('dynamic_tool', { toolName: 'read_file', input: { path: 'a' }, output: 'A' }),
    )!
    expect(dynamic.name).toBe('read_file')
    for (const [type, data] of [
      ['file_change', { fileName: 'a.ts', diffStr: 'diff' }],
      ['file_search', { pattern: '*.ts', results: ['a.ts'] }],
      ['web_search', { patterns: ['Baton'], results: [] }],
      ['subagent', { prompt: 'review', result: 'done' }],
      ['approval_request', { prompt: 'continue' }],
      ['user_input_request', { questions: [], questionAnswer: { answers: {} } }],
    ] as const) {
      const telemetry = itemToolTelemetry(item(type, data))
      expect(telemetry?.attributes['gen_ai.tool.call.id']).toBe(`${type}-id`)
      expect(telemetry?.approval).toBe(type === 'approval_request' || type === 'user_input_request')
    }
  })

  it('keeps reasoning, plans and tool summaries in the Turn output', () => {
    expect(itemOutputParts(item('reasoning', { text: 'think' }))).toEqual([{ type: 'reasoning', content: 'think' }])
    expect(itemOutputParts(item('proposed_plan', { markdown: 'plan' }))).toEqual([{ type: 'text', content: 'plan' }])
    expect(itemOutputParts(item('dynamic_tool', { toolName: 'search', input: {}, output: 'result' }))).toHaveLength(2)
  })

  it('maps detailed token usage', () => {
    expect(
      tokenUsageAttributes({
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 4,
        cacheCreationTokens: 3,
        reasoningTokens: 2,
      }),
    ).toEqual({
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 5,
      'baton.usage.cached_input_tokens': 4,
      'gen_ai.usage.cache_read.input_tokens': 4,
      'gen_ai.usage.cache_creation_input_tokens': 3,
      'gen_ai.usage.reasoning.output_tokens': 2,
    })
  })
})
