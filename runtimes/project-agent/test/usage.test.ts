import { test } from 'vitest'
import assert from 'node:assert/strict'
import { providerUsage } from '../src/usage.js'
import { Backend, assistant, setup } from './fixture.js'

test('reads only explicitly reported usage from supported provider events', () => {
  assert.deepEqual(providerUsage('openai-completions', { usage: { prompt_tokens: 0, completion_tokens: 0 } }), {
    input: 0,
    output: 0,
  })
  assert.deepEqual(
    providerUsage('openai-codex-responses', {
      response: {
        usage: {
          input_tokens: 4,
          output_tokens: 3,
          input_tokens_details: { cached_tokens: 2 },
          output_tokens_details: { reasoning_tokens: 1 },
        },
      },
    }),
    { input: 4, output: 3, cached: 2, reasoning: 1 },
  )
  assert.deepEqual(
    providerUsage('anthropic-messages', { message: { usage: { input_tokens: 7, cache_creation_input_tokens: 2 } } }),
    { input: 7, cacheCreation: 2 },
  )
  assert.deepEqual(providerUsage('anthropic-messages', { usage: { output_tokens: 0 } }), { output: 0 })
  assert.deepEqual(
    providerUsage('google-generative-ai', {
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, thoughtsTokenCount: 1 },
    }),
    { input: 4, output: 3, reasoning: 1 },
  )
  assert.deepEqual(providerUsage('unknown', { usage: { input_tokens: 10 } }), {})
  assert.deepEqual(providerUsage('openai-completions', { usage: {} }), {})
})

test('model stream callback records actual zero and leaves absent usage unknown', async () => {
  const spans: Record<string, unknown>[] = []
  const backend = new Backend()
  const { runtime } = setup(
    backend,
    [
      async (_context: unknown, options: any, _state: unknown, model: any) => {
        await options.onProviderStreamEvent(
          { usage: { prompt_tokens: 0, completion_tokens: 0 } },
          { ...model, api: 'openai-completions' },
        )
        return assistant()
      },
    ],
    {
      telemetry: {
        async span(name, attributes, task) {
          const values = { ...attributes }
          if (name.startsWith('chat ')) spans.push(values)
          return task((updates) => Object.assign(values, updates))
        },
      },
    },
  )
  await runtime.run()
  assert.equal(spans[0]?.['baton.usage.reported'], true)
  assert.equal(spans[0]?.['gen_ai.usage.input_tokens'], 0)
  assert.equal(spans[0]?.['gen_ai.usage.output_tokens'], 0)
  assert.equal(spans[0]?.['gen_ai.operation.name'], 'chat')
  assert.equal(spans[0]?.['gen_ai.agent.name'], 'project')
  assert.equal(spans[0]?.['gen_ai.conversation.id'], 'conversation-stable')
  assert.equal(spans[0]?.['gen_ai.response.model'], 'faux-model')
  assert.equal(spans[0]?.stop_reason, 'stop')
  assert.equal(typeof spans[0]?.['gen_ai.system_instructions'], 'string')
  assert.equal(JSON.parse(String(spans[0]?.['gen_ai.input.messages']))[0].role, 'user')
  assert.equal(JSON.parse(String(spans[0]?.['gen_ai.output.messages']))[0].finish_reason, 'stop')
  const missing: Record<string, unknown>[] = []
  const second = setup(new Backend(), [() => assistant()], {
    telemetry: {
      async span(name, attributes, task) {
        const values = { ...attributes }
        if (name.startsWith('chat ')) missing.push(values)
        return task((updates) => Object.assign(values, updates))
      },
    },
  })
  await second.runtime.run()
  assert.equal(missing[0]?.['baton.usage.reported'], false)
  assert.equal(Object.hasOwn(missing[0]!, 'gen_ai.usage.input_tokens'), false)
})
