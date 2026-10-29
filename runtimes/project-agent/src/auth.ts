import { BUILD, releaseMetadata } from '@baton/protocol/release.mjs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai/models'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { FileCredentials } from './credentials.js'
import { Connections, connectionProvider } from './connections.js'

export const VERSION = BUILD.version
// 设备码能力由对应 OAuth 流程决定；其余认证方式和模型直接取自 provider。
const registrations = [
  { provider: openaiCodexProvider(), deviceCode: true },
  { provider: xaiProvider(), deviceCode: true },
  { provider: anthropicProvider(), deviceCode: false },
]
export function registeredProvider(id: string) {
  const registration = registrations.find(({ provider }) => provider.id === id)
  if (!registration) throw new Error('unsupported_provider')
  return registration
}
export function credentials() {
  return new FileCredentials(process.env.BATON_PROJECT_RUNTIME_DATA_DIR ?? join(homedir(), '.baton', 'project-runtime'))
}
const credentialErrors = new Set([
  'credential_permissions_invalid',
  'credential_owner_invalid',
  'credential_path_invalid',
  'credential_private_file_failed',
])

// probe 只读取本地凭据和内置模型目录，不刷新 OAuth 或调用 provider。
export async function probe(store = credentials()) {
  const providers = []
  for (const { provider, deviceCode } of registrations) {
    let status = 'login_required'
    let reason: string | undefined
    try {
      const credential = await store.read(provider.id)
      if (credential?.type === 'oauth' && provider.auth.oauth && credential.refresh && credential.access)
        status = 'available'
    } catch (error) {
      status = 'unknown'
      reason = error instanceof Error && credentialErrors.has(error.message) ? error.message : 'credential_read_failed'
    }
    const loginMethods: ('oauth' | 'api_key' | 'device_code')[] = []
    if (provider.auth.oauth) loginMethods.push('oauth')
    if (deviceCode) loginMethods.push('device_code')
    const models = provider
      .getModels()
      .slice(0, 64)
      .map(({ id, name }) => ({ id, name }))
    providers.push({
      provider: provider.id,
      status,
      models,
      login_methods: loginMethods,
      ...(reason ? { reason } : {}),
    })
  }
  for (const connection of await new Connections(store).list()) {
    providers.push({
      provider: `api-${connection.id}`,
      status: connection.key_needed ? 'login_required' : 'available',
      models: connection.models.map((id) => ({ id, name: id })),
      login_methods: [],
      reason: undefined,
      connection: {
        id: connection.id,
        name: connection.name,
        protocol: connection.protocol,
        base_url: connection.base_url,
      },
    })
  }
  const result = { version: VERSION, release: releaseMetadata(), memory_protocol: 1, providers }
  for (const provider of [...providers].reverse()) {
    while (Buffer.byteLength(JSON.stringify(result)) > 48 * 1024 && provider.models.length) {
      provider.models.pop()
      Object.assign(provider, { models_truncated: true })
    }
  }
  return result
}
export async function runtimeModels(store = credentials()) {
  const models = createModels({
    credentials: store,
    authContext: { env: async () => undefined, fileExists: async () => false },
  })
  for (const { provider } of registrations) models.setProvider(provider)
  for (const connection of await new Connections(store).list()) models.setProvider(connectionProvider(connection))
  return models
}
