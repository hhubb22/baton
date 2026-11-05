import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Schema } from 'effect'
import { NodeIdentity } from '@baton/protocol'
import { ensurePrivateDirectory, readPrivateFile, writePrivateFileAtomic } from '../platform/private.ts'
import { acquireProcessLock } from '../platform/lock.ts'
import { retireBinding } from './binding-fence.ts'

export const isMissing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT'

export function coordinatorURL(raw: string): string {
  const reject = () => new Error('Coordinator 地址必须是不带凭据、路径和查询参数的 https 地址')
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw reject()
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    raw.includes('?') ||
    raw.includes('#') ||
    raw.includes('\\') ||
    url.pathname !== '/'
  )
    throw reject()
  return url.origin
}

export function relayURL(raw: string): string {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error('Relay 地址必须是 wss 地址')
  }
  if (
    url.protocol !== 'wss:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    raw.includes('?') ||
    raw.includes('#') ||
    raw.includes('\\')
  )
    throw new Error('Relay 地址必须是不带凭据和查询参数的 wss 地址')
  if (url.pathname === '/') url.pathname = '/v1/node'
  return url.toString()
}

export { defaultDataDirectory } from '../platform/layout.ts'
export const nodeSystem = (): NodeIdentity['system'] => {
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'linux') return 'linux'
  if (process.platform === 'win32') return 'windows'
  throw new Error('当前系统尚不支持节点运行')
}

function decodeIdentity(value: unknown): NodeIdentity {
  try {
    const id = Schema.decodeUnknownSync(NodeIdentity)(value)
    if (!id.credential.token || id.credential.version < 1 || id.registration_seq < 1) throw new Error()
    if (id.coordinator_url) coordinatorURL(id.coordinator_url)
    return id
  } catch {
    throw new Error('节点身份无效')
  }
}

/** Device login has no application CA; replace only an unbound identity under its private lock. */
export async function saveDeviceIdentity(dataDirectory: string, value: unknown, base: string): Promise<NodeIdentity> {
  await ensurePrivateDirectory(dataDirectory)
  const release = await acquireProcessLock(join(dataDirectory, 'identity.lock'))
  try {
    try {
      await loadIdentity(dataDirectory)
      throw new Error('logout_required：请先执行 batond logout 清除已有绑定')
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    const identity = { ...decodeIdentity(value), coordinator_url: coordinatorURL(base) }
    await retireBinding(dataDirectory)
    await unlink(join(dataDirectory, 'coordinator-ca.pem')).catch((error: unknown) => {
      if (!isMissing(error)) throw error
    })
    await writePrivateFileAtomic(join(dataDirectory, 'identity.json'), JSON.stringify(identity))
    return identity
  } finally {
    await release()
  }
}

export async function clearIdentity(dataDirectory: string): Promise<void> {
  const release = await acquireProcessLock(join(dataDirectory, 'identity.lock'))
  try {
    await unlink(join(dataDirectory, 'identity.json')).catch((error: unknown) => {
      if (!isMissing(error)) throw error
    })
  } finally {
    await release()
  }
}

export async function loadIdentity(dataDirectory: string): Promise<NodeIdentity> {
  const raw = await readPrivateFile(join(dataDirectory, 'identity.json'))
  try {
    return decodeIdentity(JSON.parse(raw.toString('utf8')))
  } catch {
    throw new Error('节点身份无效')
  }
}
export async function loadCoordinatorCA(dataDirectory: string, explicitFile?: string): Promise<string | undefined> {
  if (explicitFile) return readFile(explicitFile, 'utf8')
  try {
    return (await readPrivateFile(join(dataDirectory, 'coordinator-ca.pem'))).toString('utf8')
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}
