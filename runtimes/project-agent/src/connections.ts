import { promises as fs } from 'node:fs'
import { Schema } from 'effect'
import { createProvider } from '@earendil-works/pi-ai/models'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { FileCredentials } from './credentials.js'

const Connection = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)),
  name: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(128)),
  protocol: Schema.Literals(['openai-responses', 'openai-completions', 'anthropic-messages']),
  base_url: Schema.String.check(Schema.isMaxLength(2048)),
  models: Schema.Array(Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(512))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
    Schema.isUnique(),
  ),
})
export type Connection = typeof Connection.Type

const credentialId = (id: string) => `api-${id}`

export function connectionProvider(connection: Connection) {
  const id = credentialId(connection.id)
  let baseUrl = connection.base_url.replace(/\/+$/, '')
  if (connection.protocol === 'anthropic-messages' && baseUrl.endsWith('/v1')) baseUrl = baseUrl.slice(0, -3)
  const streams = {
    'openai-responses': openAIResponsesApi,
    'openai-completions': openAICompletionsApi,
    'anthropic-messages': anthropicMessagesApi,
  }
  return createProvider({
    id,
    name: connection.name,
    baseUrl,
    auth: { apiKey: openaiProvider().auth.apiKey! },
    models: connection.models.map((model) => ({
      id: model,
      name: model,
      api: connection.protocol,
      provider: id,
      baseUrl,
      input: ['text'],
      reasoning: false,
      contextWindow: 128_000,
      maxTokens: 8_192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
    api: streams[connection.protocol](),
  })
}

function validateConnection(value: unknown): Connection {
  const connection = Schema.decodeUnknownSync(Connection)(value)
  const url = new URL(connection.base_url)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('connection_url_invalid')
  return connection
}

function validateKey(key: string): string {
  const trimmed = key.trim()
  if (
    !trimmed ||
    Buffer.byteLength(trimmed) > 16 * 1024 ||
    Array.from(trimmed).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new Error('api_key_invalid')
  return trimmed
}

// 元数据和密钥只在本机持久化；读取列表时不返回密钥。
export class Connections {
  constructor(private readonly credentials: FileCredentials) {}

  async list(): Promise<(Connection & { key_needed: boolean })[]> {
    let files: string[]
    try {
      files = await fs.readdir(this.credentials.directory)
    } catch (error: any) {
      if (error.code === 'ENOENT') return []
      throw error
    }
    const result: (Connection & { key_needed: boolean })[] = []
    for (const file of files.filter((name) => /^api-[0-9a-f-]{36}\.json$/.test(name)).sort()) {
      try {
        const value = await this.credentials.read(file.slice(0, -5))
        if (!value?.connection) continue
        const connection = validateConnection(value.connection)
        if (credentialId(connection.id) !== file.slice(0, -5)) continue
        result.push({ ...connection, key_needed: typeof value.key !== 'string' || !value.key.trim() })
      } catch {
        // 单个连接损坏不妨碍其他来源被探测和使用。
      }
    }
    return result
  }

  async save(value: unknown, key?: string): Promise<void> {
    const connection = validateConnection(value)
    const checkedKey = key === undefined ? undefined : validateKey(key)
    await this.credentials.modify('api-index', async () => {
      const connections = await this.list()
      if (connections.length >= 29 && !connections.some((item) => item.id === connection.id))
        throw new Error('connection_limit')
      const metadata = [...connections.filter((item) => item.id !== connection.id), connection].map(
        ({ id, name, protocol, base_url }) => ({ id, name, protocol, base_url }),
      )
      if (Buffer.byteLength(JSON.stringify(metadata)) > 24 * 1024) throw new Error('connection_report_limit')
      await this.credentials.modify(credentialId(connection.id), async (current) => ({
        type: 'api_key',
        connection,
        ...(checkedKey !== undefined ? { key: checkedKey } : current?.key ? { key: current.key } : {}),
      }))
      return {}
    })
  }

  async delete(id: string): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
      throw new Error('connection_id_invalid')
    await this.credentials.delete(credentialId(id))
  }

  async setKey(id: string, key: string): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
      throw new Error('connection_id_invalid')
    const checkedKey = validateKey(key)
    await this.credentials.modify(credentialId(id), async (current) => {
      if (!current?.connection || validateConnection(current.connection).id !== id)
        throw new Error('connection_not_found')
      return { ...current, type: 'api_key', key: checkedKey }
    })
  }
}
