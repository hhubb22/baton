import { homedir } from 'node:os'
import { join } from 'node:path'
import { OPENAI_CODEX_MODELS } from '@earendil-works/pi-ai/providers/openai-codex.models'
import { XAI_MODELS } from '@earendil-works/pi-ai/providers/xai.models'
import { FileCredentials } from './credentials.js'

export const VERSION = '0.1.0'
export const PROVIDERS = ['openai-codex', 'xai']
export function credentials() {
  return new FileCredentials(process.env.BATON_PROJECT_RUNTIME_DATA_DIR ?? join(homedir(), '.baton', 'project-runtime'))
}
const modelCatalog = new Map<string, ReadonlyArray<{ id: string; name: string }>>([
  ['openai-codex', Object.values(OPENAI_CODEX_MODELS)],
  ['xai', Object.values(XAI_MODELS)],
])
const credentialErrors = new Set([
  'credential_permissions_invalid',
  'credential_owner_invalid',
  'credential_path_invalid',
  'credential_private_file_failed',
])

// probe 只读取本地凭据和内置模型目录，不刷新 OAuth 或调用 provider。
export async function probe(store = credentials()) {
  const providers = []
  for (const provider of PROVIDERS) {
    let status = 'login_required'
    let reason: string | undefined
    try {
      const credential = await store.read(provider)
      if (credential?.type === 'oauth' && credential.refresh && credential.access) status = 'available'
    } catch (error) {
      status = 'unknown'
      reason = error instanceof Error && credentialErrors.has(error.message) ? error.message : 'credential_read_failed'
    }
    const models = (modelCatalog.get(provider) ?? []).slice(0, 64).map(({ id, name }) => ({ id, name }))
    providers.push({ provider, status, models, ...(reason ? { reason } : {}) })
  }
  return { version: VERSION, providers }
}
export async function runtimeModels() {
  const [{ createModels }, { openaiCodexProvider }, { xaiProvider }] = await Promise.all([
    import('@earendil-works/pi-ai/models'),
    import('@earendil-works/pi-ai/providers/openai-codex'),
    import('@earendil-works/pi-ai/providers/xai'),
  ])
  const models = createModels({
    credentials: credentials(),
    authContext: { env: async () => undefined, fileExists: async () => false },
  })
  models.setProvider(openaiCodexProvider())
  models.setProvider(xaiProvider())
  return models
}
