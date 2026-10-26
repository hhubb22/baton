import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createModels, fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai'
import { runMemory } from '../src/memory.js'
import { checkedRPC } from '../src/protocol.js'
import { queryEmbedding } from '../src/embeddings.js'

test('consolidates a source with a local model and generates background and bound query vectors without chat OAuth', async () => {
  const models = createModels()
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'memory', contextWindow: 80000, maxTokens: 8000 }] })
  models.setProvider(faux.provider)
  const source = {
    id: 'source',
    source_hash: 'hash',
    role: 'user',
    text: '测试使用 pnpm test:unit。',
    offset: 0,
    next_offset: Buffer.byteLength('测试使用 pnpm test:unit。'),
    has_more: false,
    suppressed: false,
  }
  const changes = [
    {
      action: 'add',
      expected_revision: 0,
      content: { title: '测试入口', content: source.text },
      evidence: [
        { source_id: source.id, source_hash: source.source_hash, start_byte: 0, end_byte: source.next_offset },
      ],
    },
  ]
  faux.setResponses([fauxAssistantMessage(JSON.stringify({ changes }))])
  let committed = false,
    finished = false
  const rpc = checkedRPC(async (request) => {
    let data: unknown
    switch (request.operation) {
      case 'memory_bootstrap':
        data = {
          job_id: 'job',
          kind: 'consolidation',
          provider: 'faux',
          model: 'memory',
          max_model_calls: 8,
          max_duration_ms: 300000,
          max_changes: 16,
          cursor_index: 0,
          cursor_offset: 0,
        }
        break
      case 'read_sources':
        data = { done: false, cursor_index: 0, cursor_offset: 0, source }
        break
      case 'lookup_items':
        data = { entries: [] }
        break
      case 'commit_chunk':
        assert.deepEqual((request.payload as { changes: unknown }).changes, changes)
        committed = true
        data = { done: true, cursor_index: 1, cursor_offset: 0 }
        break
      case 'finish':
        finished = true
        data = {}
        break
      default:
        throw new Error(request.operation)
    }
    return { type: 'project_runtime.result', ok: true, data }
  })
  await runMemory(rpc, 8000, undefined, models)
  assert.ok(committed && finished)
  const inputs: string[] = []
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, undefined)
    assert.equal(req.url, '/v1/embeddings')
    let body = ''
    for await (const part of req) body += part
    const request = JSON.parse(body)
    assert.equal(request.model, 'local-any-model')
    inputs.push(request.input)
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: [1, 0, 0] }],
        model: request.model,
        usage: { prompt_tokens: 3, total_tokens: 3 },
      }),
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const config = {
    base_url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    model: 'local-any-model',
    config_id: 'config',
  }
  let vectorCommitted = false
  const embeddingRPC = checkedRPC(async (request) => {
    let data: unknown
    switch (request.operation) {
      case 'memory_bootstrap':
        data = {
          job_id: 'vectors',
          kind: 'embedding',
          provider: 'not-logged-in',
          model: 'unused',
          max_model_calls: 8,
          max_duration_ms: 300000,
          max_changes: 16,
          cursor_index: 0,
          cursor_offset: 0,
        }
        break
      case 'pending_embeddings':
        data = {
          memory_embedding: config,
          entries: vectorCommitted
            ? []
            : [
                {
                  item_id: 'item',
                  revision: 1,
                  config_id: 'config',
                  embedding_text_hash: 'hash',
                  text: '测试入口\n' + source.text,
                },
              ],
        }
        break
      case 'commit_embedding':
        assert.deepEqual((request.payload as { vector: unknown }).vector, [1, 0, 0])
        vectorCommitted = true
        data = { accepted: true }
        break
      case 'embedding_query':
        data = {
          query: '测试约定',
          query_hash: 'query-hash',
          query_truncated: false,
          input_seq: 1,
          last_seq: 2,
          memory_embedding: config,
        }
        break
      case 'finish':
        data = {}
        break
      default:
        throw new Error(request.operation)
    }
    return { type: 'project_runtime.result', ok: true, data }
  })
  try {
    await runMemory(embeddingRPC)
    assert.ok(vectorCommitted)
    assert.deepEqual(await queryEmbedding(embeddingRPC, 2, 1), {
      query_vector: { config_id: 'config', query_hash: 'query-hash', vector: [1, 0, 0] },
    })
    assert.deepEqual(inputs, ['测试入口\n' + source.text, '测试约定'])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})
