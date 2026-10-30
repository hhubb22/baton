// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="./unzipper.d.ts" />
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as tar from 'tar'
import { Open } from 'unzipper'
import type { SignedUpdateManifest } from '@baton/protocol/update-manifest'

type Artifact = SignedUpdateManifest['payload']['artifacts'][number]
const maxExtractedBytes = 8 * 1024 * 1024 * 1024
const maxEntries = 100000

export async function verifyArchive(path: string, artifact: Artifact) {
  let size = 0
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    const data = Buffer.from(chunk)
    size += data.length
    if (size > artifact.size) throw new Error('更新包超过声明大小')
    hash.update(data)
  }
  if (size !== artifact.size || hash.digest('hex') !== artifact.sha256) throw new Error('更新包摘要或大小不符')
}

function entries() {
  const names = new Set<string>()
  let root: string | undefined
  let count = 0
  let total = 0
  return (name: string, size: number, directory: boolean) => {
    if (++count > maxEntries || !Number.isSafeInteger(size) || size < 0 || (total += size) > maxExtractedBytes)
      throw new Error('更新包解压内容超过限制')
    if (
      !name ||
      name.length > 4096 ||
      name.includes('\\') ||
      name.startsWith('/') ||
      Array.from(name).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    )
      throw new Error('更新包路径无效')
    const parts = name.replace(/\/$/, '').split('/')
    if (
      parts.some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          part.includes(':') ||
          (process.platform === 'win32' &&
            (/[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))),
      )
    )
      throw new Error('更新包路径无效')
    root ??= parts[0]
    if (root !== parts[0] || (parts.length === 1 && !directory)) throw new Error('更新包目录结构无效')
    const relative = parts.slice(1).join('/')
    if (!relative) return ''
    const identity = process.platform === 'win32' ? relative.toLowerCase() : relative
    if (names.has(identity)) throw new Error('更新包包含重复路径')
    names.add(identity)
    return relative
  }
}

/** Extract only regular files and directories from a previously signed, hash-checked archive. */
export async function extractUpdateArchive(path: string, target: string, artifact: Artifact) {
  await verifyArchive(path, artifact)
  const record = entries()
  let created = false
  try {
    await mkdir(target, { mode: 0o700 })
    created = true
    if (artifact.file.endsWith('.tar.gz')) {
      await tar.x({
        file: path,
        cwd: target,
        strip: 1,
        strict: true,
        preservePaths: false,
        filter: function (this: tar.Unpack, name, entry) {
          try {
            if (!('type' in entry)) throw new Error('更新包条目无效')
            if (entry.type !== 'File' && entry.type !== 'Directory') throw new Error('更新包包含不支持的文件类型')
            return Boolean(record(name, entry.size, entry.type === 'Directory'))
          } catch (error) {
            this.abort(error instanceof Error ? error : new Error('更新包无效'))
            return false
          }
        },
      })
    } else if (artifact.file.endsWith('.zip')) {
      const archive = await Open.file(path)
      for (const entry of archive.files) {
        const mode = (entry.externalFileAttributes >>> 16) & 0xf000
        if (
          (entry.type !== 'File' && entry.type !== 'Directory') ||
          (entry.flags & 1) !== 0 ||
          (mode !== 0 && mode !== 0x8000 && mode !== 0x4000)
        )
          throw new Error('更新包包含不支持的文件类型')
        const relative = record(entry.path, entry.uncompressedSize, entry.type === 'Directory')
        if (!relative) continue
        const destination = join(target, relative)
        if (entry.type === 'Directory') {
          await mkdir(destination, { recursive: true, mode: 0o700 })
          continue
        }
        await mkdir(join(destination, '..'), { recursive: true, mode: 0o700 })
        let size = 0
        await pipeline(
          entry.stream(),
          new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              size += chunk.length
              if (size > entry.uncompressedSize) return callback(new Error('更新包文件大小不符'))
              callback(null, chunk)
            },
          }),
          createWriteStream(destination, { flags: 'wx', mode: 0o700 }),
        )
        if (size !== entry.uncompressedSize) throw new Error('更新包文件大小不符')
      }
    } else throw new Error('更新包格式不受支持')
    await verifyArchive(path, artifact)
  } catch (error) {
    if (created) await rm(target, { recursive: true, force: true })
    throw error
  }
}
