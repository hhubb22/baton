import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { RuntimeExec } from '@baton/protocol'
import { Schema } from 'effect'
import { loadBrowseRoots, type BrowseRoot } from '../daemon/roots.ts'
import { isMissing } from '../daemon/identity.ts'
import { ensurePrivateDirectory, readPrivateFile, writePrivateFileAtomic } from '../platform/private.ts'
import { acquireProcessLock } from '../platform/lock.ts'

export class DeviceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export const containsControl = (value: string): boolean =>
  Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)

const queues = new Map<string, Promise<unknown>>()
export async function withConfigurationLock<A>(
  dataDirectory: string,
  name: string,
  action: () => Promise<A>,
): Promise<A> {
  const key = join(resolve(dataDirectory), `${name}.lock`)
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await ensurePrivateDirectory(dataDirectory)
      const release = await acquireProcessLock(key)
      try {
        return await action()
      } finally {
        await release()
      }
    })
  queues.set(key, next)
  try {
    return await next
  } finally {
    if (queues.get(key) === next) queues.delete(key)
  }
}

export async function updateBrowseRoots(
  dataDirectory: string,
  action: 'add' | 'remove',
  target: string,
  id?: string,
): Promise<ReadonlyArray<BrowseRoot>> {
  if (!target || Buffer.byteLength(target) > 4096 || containsControl(target))
    throw new DeviceError('invalid_path', '目录路径无效')
  if (action === 'remove' && !isAbsolute(target) && !/^[a-z][a-z0-9._-]{0,63}$/.test(target))
    throw new DeviceError('invalid_path', '目录标识不正确')
  if (id && !/^[a-z][a-z0-9._-]{0,63}$/.test(id)) throw new DeviceError('invalid_path', '目录标识不正确')
  return withConfigurationLock(dataDirectory, 'browse-roots', async () => {
    let roots: BrowseRoot[]
    try {
      roots = [...(await loadBrowseRoots(dataDirectory))]
    } catch (error) {
      if (!isMissing(error)) throw error
      roots = []
    }
    if (action === 'add') {
      if (!isAbsolute(target)) throw new DeviceError('invalid_path', '目录需要绝对路径')
      let path: string
      try {
        path = await realpath(target)
        if (!(await stat(path)).isDirectory()) throw new Error()
      } catch {
        throw new DeviceError('invalid_path', '目录不存在或无法访问')
      }
      if (id && roots.some((root) => root.id === id && root.path !== path))
        throw new DeviceError('invalid_path', '目录标识已存在')
      if (roots.some((root) => root.path === path)) return roots
      if (roots.length >= 32) throw new DeviceError('config_unavailable', '授权目录最多 32 个')
      const baseId = id ?? `root-${createHash('sha256').update(path).digest('hex').slice(0, 16)}`
      let rootId = baseId
      for (let suffix = 2; roots.some((root) => root.id === rootId); suffix++) rootId = `${baseId}-${suffix}`
      roots.push({ id: rootId, path })
    } else {
      let actual = target
      if (isAbsolute(target)) actual = await realpath(target).catch(() => resolve(target))
      roots = roots.filter((root) => root.id !== target && root.path !== actual && root.path !== target)
    }
    await writePrivateFileAtomic(join(dataDirectory, 'browse-roots.json'), JSON.stringify({ roots }))
    return loadBrowseRoots(dataDirectory)
  })
}

export function defaultProjectShell(): string {
  return process.platform === 'win32' ? 'pwsh' : process.env.SHELL?.trim() || '/bin/sh'
}
const Config = Schema.Struct({ enabled: Schema.Boolean, shell: RuntimeExec.fields.shell })
export async function readProjectExec(dataDirectory: string): Promise<RuntimeExec> {
  let config: typeof Config.Type
  try {
    const raw = await readPrivateFile(join(dataDirectory, 'project-exec.json'))
    if (raw.length > 8192) throw new Error()
    config = Schema.decodeUnknownSync(Config)(JSON.parse(raw.toString('utf8')), { onExcessProperty: 'error' })
  } catch (error) {
    if (!isMissing(error)) throw new DeviceError('config_unavailable', 'Project Agent 命令配置无效')
    config = Schema.decodeUnknownSync(Config)({ enabled: false, shell: defaultProjectShell() })
  }
  try {
    return { ...config, user: userInfo().username }
  } catch {
    return config
  }
}
async function saveExec(dataDirectory: string, config: RuntimeExec): Promise<RuntimeExec> {
  const value = Schema.decodeUnknownSync(Config)({ enabled: config.enabled, shell: config.shell })
  await writePrivateFileAtomic(join(dataDirectory, 'project-exec.json'), JSON.stringify(value))
  return readProjectExec(dataDirectory)
}
export async function writeProjectExec(dataDirectory: string, config: RuntimeExec): Promise<RuntimeExec> {
  return withConfigurationLock(dataDirectory, 'project-exec', () => saveExec(dataDirectory, config))
}
export async function setProjectExec(dataDirectory: string, enabled: boolean): Promise<RuntimeExec> {
  Schema.decodeUnknownSync(Schema.Boolean)(enabled)
  return withConfigurationLock(dataDirectory, 'project-exec', async () =>
    saveExec(dataDirectory, { ...(await readProjectExec(dataDirectory)), enabled }),
  )
}
