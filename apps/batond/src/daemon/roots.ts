import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Schema } from 'effect'
import { ensurePrivateDirectory, readPrivateFile, writePrivateFileAtomic } from '../platform/private.ts'
import { acquireProcessLock } from '../platform/lock.ts'
import { isMissing } from './identity.ts'

const Root = Schema.Struct({ id: Schema.String, path: Schema.String })
const Roots = Schema.Struct({
  roots: Schema.Array(Root).check(Schema.isMaxLength(4096)),
  maxRoots: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4096 }))),
})
export type BrowseRoot = typeof Root.Type
const inside = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

export async function readBrowseRootsConfig(dataDirectory: string) {
  const raw = await readPrivateFile(join(dataDirectory, 'browse-roots.json'))
  try {
    const config = Schema.decodeUnknownSync(Roots)(JSON.parse(raw.toString('utf8')))
    const { roots } = config
    if (
      roots.some((r) => !/^[a-z][a-z0-9._-]{0,63}$/.test(r.id) || !isAbsolute(r.path)) ||
      new Set(roots.map((r) => r.id)).size !== roots.length
    )
      throw new Error()
    return { ...config, maxRoots: config.maxRoots ?? 256 }
  } catch {
    throw new Error('授权目录配置无效')
  }
}

export async function loadBrowseRoots(dataDirectory: string): Promise<ReadonlyArray<BrowseRoot>> {
  return (await readBrowseRootsConfig(dataDirectory)).roots
}

/** An existing empty configuration is an explicit denial of directory access. */
export async function initializeBrowseRoots(
  dataDirectory: string,
  workspace?: string,
): Promise<ReadonlyArray<BrowseRoot>> {
  await ensurePrivateDirectory(dataDirectory)
  const release = await acquireProcessLock(join(dataDirectory, 'browse-roots.lock'))
  try {
    let roots: BrowseRoot[]
    let maxRoots = 256
    let changed = false
    try {
      const config = await readBrowseRootsConfig(dataDirectory)
      roots = [...config.roots]
      maxRoots = config.maxRoots
    } catch (error) {
      if (!isMissing(error)) throw error
      const path = await realpath(homedir())
      roots = [{ id: 'home', path }]
      changed = true
    }
    if (workspace) {
      if (!isAbsolute(workspace)) throw new Error('--workspace 需要绝对路径')
      const path = await realpath(workspace)
      if (!(await stat(path)).isDirectory()) throw new Error('工作目录必须是目录')
      if (!roots.some((root) => root.path === path)) {
        if (roots.length >= maxRoots) throw new Error(`授权目录最多 ${maxRoots} 个`)
        roots.push({ id: `root-${createHash('sha256').update(path).digest('hex').slice(0, 16)}`, path })
        changed = true
      }
    }
    if (changed)
      await writePrivateFileAtomic(join(dataDirectory, 'browse-roots.json'), JSON.stringify({ roots, maxRoots }))
    return roots
  } finally {
    await release()
  }
}

export async function authorizeDirectory(dataDirectory: string, path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('工作目录需要绝对路径')
  const actual = await realpath(path)
  if (!(await stat(actual)).isDirectory()) throw new Error('工作目录必须是目录')
  for (const root of await loadBrowseRoots(dataDirectory)) {
    // Replacing a registered root with a symlink must not grant access to its new target.
    if ((await realpath(root.path)) !== resolve(root.path)) continue
    if (inside(root.path, actual)) return actual
  }
  throw new Error('工作目录超出本机授权目录')
}
