import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Schema } from 'effect'
import { hasCode } from '../platform/errors.ts'
import { readPrivateFile, writePrivateFileAtomic } from '../platform/private.ts'
import { withConfigurationLock } from './config-lock.ts'
import { containsControl, DeviceError } from './errors.ts'

const rootIdPattern = /^[a-z][a-z0-9._-]{0,63}$/
const Root = Schema.Struct({ id: Schema.String, path: Schema.String })
const Roots = Schema.Struct({
  roots: Schema.Array(Root).check(Schema.isMaxLength(4096)),
  maxRoots: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4096 }))),
})
export type BrowseRoot = typeof Root.Type
export type RootChange = { readonly action: 'add' | 'remove'; readonly path: string; readonly id?: string }

const inside = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

async function readBrowseRootsConfig(dataDirectory: string) {
  const raw = await readPrivateFile(join(dataDirectory, 'browse-roots.json'))
  try {
    const config = Schema.decodeUnknownSync(Roots)(JSON.parse(raw.toString('utf8')))
    const { roots } = config
    if (
      roots.some((r) => !rootIdPattern.test(r.id) || !isAbsolute(r.path)) ||
      new Set(roots.map((r) => r.id)).size !== roots.length
    )
      throw new Error()
    return { ...config, maxRoots: config.maxRoots ?? 256 }
  } catch {
    throw new Error('授权目录配置无效')
  }
}

async function readOrDefault(dataDirectory: string, defaultRoots: () => Promise<BrowseRoot[]>) {
  try {
    return await readBrowseRootsConfig(dataDirectory)
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error
    return { roots: await defaultRoots(), maxRoots: 256 }
  }
}

async function saveRoots(dataDirectory: string, roots: readonly BrowseRoot[], maxRoots: number): Promise<void> {
  await writePrivateFileAtomic(join(dataDirectory, 'browse-roots.json'), JSON.stringify({ roots, maxRoots }))
}

function appendRoot(roots: BrowseRoot[], maxRoots: number, path: string, id?: string): boolean {
  if (id && roots.some((root) => root.id === id && root.path !== path))
    throw new DeviceError('invalid_path', '目录标识已存在')
  if (roots.some((root) => root.path === path)) return false
  if (roots.length >= maxRoots) throw new DeviceError('config_unavailable', `授权目录最多 ${maxRoots} 个`)
  const baseId = id ?? `root-${createHash('sha256').update(path).digest('hex').slice(0, 16)}`
  let rootId = baseId
  for (let suffix = 2; roots.some((root) => root.id === rootId); suffix++) rootId = `${baseId}-${suffix}`
  roots.push({ id: rootId, path })
  return true
}

export async function loadBrowseRoots(dataDirectory: string): Promise<readonly BrowseRoot[]> {
  return (await readBrowseRootsConfig(dataDirectory)).roots
}

/** 已保存的空列表拒绝目录访问；只有缺失配置时才登记主目录。 */
export async function initializeBrowseRoots(dataDirectory: string, workspace?: string): Promise<readonly BrowseRoot[]> {
  return withConfigurationLock(dataDirectory, 'browse-roots', async () => {
    let changed = false
    const config = await readOrDefault(dataDirectory, async () => {
      changed = true
      return [{ id: 'home', path: await realpath(homedir()) }]
    })
    const roots = [...config.roots]
    if (workspace) {
      if (!isAbsolute(workspace)) throw new Error('--workspace 需要绝对路径')
      const path = await realpath(workspace)
      if (!(await stat(path)).isDirectory()) throw new Error('工作目录必须是目录')
      changed = appendRoot(roots, config.maxRoots, path) || changed
    }
    if (changed) await saveRoots(dataDirectory, roots, config.maxRoots)
    return roots
  })
}

export async function updateBrowseRoots(dataDirectory: string, change: RootChange): Promise<readonly BrowseRoot[]> {
  const { action, path: target, id } = change
  if (!target || Buffer.byteLength(target) > 4096 || containsControl(target))
    throw new DeviceError('invalid_path', '目录路径无效')
  if (action === 'remove' && !isAbsolute(target) && !rootIdPattern.test(target))
    throw new DeviceError('invalid_path', '目录标识不正确')
  if (id && !rootIdPattern.test(id)) throw new DeviceError('invalid_path', '目录标识不正确')
  return withConfigurationLock(dataDirectory, 'browse-roots', async () => {
    const config = await readOrDefault(dataDirectory, async () => [])
    let roots = [...config.roots]
    if (action === 'add') {
      if (!isAbsolute(target)) throw new DeviceError('invalid_path', '目录需要绝对路径')
      let path: string
      try {
        path = await realpath(target)
        if (!(await stat(path)).isDirectory()) throw new Error()
      } catch {
        throw new DeviceError('invalid_path', '目录不存在或无法访问')
      }
      if (!appendRoot(roots, config.maxRoots, path, id)) return roots
    } else {
      let actual = target
      if (isAbsolute(target)) actual = await realpath(target).catch(() => resolve(target))
      roots = roots.filter((root) => root.id !== target && root.path !== actual && root.path !== target)
    }
    await saveRoots(dataDirectory, roots, config.maxRoots)
    return loadBrowseRoots(dataDirectory)
  })
}

export async function authorizeDirectory(dataDirectory: string, path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('工作目录需要绝对路径')
  const actual = await realpath(path)
  if (!(await stat(actual)).isDirectory()) throw new Error('工作目录必须是目录')
  for (const root of await loadBrowseRoots(dataDirectory)) {
    // 登记根被替换为符号链接后，其新目标不获得授权。
    if ((await realpath(root.path)) !== resolve(root.path)) continue
    if (inside(root.path, actual)) return actual
  }
  throw new Error('工作目录超出本机授权目录')
}
