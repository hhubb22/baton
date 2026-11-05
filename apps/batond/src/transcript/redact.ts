import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { redactTranscript } from '@baton/protocol'
import { readPrivateFile } from '../platform/private.ts'

export { redactTranscript }

const sensitiveKey =
  /^(authorization|cookie|csrf|csrf_token|device_code|access|access_token|refresh|refresh_token|id_token|password|new_password|current_password|secret|api_key|token|private_key|node_signing_key|client_secret)$/i

const collectEnvironmentSecrets = (): string[] => {
  const secrets: string[] = []
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 8) continue
    if (/(API_KEY|_TOKEN$|^TOKEN$|SECRET|PASSWORD|PRIVATE_KEY|DEVICE_CODE)/i.test(name)) secrets.push(value)
  }
  return secrets
}

const collectFileSecrets = async (path: string): Promise<string[]> => {
  try {
    const raw = await readPrivateFile(path)
    if (raw.length > 256 * 1024) return []
    const value: unknown = JSON.parse(raw.toString('utf8'))
    const secrets: string[] = []
    const visit = (entry: unknown, depth: number) => {
      if (!entry || typeof entry !== 'object' || depth > 8) return
      for (const [key, nested] of Object.entries(entry)) {
        if (typeof nested === 'string' && nested.length >= 8 && sensitiveKey.test(key)) secrets.push(nested)
        else visit(nested, depth + 1)
      }
    }
    visit(value, 0)
    return secrets
  } catch {
    return []
  }
}

/** 读取设备上的实际凭据值，供字符串内容中出现的密钥做精确替换。 */
export const loadTranscriptSecrets = async (dataDirectory?: string): Promise<string[]> => {
  const secrets = collectEnvironmentSecrets()
  if (!dataDirectory) return secrets
  try {
    const token = await readPrivateFile(join(dataDirectory, 'control.token'))
    if (token.length >= 8 && token.length <= 4096) secrets.push(token.toString('utf8').trim())
  } catch {
    // 尚未登录或令牌不存在时没有可精确替换的值。
  }
  const credentialDirectory = process.env.BATON_PROJECT_RUNTIME_DATA_DIR ?? join(dataDirectory, 'credentials')
  try {
    for (const name of await readdir(credentialDirectory)) {
      if (/^[a-z0-9-]{1,64}\.json$/.test(name))
        secrets.push(...(await collectFileSecrets(join(credentialDirectory, name))))
    }
  } catch {
    // 凭据目录不可读时仍保留键名与格式过滤。
  }
  return [...new Set(secrets.filter((value) => value.length >= 8))]
}
