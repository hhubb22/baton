import { createHash, randomUUID } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import { request } from 'node:https'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { Schema } from 'effect'
import { NodeIdentity, ReauthNodeInput, RegisterNodeInput } from '@baton/protocol'
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

async function saveCoordinatorCA(dataDirectory: string, ca: string | undefined): Promise<void> {
  const path = join(dataDirectory, 'coordinator-ca.pem')
  if (ca !== undefined) await writePrivateFileAtomic(path, ca)
  else {
    try {
      await unlink(path)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
}

export interface RegistrationTransport<Input = RegisterNodeInput> {
  (url: string, body: Input, options: { ca?: string; signal?: AbortSignal }): Promise<unknown>
}

const CoordinatorFailure = Schema.Struct({
  status: Schema.Int.check(Schema.isBetween({ minimum: 400, maximum: 599 })),
  body: Schema.Struct({ code: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,63}$/)) }),
})

class CoordinatorHTTPError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super('Coordinator 请求失败')
  }
}

const registerHTTPS: RegistrationTransport<RegisterNodeInput | ReauthNodeInput> = (url, body, options) =>
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
          try {
            const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (res.statusCode !== 200) {
              const failure = Schema.decodeUnknownSync(CoordinatorFailure)({ status: res.statusCode, body })
              reject(new CoordinatorHTTPError(failure.status, failure.body.code))
              return
            }
            resolve(body)
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

async function readEnrollmentToken(file: string | undefined, base: string): Promise<string> {
  let token: string
  try {
    token = file
      ? (await readPrivateFile(file)).toString('utf8').trim()
      : (process.env.BATON_ENROLLMENT_TOKEN ?? '').trim()
  } catch {
    throw new Error('无法读取私有注册凭据文件')
  }
  if (!token || token.length > 512 || /\s/.test(token) || base.includes(token))
    throw new Error('注册凭据无效，请使用 BATON_ENROLLMENT_TOKEN 或 --enrollment-file')
  return token
}

export interface RegisterNodeOptions {
  readonly dataDirectory: string
  readonly coordinatorURL: string
  readonly enrollmentFile?: string
  readonly displayName?: string
  readonly caFile?: string
  readonly caPem?: string
  readonly signal?: AbortSignal
  readonly transport?: RegistrationTransport
}

/** 用注册凭据换取中心签发的身份，在身份锁下保存 CA 和身份。 */
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
    const token = await readEnrollmentToken(options.enrollmentFile, base)
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
    const ca = options.caFile ? await readFile(options.caFile, 'utf8') : options.caPem
    let response: unknown
    try {
      response = await (options.transport ?? registerHTTPS)(`${base}/api/v1/nodes/register`, body, {
        ...(ca !== undefined ? { ca } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      })
    } catch {
      throw new Error('无法向 Coordinator 注册节点')
    }
    const id = { ...decodeIdentity(response), coordinator_url: base }
    await saveCoordinatorCA(options.dataDirectory, ca)
    await writePrivateFileAtomic(join(options.dataDirectory, 'identity.json'), JSON.stringify(id))
    return id
  } finally {
    await release()
  }
}

const PendingReauthentication = Schema.Struct({
  node_id: NodeIdentity.fields.node_id,
  employee_id: NodeIdentity.fields.employee_id,
  coordinator_url: Schema.String,
  request: ReauthNodeInput,
  request_hash: Schema.String,
})

const reauthRequestHash = (body: ReauthNodeInput) => createHash('sha256').update(JSON.stringify(body)).digest('hex')
const recoveryRequired = () =>
  new Error('identity_recovery_required：重新认证缺少有效的本地身份或原操作记录，请保留数据并核对身份')

export interface ReauthNodeOptions {
  readonly dataDirectory: string
  readonly enrollmentFile?: string
  readonly caFile?: string
  readonly signal?: AbortSignal
  readonly transport?: RegistrationTransport<ReauthNodeInput>
}

/** 在身份锁下保存原请求，重试沿用同一操作和秘密；身份原子替换后才清除待提交记录。 */
export async function reauthNode(options: ReauthNodeOptions): Promise<NodeIdentity> {
  await ensurePrivateDirectory(options.dataDirectory)
  const release = await acquireProcessLock(join(options.dataDirectory, 'identity.lock'))
  try {
    let previous: NodeIdentity
    try {
      previous = await loadIdentity(options.dataDirectory)
    } catch {
      throw recoveryRequired()
    }
    if (!previous.coordinator_url) throw recoveryRequired()
    const base = coordinatorURL(previous.coordinator_url)
    const pendingPath = join(options.dataDirectory, 'reauth-pending.json')
    let pending: typeof PendingReauthentication.Type | undefined
    try {
      const raw = await readPrivateFile(pendingPath)
      try {
        pending = Schema.decodeUnknownSync(PendingReauthentication)(JSON.parse(raw.toString('utf8')))
      } catch {
        throw recoveryRequired()
      }
      if (
        pending.node_id !== previous.node_id ||
        pending.employee_id !== previous.employee_id ||
        pending.coordinator_url !== base ||
        pending.request_hash !== reauthRequestHash(pending.request)
      )
        throw recoveryRequired()
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    if (!pending) {
      const token = await readEnrollmentToken(options.enrollmentFile, base)
      let body: ReauthNodeInput
      try {
        body = Schema.decodeUnknownSync(ReauthNodeInput)({
          operation_id: randomUUID(),
          enrollment_token: token,
          previous_token: previous.credential.token,
        })
      } catch {
        throw new Error('重新认证凭据无效')
      }
      pending = {
        node_id: previous.node_id,
        employee_id: previous.employee_id,
        coordinator_url: base,
        request: body,
        request_hash: reauthRequestHash(body),
      }
      await writePrivateFileAtomic(pendingPath, JSON.stringify(pending))
    }
    const ca = await loadCoordinatorCA(options.dataDirectory, options.caFile)
    let response: unknown
    try {
      response = await (options.transport ?? registerHTTPS)(
        `${base}/api/v1/nodes/${pending.node_id}/reauth`,
        pending.request,
        {
          ...(ca !== undefined ? { ca } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        },
      )
    } catch (error) {
      if (error instanceof CoordinatorHTTPError && error.status === 401 && error.code === 'enrollment_expired') {
        await unlink(pendingPath)
        throw new Error(
          '重新认证凭据已过期，原操作未提交；请领取新的重新认证凭据，通过 BATON_ENROLLMENT_TOKEN 或 --enrollment-file 再次运行 batond reauth',
        )
      }
      throw new Error('无法向 Coordinator 重新认证节点；原操作已保留，请重试 batond reauth')
    }
    const id = { ...decodeIdentity(response), coordinator_url: base }
    if (
      id.node_id !== previous.node_id ||
      id.employee_id !== previous.employee_id ||
      id.registration_seq !== previous.registration_seq ||
      (previous.credential.token !== pending.request.previous_token &&
        previous.credential.token !== id.credential.token)
    )
      throw recoveryRequired()
    await saveCoordinatorCA(options.dataDirectory, ca)
    await writePrivateFileAtomic(join(options.dataDirectory, 'identity.json'), JSON.stringify(id))
    await unlink(pendingPath)
    return id
  } finally {
    await release()
  }
}
