import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyUpdateManifest } from '../packages/protocol/src/update-manifest.ts'

export async function verifyRelease(directory, trustedKeys, version) {
  const manifest = verifyUpdateManifest(
    JSON.parse(await readFile(join(directory, 'update-manifest.json'), 'utf8')),
    trustedKeys,
  )
  if (manifest.payload.version !== version) throw new Error('发布版本与清单不匹配')
  for (const artifact of manifest.payload.artifacts) {
    const path = join(directory, artifact.file)
    const info = await lstat(path)
    if (!info.isFile() || info.size !== artifact.size) throw new Error('发布文件大小或类型不匹配')
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    if (hash.digest('hex') !== artifact.sha256) throw new Error('发布文件摘要不匹配')
  }
  const image = (await readFile(join(directory, 'server-image.txt'), 'utf8')).trim()
  if (image !== manifest.payload.server_image) throw new Error('中心镜像摘要与签名清单不匹配')
  if (!/^ghcr\.io\/hhubb22\/baton@sha256:[a-f0-9]{64}$/.test(image))
    throw new Error('中心镜像必须固定到 Baton 的 GHCR 摘要')
  return { image, manifest }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, keysFile, version] = process.argv.slice(2)
  if (!directory || !keysFile || !version)
    throw new Error('用法：node tools/verify-release.mjs <制品目录> <公钥 JSON> <版本>')
  const { image } = await verifyRelease(directory, JSON.parse(await readFile(keysFile, 'utf8')), version)
  console.log(image)
}
