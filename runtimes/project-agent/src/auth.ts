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
const modelCatalog = {
  'openai-codex': OPENAI_CODEX_MODELS,
  xai: XAI_MODELS,
}

// probe 只读取本地凭据和内置模型目录，不刷新 OAuth 或调用 provider。
export async function probe(store = credentials()) {
  const providers = []
  for (const provider of PROVIDERS) {
    let status = 'login_required'
    try {
      const credential = await store.read(provider)
      if (credential?.type === 'oauth' && credential.refresh && credential.access) status = 'available'
    } catch {
      status = 'unknown'
    }
    const catalog = modelCatalog[provider as keyof typeof modelCatalog]
    const models = Object.values(catalog)
      .slice(0, 64)
      .map(({ id, name }) => ({ id, name }))
    providers.push({ provider, status, models })
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
