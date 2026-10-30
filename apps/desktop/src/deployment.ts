import { X509Certificate, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { DeploymentConfig } from '@baton/protocol/deployment'
import { Schema } from 'effect'

export type { DeploymentConfig } from '@baton/protocol/deployment'

const decodeDeployment = Schema.decodeUnknownSync(DeploymentConfig)

function caCertificate(pem: string): X509Certificate {
  if (!/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END CERTIFICATE-----\s*$/.test(pem)) {
    throw new Error('CA 必须是单张 PEM 证书')
  }
  const certificate = new X509Certificate(pem)
  if (!certificate.ca) throw new Error('证书未声明 CA basicConstraints')
  return certificate
}

function validateDeployment(input: unknown): DeploymentConfig {
  const config = decodeDeployment(input)
  return config.ca_pem === undefined ? config : { ...config, ca_pem: caCertificate(config.ca_pem).toString() }
}

export function parseConnectLink(raw: string): DeploymentConfig {
  if (Buffer.byteLength(raw, 'utf8') > 8192) throw new Error('接入链接超过 8KB')
  // Windows 的 ShellExecute 会在 scheme 与主机名后补一个斜杠，把 baton://connect?… 改写成
  // baton://connect/?…。两种形式都要接受，否则从浏览器打开接入链接会一律被判为无效路由。
  const prefix = raw.startsWith('baton://connect?')
    ? 'baton://connect?'
    : raw.startsWith('baton://connect/?')
      ? 'baton://connect/?'
      : undefined
  if (prefix === undefined || /[\s#]/u.test(raw)) throw new Error('接入链接路由无效')

  const parameters = new Map<string, string>()
  for (const entry of raw.slice(prefix.length).split('&')) {
    const separator = entry.indexOf('=')
    if (separator < 1) throw new Error('接入链接参数无效')
    const key = decodeURIComponent(entry.slice(0, separator))
    const value = decodeURIComponent(entry.slice(separator + 1))
    if ((key !== 'url' && key !== 'ca') || parameters.has(key) || !value) {
      throw new Error('接入链接参数未知、重复或为空')
    }
    parameters.set(key, value)
  }

  let ca_pem: string | undefined
  const encodedCA = parameters.get('ca')
  if (encodedCA !== undefined) {
    if (!/^[A-Za-z0-9_-]+$/.test(encodedCA)) throw new Error('CA 必须使用 base64url 编码')
    const der = Buffer.from(encodedCA, 'base64url')
    if (der.toString('base64url') !== encodedCA) throw new Error('CA base64url 编码无效')
    const certificate = new X509Certificate(der)
    if (!certificate.raw.equals(der) || !certificate.ca) throw new Error('CA DER 证书无效')
    ca_pem = certificate.toString()
  }
  return validateDeployment({
    format: 1,
    coordinator_url: parameters.get('url'),
    ...(ca_pem === undefined ? {} : { ca_pem }),
  })
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

export async function loadDeployment(userData: string): Promise<DeploymentConfig | undefined> {
  let json: string
  try {
    json = await readFile(join(userData, 'deployment.json'), 'utf8')
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  // JSON 内的 CA 是配置来源；ca.pem 供 batond 的 --ca-file 使用。
  return validateDeployment(JSON.parse(json))
}

async function writeAtomic(userData: string, name: string, content: string): Promise<void> {
  const temporary = join(userData, `.${name}-${randomUUID()}`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, join(userData, name))
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!isMissing(error)) throw error
    })
  }
}

export async function saveDeployment(userData: string, config: DeploymentConfig): Promise<void> {
  const validated = validateDeployment(config)
  await mkdir(userData, { recursive: true, mode: 0o700 })
  if (validated.ca_pem !== undefined) {
    await writeAtomic(userData, 'ca.pem', validated.ca_pem)
  } else {
    await unlink(join(userData, 'ca.pem')).catch((error: unknown) => {
      if (!isMissing(error)) throw error
    })
  }
  await writeAtomic(userData, 'deployment.json', `${JSON.stringify(validated)}\n`)
}

export function caFingerprint(config: DeploymentConfig): string {
  return config.ca_pem === undefined ? '系统信任' : caCertificate(config.ca_pem).fingerprint256
}
