import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Schema } from 'effect'
import { SignedUpdateManifest } from '@baton/protocol/update-manifest'

export async function readUpdateManifest(directory: string) {
  const path = join(directory, 'update-manifest.json')
  const info = await lstat(path)
  if (!info.isFile() || info.size > 64 * 1024) throw new Error('更新清单无效')
  return Schema.decodeUnknownSync(SignedUpdateManifest)(JSON.parse(await readFile(path, 'utf8')))
}

export async function readUpdateArtifact(directory: string, name: string) {
  const manifest = await readUpdateManifest(directory)
  const entry = manifest.payload.artifacts.find((item) => item.file === name)
  if (!entry) return undefined
  const path = join(directory, entry.file)
  const info = await lstat(path)
  if (!info.isFile() || info.size !== entry.size) throw new Error('更新包大小不符')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  if (hash.digest('hex') !== entry.sha256) throw new Error('更新包摘要不符')
  return { path, size: entry.size }
}
