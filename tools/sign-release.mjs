import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { Schema } from 'effect'
import {
  ReleasePayload,
  SignedReleaseManifest,
  releasePayloadBytes,
  verifyReleaseManifest,
} from '../packages/protocol/src/release-manifest.ts'

export async function signRelease({ metadataPath, keyPath, keyId, output }) {
  const source = JSON.parse(await readFile(metadataPath, 'utf8'))
  const artifacts = []
  for (const entry of source.artifacts ?? []) {
    if (typeof entry.file !== 'string' || basename(entry.file) !== entry.file) throw new Error('发布文件名无效')
    const path = join(dirname(metadataPath), entry.file)
    const info = await stat(path)
    if (!info.isFile()) throw new Error('发布文件必须是普通文件')
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    artifacts.push({
      kind: entry.kind,
      platform: entry.platform,
      arch: entry.arch,
      file: entry.file,
      size: info.size,
      sha256: hash.digest('hex'),
    })
  }
  const payload = Schema.decodeUnknownSync(ReleasePayload)({
    version: source.version,
    commit: source.commit,
    protocol_version: source.protocol_version,
    server_image: source.server_image,
    artifacts,
  })
  const key = createPrivateKey(await readFile(keyPath))
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('发布签名需要 Ed25519 私钥')
  const manifest = Schema.decodeUnknownSync(SignedReleaseManifest)({
    format: 1,
    key_id: keyId,
    payload,
    signature: sign(null, releasePayloadBytes(payload), key).toString('base64url'),
  })
  verifyReleaseManifest(manifest, {
    [keyId]: createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString(),
  })
  await writeFile(output, JSON.stringify(manifest) + '\n', { mode: 0o644 })
  return manifest
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        metadata: { type: 'string' },
        key: { type: 'string' },
        'key-id': { type: 'string' },
        out: { type: 'string' },
      },
    })
    if (!values.metadata || !values.key || !values['key-id'] || !values.out)
      throw new Error(
        '用法：node tools/sign-release.mjs --metadata <文件> --key <私钥文件> --key-id <标识> --out <清单>',
      )
    await signRelease({
      metadataPath: resolve(values.metadata),
      keyPath: resolve(values.key),
      keyId: values['key-id'],
      output: resolve(values.out),
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : '签名失败')
    process.exitCode = 1
  }
}
