import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vite-plus/test'
import { updatePayloadBytes, type UpdatePayload } from '@baton/protocol/update-manifest'
import { readUpdateArtifact, readUpdateManifest } from './update-assets.ts'

it('serves only an unchanged raw artifact declared by the bounded manifest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'baton-update-assets-'))
  try {
    const bytes = Buffer.from('signed archive')
    const payload: UpdatePayload = {
      version: 'v1.2.3',
      commit: 'a'.repeat(40),
      protocol_version: 1,
      server_image: `ghcr.io/hhubb22/baton@sha256:${'c'.repeat(64)}`,
      artifacts: [
        {
          kind: 'daemon',
          platform: 'linux',
          arch: 'x64',
          file: 'baton.tar.gz',
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    }
    const pair = generateKeyPairSync('ed25519')
    const manifest = {
      format: 1,
      key_id: 'release',
      payload,
      signature: sign(null, updatePayloadBytes(payload), pair.privateKey).toString('base64url'),
    }
    await writeFile(join(directory, 'update-manifest.json'), JSON.stringify(manifest))
    await writeFile(join(directory, 'baton.tar.gz'), bytes)
    expect(await readUpdateManifest(directory)).toEqual(manifest)
    expect(await readUpdateArtifact(directory, 'baton.tar.gz')).toEqual({
      path: join(directory, 'baton.tar.gz'),
      size: bytes.length,
    })
    expect(await readUpdateArtifact(directory, '../baton.tar.gz')).toBeUndefined()
    await writeFile(join(directory, 'baton.tar.gz'), Buffer.from('changed bytes!'))
    await expect(readUpdateArtifact(directory, 'baton.tar.gz')).rejects.toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
