import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { FileCredentials } from '../src/credentials.js'
import { Connections } from '../src/connections.js'
import { probe, runtimeModels } from '../src/auth.js'

test('连接分别保存密钥，修改元数据保留密钥且不覆盖订阅', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'baton-connections-'))
  try {
    const credentials = new FileCredentials(dir)
    const connections = new Connections(credentials)
    await credentials.modify('anthropic', async () => ({ type: 'oauth', access: 'access', refresh: 'refresh' }))
    const first = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'First',
      protocol: 'anthropic-messages',
      base_url: 'http://127.0.0.1:3000',
      models: ['model-a'],
    } as const
    const second = { ...first, id: '22222222-2222-4222-8222-222222222222', name: 'Second' }
    await connections.save(first, 'first-secret')
    await connections.save(second, 'second-secret')
    await connections.save({ ...first, name: 'Renamed' })
    assert.equal((await credentials.read(`api-${first.id}`)).key, 'first-secret')
    assert.equal((await credentials.read(`api-${second.id}`)).key, 'second-secret')
    assert.equal((await credentials.read('anthropic')).type, 'oauth')
    const report = await probe(credentials)
    assert.equal(report.providers.find((p) => p.provider === `api-${first.id}`)?.status, 'available')
    assert.ok(!JSON.stringify(report).includes('secret'))
    assert.ok((await runtimeModels(credentials)).getModel(`api-${first.id}`, 'model-a'))
    await connections.delete(first.id)
    assert.equal(await credentials.read(`api-${first.id}`), undefined)
    assert.equal((await credentials.read(`api-${second.id}`)).key, 'second-secret')
    await connections.save(first)
    assert.equal((await connections.list()).find((item) => item.id === first.id)?.key_needed, true)
    await assert.rejects(() => connections.save({ ...first, base_url: 'https://user:password@example.com' }))
    await writeFile(join(dir, `api-${first.id}.json`), '{')
    const afterDamage = await probe(credentials)
    assert.equal(afterDamage.providers.find((item) => item.provider === 'anthropic')?.status, 'available')
    assert.equal(afterDamage.providers.find((item) => item.provider === `api-${second.id}`)?.status, 'available')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('本机 CLI 从标准输入保存连接密钥而不输出密钥', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'baton-connection-cli-'))
  try {
    const env = { ...process.env, BATON_PROJECT_RUNTIME_DATA_DIR: dir, NODE_OPTIONS: '' }
    const invoke = (args: string[], input: string) =>
      spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
        env,
        input,
        encoding: 'utf8',
        timeout: 5000,
      })
    const id = '11111111-1111-4111-8111-111111111111'
    const saved = invoke(
      ['connection-save'],
      JSON.stringify({
        id,
        name: 'Example',
        protocol: 'openai-responses',
        base_url: 'http://localhost:8080/v1',
        models: ['model'],
      }),
    )
    assert.equal(saved.status, 0, saved.stderr)
    const result = invoke(['connection-key', id], 'offline-secret\n')
    assert.equal(result.status, 0, result.stderr)
    assert.ok(!(result.stdout + result.stderr).includes('offline-secret'))
    assert.equal((await new FileCredentials(dir).read(`api-${id}`)).key, 'offline-secret')
    assert.notEqual(invoke(['connection-key', '22222222-2222-4222-8222-222222222222'], 'key').status, 0)
    const models = Array.from({ length: 64 }, (_, index) => `${String(index).padStart(2, '0')}${'x'.repeat(510)}`)
    assert.equal(
      invoke(
        ['connection-save'],
        JSON.stringify({
          id,
          name: 'Example',
          protocol: 'openai-responses',
          base_url: 'http://localhost:8080/v1',
          models,
        }),
      ).status,
      0,
    )
    const report = JSON.parse(invoke(['probe'], '').stdout)
    const item = report.providers.find((provider: { provider: string }) => provider.provider === `api-${id}`)
    assert.equal(item.models_truncated, true)
    const read = invoke(['connection-get', id], '')
    assert.equal(read.status, 0)
    assert.deepEqual(JSON.parse(read.stdout).models, models)
    assert.ok(!read.stdout.includes('offline-secret'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('限制来源数量以确保订阅与 API 连接都能报告', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'baton-connection-limit-'))
  try {
    const store = new FileCredentials(dir)
    const connections = new Connections(store)
    const connection = {
      id: '',
      name: 'Example',
      protocol: 'openai-responses',
      base_url: 'http://localhost:8080/v1',
      models: ['model'],
    }
    for (let index = 0; index < 29; index++)
      await connections.save({ ...connection, id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` })
    await assert.rejects(
      () => connections.save({ ...connection, id: '00000000-0000-4000-8000-000000000029' }),
      /connection_limit/,
    )
    assert.equal((await probe(store)).providers.length, 32)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('三个协议将请求发到配置的路径并读取流式回复', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'baton-connection-http-'))
  const paths: string[] = []
  const server = createServer(async (request, response) => {
    paths.push(request.url ?? '')
    let body = ''
    for await (const chunk of request) body += chunk.toString()
    const tool = Array.isArray(JSON.parse(body).tools) && JSON.parse(body).tools.length > 0
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const event = (value: Record<string, unknown>) =>
      response.write(
        `${typeof value.type === 'string' ? `event: ${value.type}\n` : ''}data: ${JSON.stringify(value)}\n\n`,
      )
    if (request.url?.endsWith('/chat/completions')) {
      event({
        id: 'one',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: tool
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-1',
                      type: 'function',
                      function: { name: 'lookup', arguments: '{"value":"ok"}' },
                    },
                  ],
                }
              : { content: 'hello' },
            finish_reason: null,
          },
        ],
      })
      event({
        id: 'one',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
      })
      response.end('data: [DONE]\n\n')
    } else if (request.url?.endsWith('/responses')) {
      if (tool) {
        event({
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'function_call', id: 'one', call_id: 'call-1', name: 'lookup', arguments: '' },
        })
        event({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"value":"ok"}' })
        event({
          type: 'response.output_item.done',
          output_index: 0,
          item: { type: 'function_call', id: 'one', call_id: 'call-1', name: 'lookup', arguments: '{"value":"ok"}' },
        })
      } else {
        event({
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'message', id: 'one', role: 'assistant', content: [] },
        })
        event({ type: 'response.output_text.delta', output_index: 0, delta: 'hello' })
        event({
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'message',
            id: 'one',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'hello', annotations: [] }],
          },
        })
      }
      event({
        type: 'response.completed',
        response: {
          id: 'one',
          status: 'completed',
          output: [],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      })
      response.end()
    } else {
      event({
        type: 'message_start',
        message: { id: 'one', model: 'test-model', usage: { input_tokens: 1, output_tokens: 0 } },
      })
      event({
        type: 'content_block_start',
        index: 0,
        content_block: tool
          ? { type: 'tool_use', id: 'call-1', name: 'lookup', input: {} }
          : { type: 'text', text: '' },
      })
      event({
        type: 'content_block_delta',
        index: 0,
        delta: tool
          ? { type: 'input_json_delta', partial_json: '{"value":"ok"}' }
          : { type: 'text_delta', text: 'hello' },
      })
      event({ type: 'content_block_stop', index: 0 })
      event({
        type: 'message_delta',
        delta: { stop_reason: tool ? 'tool_use' : 'end_turn' },
        usage: { output_tokens: 1 },
      })
      event({ type: 'message_stop' })
      response.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server address missing')
    const store = new FileCredentials(dir)
    const connections = new Connections(store)
    for (const [index, protocol] of (
      ['openai-responses', 'openai-completions', 'anthropic-messages'] as const
    ).entries()) {
      const id = `00000000-0000-4000-8000-00000000000${index}`
      await connections.save(
        {
          id,
          name: protocol,
          protocol,
          base_url: `http://127.0.0.1:${address.port}/gateway/v1`,
          models: ['test-model'],
        },
        'offline-key',
      )
      const models = await runtimeModels(store)
      const model = models.getModel(`api-${id}`, 'test-model')!
      const reply = await models.completeSimple(model, {
        messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }],
      })
      assert.equal(reply.stopReason, 'stop', reply.errorMessage ?? '')
      assert.equal(reply.content.find((part) => part.type === 'text')?.text, 'hello')
      const called = await models.completeSimple(model, {
        messages: [{ role: 'user', content: 'use lookup', timestamp: Date.now() }],
        tools: [
          {
            name: 'lookup',
            description: 'Look up a value',
            parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } as any,
          },
        ],
      })
      assert.equal(called.stopReason, 'toolUse', called.errorMessage ?? '')
      assert.deepEqual(called.content.find((part) => part.type === 'toolCall')?.arguments, { value: 'ok' })
    }
    assert.deepEqual(paths, [
      '/gateway/v1/responses',
      '/gateway/v1/responses',
      '/gateway/v1/chat/completions',
      '/gateway/v1/chat/completions',
      '/gateway/v1/messages?beta=true',
      '/gateway/v1/messages?beta=true',
    ])
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await rm(dir, { recursive: true, force: true })
  }
})
