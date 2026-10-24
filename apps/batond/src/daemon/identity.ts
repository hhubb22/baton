import { readFile } from 'node:fs/promises'
import { request } from 'node:https'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { Schema } from 'effect'
import { NodeIdentity, RegisterNodeInput } from '@baton/protocol'
import { ensurePrivateDirectory, readPrivateFile, writePrivateFileAtomic } from '../platform/private.ts'
import { acquireProcessLock } from '../platform/lock.ts'

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

export const defaultDataDirectory = () => join(homedir(), '.baton-ts')
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

export async function loadIdentity(dataDirectory: string): Promise<NodeIdentity> {
  const raw = await readPrivateFile(join(dataDirectory, 'identity.json'))
  try {
    return decodeIdentity(JSON.parse(raw.toString('utf8')))
  } catch {
    throw new Error('节点身份无效')
  }
}

export interface RegistrationTransport {
  (url: string, body: RegisterNodeInput, options: { ca?: string; signal?: AbortSignal }): Promise<unknown>
}

const registerHTTPS: RegistrationTransport = (url, body, options) =>
  new Promise((resolve, reject) => {
    const fail = () => reject(new Error('无法向 Coordinator 注册节点'))
    const req = request(
      url,
      {
        method: 'POST',
        minVersion: 'TLSv1.2',
        ca: options.ca,
        signal: options.signal,
        headers: { 'content-type': 'application/json', 'user-agent': 'batond' },
      },
      (res) => {
        const chunks: Buffer[] = []
        let length = 0
        res.on('data', (chunk: Buffer) => {
          length += chunk.length
          if (length > 64 * 1024) {
            res.destroy()
            fail()
          } else chunks.push(chunk)
        })
        res.on('error', fail)
        res.on('end', () => {
          if (res.statusCode !== 200) {
            fail()
            return
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch {
            fail()
          }
        })
      },
    )
    req.setTimeout(30_000, () => req.destroy())
    req.on('error', fail)
    req.end(JSON.stringify(body))
  })

export interface RegisterNodeOptions {
  readonly dataDirectory: string
  readonly coordinatorURL: string
  readonly enrollmentFile?: string
  readonly displayName?: string
  readonly caFile?: string
  readonly signal?: AbortSignal
  readonly transport?: RegistrationTransport
}

/** Exchanges enrollment material for a server-issued credential and saves it without logging it. */
export async function registerNode(options: RegisterNodeOptions): Promise<NodeIdentity> {
  await ensurePrivateDirectory(options.dataDirectory)
  const release = await acquireProcessLock(join(options.dataDirectory, 'identity.lock'))
  try {
    try {
      await loadIdentity(options.dataDirectory)
      throw new Error('节点身份已存在，请直接运行 up 或 run')
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    const base = coordinatorURL(options.coordinatorURL)
    let token: string
    try {
      token = options.enrollmentFile
        ? (await readPrivateFile(options.enrollmentFile)).toString('utf8').trim()
        : (process.env.BATON_ENROLLMENT_TOKEN ?? '').trim()
    } catch {
      throw new Error('无法读取私有注册凭据文件')
    }
    if (!token || token.length > 512 || /\s/.test(token) || base.includes(token))
      throw new Error('注册凭据无效，请使用 BATON_ENROLLMENT_TOKEN 或 --enrollment-file')
    let body: RegisterNodeInput
    try {
      body = Schema.decodeUnknownSync(RegisterNodeInput)({
        enrollment_token: token,
        display_name: options.displayName ?? hostname(),
        system: nodeSystem(),
        role: '',
        capabilities: [],
      })
    } catch {
      throw new Error('节点显示名或系统信息无效')
    }
    let response: unknown
    try {
      response = await (options.transport ?? registerHTTPS)(`${base}/api/v1/nodes/register`, body, {
        ...(options.caFile ? { ca: await readFile(options.caFile, 'utf8') } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      })
    } catch {
      throw new Error('无法向 Coordinator 注册节点')
    }
    const id = { ...decodeIdentity(response), coordinator_url: base }
    await writePrivateFileAtomic(join(options.dataDirectory, 'identity.json'), JSON.stringify(id))
    return id
  } finally {
    await release()
  }
}
