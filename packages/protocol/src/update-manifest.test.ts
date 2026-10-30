import { generateKeyPairSync, sign } from 'node:crypto'
import { expect, it } from 'vite-plus/test'
import { updatePayloadBytes, verifyUpdateManifest, type UpdatePayload } from './update-manifest.ts'

it('accepts only a trusted Ed25519 signature over the release and artifact identity', () => {
  const pair = generateKeyPairSync('ed25519')
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
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
        file: 'baton-1.2.3-linux-x64.tar.gz',
        size: 12,
        sha256: 'b'.repeat(64),
      },
    ],
  }
  const signed = {
    format: 1,
    key_id: 'release',
    payload,
    signature: sign(null, updatePayloadBytes(payload), pair.privateKey).toString('base64url'),
  }
  expect(verifyUpdateManifest(signed, { release: publicKey })).toEqual(signed)
  expect(() => verifyUpdateManifest(signed, {})).toThrow()
  expect(() =>
    verifyUpdateManifest({ ...signed, payload: { ...payload, version: 'v1.2.4' } }, { release: publicKey }),
  ).toThrow()
  expect(() =>
    verifyUpdateManifest(
      { ...signed, payload: { ...payload, artifacts: [{ ...payload.artifacts[0], file: '../evil' }] } },
      { release: publicKey },
    ),
  ).toThrow()
})
