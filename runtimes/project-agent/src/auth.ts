import { homedir } from 'node:os'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai/models'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { FileCredentials } from './credentials.js'

export const VERSION = '0.1.0'
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
      if (
        credential?.type === 'api_key' &&
        provider.auth.apiKey &&
        typeof credential.key === 'string' &&
        credential.key.trim()
      )
        status = 'available'
    } catch (error) {
      status = 'unknown'
      reason = error instanceof Error && credentialErrors.has(error.message) ? error.message : 'credential_read_failed'
    }
    const loginMethods: ('oauth' | 'api_key' | 'device_code')[] = []
    if (provider.auth.oauth) loginMethods.push('oauth')
    if (provider.auth.apiKey?.login) loginMethods.push('api_key')
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
  return { version: VERSION, providers }
}
export async function runtimeModels(store = credentials()) {
  const models = createModels({
    credentials: store,
    authContext: { env: async () => undefined, fileExists: async () => false },
  })
  for (const { provider } of registrations) models.setProvider(provider)
  return models
}

export async function loginApiKey(providerId: string, key: string, store = credentials()) {
  const { provider } = registeredProvider(providerId)
  if (!provider.auth.apiKey?.login) throw new Error('api_key_unsupported')
  const trimmed = key.trim()
  if (
    !trimmed ||
    Buffer.byteLength(trimmed) > 16 * 1024 ||
    Array.from(trimmed).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new Error('api_key_invalid')
  const models = await runtimeModels(store)
  await models.login(providerId, 'api_key', {
    async prompt(question) {
      if (question.type !== 'secret') throw new Error('api_key_prompt_unsupported')
      return trimmed
    },
    notify() {},
  })
}
