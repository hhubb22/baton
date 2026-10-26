import { join } from 'node:path'
import OpenAI from 'openai'
import { credentials } from './auth.js'
import { FileCredentials } from './credentials.js'
import type { MemoryEmbeddingConfig, RPC } from './protocol.js'

export const embeddingCredentials = () => new FileCredentials(join(credentials().directory, 'embeddings'))
export async function saveEmbeddingKey(profile: string, input: string): Promise<void> {
  const key = input.trim()
  if (
    !key ||
    Buffer.byteLength(key) > 16 * 1024 ||
    Array.from(key).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new Error('api_key_invalid')
  await embeddingCredentials().modify(profile, async () => ({ type: 'api_key', key }))
}
export type EmbeddingDiagnostic =
  | 'credential_missing'
  | 'embedding_request_failed'
  | 'embedding_timeout'
  | 'embedding_unavailable'
export class EmbeddingError extends Error {
  constructor(readonly diagnostic: EmbeddingDiagnostic) {
    super(diagnostic)
  }
}
export async function embed(config: MemoryEmbeddingConfig, text: string, signal?: AbortSignal) {
  const credential = config.credential_profile
    ? await embeddingCredentials().read(config.credential_profile)
    : undefined
  if (config.credential_profile && (credential?.type !== 'api_key' || !credential.key))
    throw new EmbeddingError('credential_missing')
  const client = new OpenAI({
    baseURL: config.base_url,
    apiKey: credential?.key ?? 'baton-anonymous',
    organization: null,
    project: null,
    maxRetries: 0,
    timeout: 20000,
  })
  try {
    const result = await client.embeddings.create(
      { model: config.model, input: text, encoding_format: 'float' },
      { signal, ...(!config.credential_profile ? { headers: { Authorization: null } } : {}) },
    )
    const vector = result.data[0]?.embedding
    if (!vector?.length || vector.length > 8192 || !vector.every(Number.isFinite) || !vector.some((n) => n !== 0))
      throw new EmbeddingError('embedding_request_failed')
    return { vector, usage: result.usage ?? null }
  } catch (error) {
    if (signal?.aborted) throw error
    if (error instanceof OpenAI.APIConnectionTimeoutError) throw new EmbeddingError('embedding_timeout')
    if (error instanceof OpenAI.APIError) throw new EmbeddingError('embedding_request_failed')
    throw error
  }
}
export async function queryEmbedding(
  rpc: RPC,
  lastSeq: number,
  inputSeq: number,
  query?: string,
  signal?: AbortSignal,
) {
  const binding = await rpc.call({
    operation: 'embedding_query',
    last_seq: lastSeq,
    payload: { input_seq: inputSeq, ...(query === undefined ? {} : { query }) },
  })
  if (!binding.memory_embedding) return {}
  try {
    const result = await embed(binding.memory_embedding, binding.query, signal)
    console.error(JSON.stringify({ operation: 'embedding_query', usage: result.usage }))
    return {
      query_vector: {
        config_id: binding.memory_embedding.config_id,
        query_hash: binding.query_hash,
        vector: result.vector,
      },
    }
  } catch (error) {
    if (!(error instanceof EmbeddingError)) throw error
    console.error(JSON.stringify({ operation: 'embedding_query', diagnostic: error.diagnostic, usage: null }))
    return { embedding_diagnostic: error.diagnostic }
  }
}
