import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { signUpdate } from './sign-update.mjs'
import { verifyRelease } from './verify-release.mjs'

test('deployment verifies signature, version, artifact bytes and pinned image before upload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'baton-deploy-verify-'))
  try {
    const pair = generateKeyPairSync('ed25519')
    const keys = { release: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }
    const image = `ghcr.io/hhubb22/baton@sha256:${'a'.repeat(64)}`
    await writeFile(join(directory, 'key.pem'), pair.privateKey.export({ type: 'pkcs8', format: 'pem' }))
    await writeFile(join(directory, 'server-image.txt'), image)
    await writeFile(join(directory, 'baton.tar.gz'), 'archive bytes')
    await writeFile(
      join(directory, 'input.json'),
      JSON.stringify({
        version: 'v1.2.3',
        commit: 'b'.repeat(40),
        protocol_version: 1,
        server_image: image,
        artifacts: [{ kind: 'daemon', platform: 'linux', arch: 'x64', file: 'baton.tar.gz' }],
      }),
    )
    await signUpdate({
      metadataPath: join(directory, 'input.json'),
      keyPath: join(directory, 'key.pem'),
      keyId: 'release',
      output: join(directory, 'update-manifest.json'),
    })
    assert.equal((await verifyRelease(directory, keys, 'v1.2.3')).image, image)
    await assert.rejects(verifyRelease(directory, {}, 'v1.2.3'), /不受信任/)
    await assert.rejects(verifyRelease(directory, keys, 'v1.2.4'), /版本/)
    await writeFile(join(directory, 'server-image.txt'), 'ghcr.io/hhubb22/baton:latest')
    await assert.rejects(verifyRelease(directory, keys, 'v1.2.3'), /摘要/)
    await writeFile(join(directory, 'server-image.txt'), image)
    await writeFile(join(directory, 'baton.tar.gz'), 'tampered data')
    await assert.rejects(verifyRelease(directory, keys, 'v1.2.3'), /摘要/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
