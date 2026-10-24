import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Json } from 'effect/Schema'
import { loadBrowseRoots } from '../daemon/roots.ts'
import { inside, openAuthorized } from './files.ts'
import { repositoryOrigin } from './scan.ts'
import { lstat } from 'node:fs/promises'

/** 只为登记目录内可打开的普通文件生成附件引用。 */
export async function parseThreadAttachments(
  dataDirectory: string,
  nodeId: string,
  workingDirectory: string,
  content: string,
): Promise<Json[]> {
  const roots = await loadBrowseRoots(dataDirectory)
  const result: Json[] = [],
    seen = new Set<string>()
  let candidates = 0
  for (const match of content.matchAll(/`([^`\r\n]+)`|"([^"\r\n]+)"|[^\s<>[\](){}"`]+/g)) {
    if (++candidates > 256 || result.length >= 32) break
    const candidate = match[1] ?? match[2] ?? match[0].replace(/[,;:.，。；：]+$/, '')
    if (!candidate || candidate.includes('://') || candidate.length > 4096 || !isAbsolute(workingDirectory) || !nodeId)
      continue
    const absolute = resolve(workingDirectory, candidate)
    for (const root of roots) {
      if (!inside(root.path, absolute)) continue
      const path = relative(root.path, absolute).split(sep).join('/')
      const key = `${root.id}:${path}`
      if (seen.has(key)) break
      try {
        const opened = await openAuthorized(root, path)
        try {
          if (!opened.info.isFile()) break
          const attachment: Json = { kind: 'file', node_id: nodeId, root_id: root.id, path, access_status: 'available' }
          if (Buffer.byteLength(JSON.stringify([...result, attachment])) + 512 > 4096) break
          result.push(attachment)
          seen.add(key)
        } finally {
          await opened.handle.close()
        }
      } catch {
        continue
      }
      break
    }
  }
  const commits = [...content.matchAll(/\bcommit[ \t]+([a-fA-F0-9]{40})\b/g)].slice(0, 32)
  if (commits.length) {
    let origin: string | undefined
    for (const root of roots) {
      if (!inside(root.path, workingDirectory)) continue
      let path = workingDirectory
      for (let depth = 0; depth < 64 && inside(root.path, path); depth++) {
        const rel = relative(root.path, path)
        if (await lstat(resolve(path, '.git')).catch(() => undefined)) {
          origin = await repositoryOrigin(root, rel).catch(() => undefined)
          break
        }
        if (path === root.path) break
        path = dirname(path)
      }
      if (origin) break
    }
    if (origin)
      for (const match of commits) {
        const sha = match[1].toLowerCase()
        if (seen.has(sha)) continue
        const attachment: Json = { kind: 'commit', repo: origin, sha }
        if (Buffer.byteLength(JSON.stringify([...result, attachment])) + 512 > 4096) break
        seen.add(sha)
        result.push(attachment)
      }
  }
  return result
}
