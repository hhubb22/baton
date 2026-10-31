import { randomUUID } from 'node:crypto'
import { lstat, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Schema } from 'effect'
import {
  ensurePrivateDirectory,
  readPrivateFile,
  validatePrivateDirectory,
  writePrivateFileAtomic,
} from './platform/private.ts'
import { acquireProcessLock, ProcessLockBusy } from './platform/lock.ts'
import { fileVersion } from './platform/file-version.ts'

const Values = Schema.Record(Schema.String, Schema.NullOr(Schema.String))
const Layers = Schema.Record(Schema.String, Values)
const Configuration = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.String,
  diagnostic: Schema.optionalKey(Schema.String),
  imported: Values,
  scopes: Layers,
})
export type EnvironmentConfiguration = typeof Configuration.Type
const empty = (): EnvironmentConfiguration => ({ version: 1, revision: '', imported: {}, scopes: {} })

const common = new Set([
  'PATH',
  'PATHEXT',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LANGUAGE',
  'TZ',
  'NODE_EXTRA_CA_CERTS',
  'NODE_USE_SYSTEM_CA',
  'NODE_USE_ENV_PROXY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'GIT_SSL_CAINFO',
  'GIT_SSL_CAPATH',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_DIRS',
  'XDG_DATA_DIRS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
])
const volatile = new Set([
  'SSH_AUTH_SOCK',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_RUNTIME_DIR',
])
const agentNames: Record<string, readonly string[]> = {
  codex: ['CODEX_HOME'],
  pi: ['PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR'],
  cursor: ['CURSOR_API_KEY'],
}
const allowed = (name: string) => common.has(name.toUpperCase()) || /^LC_[A-Z0-9_]+$/i.test(name)
const forbidden = (name: string) =>
  /^(NODE_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED|LD_PRELOAD|DYLD_.*|BASH_ENV|BATON_.*|OTEL_.*)$/i.test(name)
const sensitive = (name: string, value: string) => {
  if (!/^(HTTP|HTTPS|ALL)_PROXY$/i.test(name)) return false
  try {
    const url = new URL(value)
    return !!(url.username || url.password)
  } catch {
    return false
  }
}

export function resolveEnvironment(
  config: EnvironmentConfiguration,
  source: NodeJS.ProcessEnv = process.env,
  options: { agent?: string; project?: string; platform?: NodeJS.Platform } = {},
): { env: NodeJS.ProcessEnv; diagnostics: string[]; revision: string } {
  const windows = (options.platform ?? process.platform) === 'win32'
  const env: NodeJS.ProcessEnv = {}
  const keys = new Map<string, string>()
  const suppressed = new Set<string>()
  const apply = (values: Readonly<Record<string, string | null | undefined>>) => {
    for (const [name, value] of Object.entries(values)) {
      if (forbidden(name) || name.includes('=') || name.includes('\0')) continue
      const normalized = windows ? name.toUpperCase() : name
      if (value === null) suppressed.add(normalized)
      else if (value !== undefined) suppressed.delete(normalized)
      if (!windows && value === null && /^(HTTP|HTTPS|ALL|NO)_PROXY$/i.test(name)) {
        const alias = name === name.toUpperCase() ? name.toLowerCase() : name.toUpperCase()
        delete env[alias]
        keys.delete(alias)
        suppressed.add(alias)
      }
      const old = keys.get(normalized)
      if (old) delete env[old]
      keys.delete(normalized)
      if (value !== null && value !== undefined) {
        env[name] = value
        keys.set(normalized, name)
      }
    }
  }
  apply(
    Object.fromEntries(
      Object.entries(source).filter(
        ([name]) =>
          allowed(name) ||
          volatile.has(name.toUpperCase()) ||
          (options.agent && agentNames[options.agent]?.includes(name)),
      ),
    ),
  )
  apply(config.imported)
  apply(config.scopes.device ?? {})
  if (options.project) apply(config.scopes[`project:${options.project}`] ?? {})
  if (options.agent) apply(config.scopes[`agent:${options.agent}`] ?? {})
  if (options.project && options.agent) apply(config.scopes[`project:${options.project}:agent:${options.agent}`] ?? {})
  for (const [agent, names] of Object.entries(agentNames))
    if (agent !== options.agent)
      for (const name of names) {
        const key = keys.get(windows ? name.toUpperCase() : name)
        if (key) delete env[key]
      }
  const diagnostics: string[] = []
  if (!windows)
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
      const lower = name.toLowerCase()
      if (env[name] !== undefined && env[lower] !== undefined && env[name] !== env[lower])
        diagnostics.push(`${name} 与 ${lower} 的值不同`)
      else if (env[name] !== undefined && env[lower] === undefined && !suppressed.has(lower)) env[lower] = env[name]
      else if (env[lower] !== undefined && env[name] === undefined && !suppressed.has(name)) env[name] = env[lower]
    }
  if (
    !keys.has('NODE_USE_ENV_PROXY') &&
    !suppressed.has('NODE_USE_ENV_PROXY') &&
    (keys.has('HTTP_PROXY') || keys.has('HTTPS_PROXY') || keys.has('http_proxy') || keys.has('https_proxy'))
  )
    env.NODE_USE_ENV_PROXY = '1'
  return { env, diagnostics, revision: config.revision }
}

