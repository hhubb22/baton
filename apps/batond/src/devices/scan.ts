import { execFile } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { RuntimeRepo, RuntimeRoot } from '@baton/protocol'
import { loadBrowseRoots, type BrowseRoot } from './roots.ts'
import { boundedDirectory, inside, openAuthorized, readBounded } from './files.ts'
import { containsControl } from './errors.ts'

/** origin 只公开主机和仓库路径，去掉账号、口令、查询与片段。 */
export function sanitizeOrigin(value: string): string | undefined {
  let host: string, path: string
  try {
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
      const url = new URL(value)
      if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol)) return undefined
      host = url.hostname
      path = url.pathname
    } else {
      const match = /^(?:[^@/\s]+@)?([^:/\s]+):([^\s]+)$/.exec(value)
      if (!match) return undefined
      host = match[1]
      path = match[2]
    }
    path = path
      .replace(/^\/+/, '')
      .split(/[?#]/, 1)[0]
      .replace(/\.git$/, '')
    const origin = `${host}/${path}`
    if (
      !path ||
      Buffer.byteLength(origin) > 4096 ||
      !/^[^@\\ :?#]+\/[^@\\?#]+$/.test(origin) ||
      containsControl(origin) ||
      origin.includes(' ')
    )
      return undefined
    return origin
  } catch {
    return undefined
  }
}

async function metadataPath(root: BrowseRoot, base: string, target: string): Promise<string> {
  const path = isAbsolute(target) ? resolve(target) : resolve(root.path, base, target)
  if (!inside(root.path, path)) throw new Error('Git 元数据超出授权目录')
  const rel = relative(root.path, path)
  const opened = await openAuthorized(root, rel)
  await opened.handle.close()
  return rel
}
export async function repositoryOrigin(root: BrowseRoot, path: string): Promise<string | undefined> {
  let git = join(path, '.git')
  const opened = await openAuthorized(root, git)
  const directory = opened.info.isDirectory()
  await opened.handle.close()
  if (!directory) {
    const pointer = (await readBounded(root, git, 4096)).toString('utf8').trim()
    if (!pointer.startsWith('gitdir: ')) throw new Error('Git 元数据无效')
    git = await metadataPath(root, path, pointer.slice(8).trim())
  }
  const common = await lstat(join(root.path, git, 'commondir')).catch(() => undefined)
  if (common)
    git = await metadataPath(root, git, (await readBounded(root, join(git, 'commondir'), 4096)).toString('utf8').trim())
  const config = (await readBounded(root, join(git, 'config'), 16 * 1024)).toString('utf8')
  const value = await new Promise<string>((resolveValue, reject) => {
    const child = execFile(
      'git',
      ['config', '--no-includes', '--file', '-', '--get', 'remote.origin.url'],
      { timeout: 200, maxBuffer: 16 * 1024, encoding: 'utf8', windowsHide: true },
      (error, stdout) => {
        if (error && error.code !== 1) reject(new Error('无法读取 Git origin'))
        else resolveValue(stdout.trim())
      },
    )
    child.stdin?.on('error', () => {})
    child.stdin?.end(config)
  })
  return value ? sanitizeOrigin(value) : undefined
}
export async function scanRuntimeRoots(
  dataDirectory: string,
  signal?: AbortSignal,
): Promise<{
  roots: RuntimeRoot[]
  repos: RuntimeRepo[]
  truncated: boolean
}> {
  const registered = await loadBrowseRoots(dataDirectory)
  // 授权根清单独立于仓库遍历预算，实际访问时重新核实真实路径。
  const roots: RuntimeRoot[] = registered.map((root) => ({ root_id: root.id, path: root.path }))
  const repos: RuntimeRepo[] = []
  let remaining = 4096,
    truncated = false
  const deadline = performance.now() + 2000
  const seen = new Set<string>()
  const exhausted = () => signal?.aborted || performance.now() >= deadline || remaining <= 0 || repos.length >= 128
  for (const root of registered) {
    if (exhausted()) {
      truncated = true
      break
    }
    try {
      const opened = await openAuthorized(root, '')
      await opened.handle.close()
    } catch {
      truncated = true
      continue
    }
    const walk = async (path: string, depth: number): Promise<void> => {
      if (exhausted()) {
        truncated = true
        return
      }
      try {
        const listing = await boundedDirectory(root, path, remaining, signal)
        remaining -= listing.scanned
        truncated ||= listing.limited
        if (listing.names.includes('.git')) {
          const absolute = resolve(root.path, path)
          if (!seen.has(absolute)) {
            seen.add(absolute)
            let origin: string | undefined
            try {
              origin = await repositoryOrigin(root, path)
            } catch {
              truncated = true
            }
            repos.push({ path: absolute, ...(origin ? { origin } : {}) })
          }
        }
        if (depth >= 4) {
          truncated ||= listing.names.length > 0
          return
        }
        for (const name of listing.names) {
          if (name === '.git') continue
          if (exhausted()) {
            truncated = true
            return
          }
          const rel = join(path, name)
          const info = await lstat(join(root.path, rel)).catch(() => undefined)
          if (info?.isDirectory() && !info.isSymbolicLink()) await walk(rel, depth + 1)
        }
      } catch {
        truncated = true
      }
    }
    await walk('', 0)
  }
  return { roots, repos: repos.sort((a, b) => a.path.localeCompare(b.path)), truncated }
}
