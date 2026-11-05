import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Schema } from 'effect'
import { CoordinatorOrigin } from '@baton/protocol/deployment'

export const CoordinatorConfig = Schema.Struct({
  format: Schema.Literal(1),
  coordinator_url: CoordinatorOrigin,
})
export type CoordinatorConfig = typeof CoordinatorConfig.Type

const decode = Schema.decodeUnknownSync(CoordinatorConfig)

// 接入链接只携带中心 HTTPS 源，不接受证书、路径或查询参数以外的输入。
export function parseConnectLink(raw: string): string {
  if (Buffer.byteLength(raw) > 2048) throw new Error('接入链接过长')
  if (raw.includes('#')) throw new Error('接入链接包含片段')
  const prefix = raw.startsWith('baton://connect/?')
    ? 'baton://connect/?'
    : raw.startsWith('baton://connect?')
      ? 'baton://connect?'
      : undefined
  if (!prefix) throw new Error('接入链接格式无效')
  const query = raw.slice(prefix.length)
  if (!query) throw new Error('接入链接缺少中心地址')
  const values = new Map<string, string>()
  for (const part of query.split('&')) {
    if (!part) throw new Error('接入链接参数无效')
    const separator = part.indexOf('=')
    if (separator <= 0) throw new Error('接入链接参数无效')
    const name = part.slice(0, separator)
    if (name !== 'url') throw new Error('接入链接包含未知参数')
    if (values.has(name)) throw new Error('接入链接参数重复')
    let value: string
    try {
      value = decodeURIComponent(part.slice(separator + 1))
    } catch {
      throw new Error('接入链接参数编码无效')
    }
    if (!value) throw new Error('接入链接缺少中心地址')
    values.set(name, value)
  }
  const value = values.get('url')
  if (!value) throw new Error('接入链接缺少中心地址')
  return decode({ format: 1, coordinator_url: value }).coordinator_url
}

export async function loadCoordinator(userData: string): Promise<CoordinatorConfig | undefined> {
  let value: string
  try {
    value = await readFile(join(userData, 'coordinator.json'), 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
  return decode(JSON.parse(value))
}

function temporary(userData: string) {
  return join(userData, `.coordinator.json.${randomUUID()}`)
}

export async function saveCoordinator(userData: string, coordinatorUrl: string): Promise<void> {
  const config = decode({ format: 1, coordinator_url: coordinatorUrl })
  await mkdir(userData, { recursive: true, mode: 0o700 })
  const target = join(userData, 'coordinator.json')
  const file = temporary(userData)
  const handle = await open(file, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(config) + '\n')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(file, target)
  } catch (error) {
    await unlink(file).catch(() => {})
    throw error
  }
}

export type LinkDecision = 'use' | 'replace' | 'conflict'

// 已绑定其他中心时拒绝替换；尚未绑定时允许经确认替换本地保存的地址。
export function linkDecision(saved: string | undefined, bound: string | undefined, candidate: string): LinkDecision {
  if (bound !== undefined && bound !== candidate) return 'conflict'
  if (saved !== undefined && saved !== candidate) return 'replace'
  return 'use'
}