async function readEnvironment(dataDirectory: string, retry = true): Promise<EnvironmentConfiguration> {
  const directory = join(dataDirectory, 'environment')
  let raw: Buffer
  try {
    raw = await readPrivateFile(join(directory, 'environment.json'))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return empty()
    throw error
  }
  let config: EnvironmentConfiguration
  try {
    config = Schema.decodeUnknownSync(Configuration)(JSON.parse(raw.toString()))
  } catch {
    throw new Error('设备环境配置损坏')
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(config.revision))
    throw new Error('Invalid environment revision')
  let secretRaw: Buffer
  try {
    secretRaw = await readPrivateFile(join(directory, `secrets-${config.revision}.json`))
  } catch (error) {
    if (retry && error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      const current = await readPrivateFile(join(directory, 'environment.json'))
      if (!current.equals(raw)) return readEnvironment(dataDirectory, false)
    }
    throw new Error('设备环境秘密文件不可读取')
  }
  let secrets: EnvironmentConfiguration
  try {
    secrets = Schema.decodeUnknownSync(Configuration)(JSON.parse(secretRaw.toString()))
  } catch {
    throw new Error('设备环境秘密文件损坏')
  }
  if (config.revision !== secrets.revision) throw new Error('Environment secrets revision mismatch')
  return {
    ...config,
    imported: { ...config.imported, ...secrets.imported },
    scopes: Object.fromEntries(
      [...new Set([...Object.keys(config.scopes), ...Object.keys(secrets.scopes)])].map((scope) => [
        scope,
        { ...config.scopes[scope], ...secrets.scopes[scope] },
      ]),
    ),
  }
}

async function lockEnvironment(directory: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return await acquireProcessLock(join(directory, 'configuration.lock'))
    } catch (error) {
      if (!(error instanceof ProcessLockBusy) || attempt === 99) throw error
      await delay(25)
    }
  }
  throw new Error('无法获取设备环境配置锁')
}

export async function loadEnvironment(dataDirectory: string): Promise<EnvironmentConfiguration> {
  const directory = join(dataDirectory, 'environment')
  try {
    await lstat(directory)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return empty()
    throw error
  }
  const release = await lockEnvironment(directory)
  try {
    return await readEnvironment(dataDirectory)
  } finally {
    await release()
  }
}

/** A process-local reader; unchanged configuration never acquires or publishes a disk lock. */
export function makeEnvironmentReader(dataDirectory: string): () => Promise<EnvironmentConfiguration> {
  const directory = join(dataDirectory, 'environment')
  let cached: { version: string; config: EnvironmentConfiguration } | undefined
  const version = async (revision: string) => {
    try {
      await validatePrivateDirectory(directory)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'missing'
      throw error
    }
    return JSON.stringify([
      await fileVersion(join(directory, 'environment.json')),
      ...(revision ? [await fileVersion(join(directory, `secrets-${revision}.json`))] : []),
    ])
  }
  return async () => {
    const before = await version(cached?.config.revision ?? '')
    if (cached?.version === before) return structuredClone(cached.config)
    const config = await loadEnvironment(dataDirectory)
    const after = await version(config.revision)
    // Include the new secret filename without caching a snapshot read across a replacement.
    if ((await version(cached?.config.revision ?? '')) === before) cached = { version: after, config }
    else cached = undefined
    return structuredClone(config)
  }
}

