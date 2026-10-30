import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { signUpdate } from './sign-update.mjs'
import { verifyUpdateManifest } from '../packages/protocol/src/update-manifest.ts'
import { updateKeys } from './lib/release.mjs'

test('signs actual artifact bytes with an offline key and rejects changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'baton-release-sign-'))
  try {
    const pair = generateKeyPairSync('ed25519')
    const key = join(directory, 'key.pem')
    const metadata = join(directory, 'release-input.json')
    const output = join(directory, 'update-manifest.json')
    await writeFile(key, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }))
    await writeFile(join(directory, 'baton.tar.gz'), 'archive bytes')
    await writeFile(
      metadata,
      JSON.stringify({
        version: 'v1.2.3',
        commit: 'a'.repeat(40),
        protocol_version: 1,
        server_image: `ghcr.io/hhubb22/baton@sha256:${'c'.repeat(64)}`,
        artifacts: [{ kind: 'daemon', platform: 'linux', arch: 'x64', file: 'baton.tar.gz' }],
      }),
    )
    await signUpdate({ metadataPath: metadata, keyPath: key, keyId: 'release', output })
    const manifest = JSON.parse(await readFile(output, 'utf8'))
    const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    assert.equal(verifyUpdateManifest(manifest, { release: publicKey }).payload.artifacts[0].size, 13)
    manifest.payload.artifacts[0].sha256 = '0'.repeat(64)
    assert.throws(() => verifyUpdateManifest(manifest, { release: publicKey }))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('accepts only explicitly configured public Ed25519 keys for release builds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'baton-release-keys-'))
  try {
    const pair = generateKeyPairSync('ed25519')
    const path = join(directory, 'keys.json')
    const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    await writeFile(path, JSON.stringify({ release: publicKey }))
    assert.deepEqual(updateKeys(path), { release: publicKey })
    await writeFile(
      path,
      JSON.stringify({ release: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }),
    )
    assert.throws(() => updateKeys(path))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