export async function updateEnvironment(
  dataDirectory: string,
  update: (config: EnvironmentConfiguration) => EnvironmentConfiguration,
): Promise<EnvironmentConfiguration> {
  const directory = join(dataDirectory, 'environment')
  await ensurePrivateDirectory(dataDirectory)
  await ensurePrivateDirectory(directory)
  const release = await lockEnvironment(directory)
  try {
    const current = await readEnvironment(dataDirectory)
    const updated = update(current)
    if (updated === current) return current
    for (const layer of [updated.imported, ...Object.values(updated.scopes)])
      for (const [name, value] of Object.entries(layer)) {
        if (
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
          forbidden(name) ||
          (value !== null && (volatile.has(name.toUpperCase()) || value.includes('\0')))
        )
          throw new Error('设备环境变量名称或值无效')
      }
    const next = { ...updated, version: 1 as const, revision: randomUUID() }
    const publicConfig: EnvironmentConfiguration = {
      version: 1,
      revision: next.revision,
      imported: {},
      scopes: {},
      ...(next.diagnostic ? { diagnostic: next.diagnostic } : {}),
    }
    const privateConfig: EnvironmentConfiguration = { version: 1, revision: next.revision, imported: {}, scopes: {} }
    const split = (values: Readonly<Record<string, string | null>>, scope?: string) => {
      for (const [name, value] of Object.entries(values)) {
        const secret =
          value !== null &&
          (scope !== undefined || sensitive(name, value) || /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name))
        const target = secret ? privateConfig : publicConfig
        const layer = scope
          ? ((target.scopes as Record<string, Record<string, string | null>>)[scope] ??= {})
          : (target.imported as Record<string, string | null>)
        layer[name] = value
      }
    }
    split(next.imported)
    for (const [scope, values] of Object.entries(next.scopes)) split(values, scope)
    await writePrivateFileAtomic(join(directory, `secrets-${next.revision}.json`), JSON.stringify(privateConfig))
    await writePrivateFileAtomic(join(directory, 'environment.json'), JSON.stringify(publicConfig))
    try {
      for (const file of await readdir(directory)) {
        if (/^secrets-[0-9a-f-]{36}\.json$/.test(file) && file !== `secrets-${next.revision}.json`)
          await unlink(join(directory, file))
      }
    } catch {
      throw new Error('设备环境已保存，但旧秘密文件清理失败')
    }
    return next
  } finally {
    await release()
  }
}

export async function importEnvironment(
  dataDirectory: string,
  source: NodeJS.ProcessEnv = process.env,
): Promise<EnvironmentConfiguration> {
  return updateEnvironment(dataDirectory, (config) => {
    const { diagnostic: _diagnostic, ...rest } = config
    return {
      ...rest,
      imported: Object.fromEntries(
        Object.entries(source).filter(([name, value]) => value !== undefined && allowed(name) && !forbidden(name)),
      ) as Record<string, string>,
    }
  })
}

export async function initializeEnvironment(
  dataDirectory: string,
  source: NodeJS.ProcessEnv = process.env,
  diagnostic?: string,
): Promise<EnvironmentConfiguration> {
  return updateEnvironment(dataDirectory, (config) =>
    config.revision
      ? config
      : {
          ...config,
          ...(diagnostic ? { diagnostic } : {}),
          imported: Object.fromEntries(
            Object.entries(source).filter(([name, value]) => value !== undefined && allowed(name) && !forbidden(name)),
          ) as Record<string, string>,
        },
  )
}

export function agentSource(agent: string, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([name]) => allowed(name) || volatile.has(name.toUpperCase()) || agentNames[agent]?.includes(name),
    ),
  )
}

export function baseEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let previous: string[] = []
  try {
    previous = Schema.decodeUnknownSync(Schema.Array(Schema.String))(
      JSON.parse(source.BATON_ENV_MANAGED_KEYS ?? '[]'),
    ) as string[]
  } catch {
    throw new Error('设备环境进程标记无效')
  }
  const base = { ...source }
  for (const name of previous) {
    if (volatile.has(name.toUpperCase())) continue
    for (const key of Object.keys(base))
      if (process.platform === 'win32' ? key.toUpperCase() === name.toUpperCase() : key === name) delete base[key]
  }
  return base
}

export function applyEnvironment(
  config: EnvironmentConfiguration,
  source: NodeJS.ProcessEnv,
  options: { project?: string } = {},
): NodeJS.ProcessEnv {
  const env = { ...source }
  for (const name of Object.keys(env))
    if (/^(NODE_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED|LD_PRELOAD|DYLD_.*|BASH_ENV)$/i.test(name)) delete env[name]
  const base = baseEnvironment(source)
  const previous = Object.keys(source).filter((name) => !(name in base))
  const managed = new Set([
    ...previous,
    ...Object.keys(agentSource('', source)),
    ...Object.keys(config.imported),
    ...Object.values(config.scopes).flatMap(Object.keys),
  ])
  for (const name of managed) {
    for (const key of Object.keys(env))
      if (process.platform === 'win32' ? key.toUpperCase() === name.toUpperCase() : key === name) delete env[key]
  }
  const resolved = resolveEnvironment(config, base, options).env
  for (const name of Object.keys(resolved)) if (!volatile.has(name.toUpperCase())) managed.add(name)
  Object.assign(env, resolved)
  env.BATON_ENV_MANAGED_KEYS = JSON.stringify([...managed])
  return env
}

export async function loadProcessEnvironment(
  dataDirectory: string,
  source: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const config = await loadEnvironment(dataDirectory)
  return config.revision ? applyEnvironment(config, source) : source
}
