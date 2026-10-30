import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vite-plus/test'
import { updatePayloadBytes, verifyUpdateManifest } from '@baton/protocol/update-manifest'
import { desktopArtifact, shouldHandoffDesktop } from './update-handoff.ts'
import { verifyDesktopDownload } from './update-download.ts'

it('selects only the signed desktop artifact for the target release and verifies its bytes', async () => {
  const data = Buffer.from('desktop package')
  const payload = {
    version: 'v1.2.3',
    commit: 'a'.repeat(40),
    server_image: `ghcr.io/hhubb22/baton@sha256:${'a'.repeat(64)}`,
    protocol_version: 1,
    artifacts: [
      {
        kind: 'daemon' as const,
        platform: 'darwin' as const,
        arch: 'arm64' as const,
        file: 'batond.tar.gz',
        size: 1,
        sha256: 'a'.repeat(64),
      },
      {
        kind: 'desktop' as const,
        platform: 'darwin' as const,
        arch: 'arm64' as const,
        file: 'baton-desktop-v1.2.3-darwin-arm64.zip',
        size: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
      },
      {
        kind: 'desktop-feed' as const,
        platform: 'darwin' as const,
        arch: 'arm64' as const,
        file: 'latest-mac.yml',
        size: 1,
        sha256: 'b'.repeat(64),
      },
    ],
  }
  const keys = generateKeyPairSync('ed25519')
  const signed = {
    format: 1 as const,
    key_id: 'key',
    payload,
    signature: sign(null, updatePayloadBytes(payload), keys.privateKey).toString('base64url'),
  }
  const manifest = verifyUpdateManifest(signed, {
    key: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  })
  const item = desktopArtifact(manifest, 'v1.2.3', 'darwin', 'arm64')
  expect(() => desktopArtifact(manifest, 'v1.2.4', 'darwin', 'arm64')).toThrow()
  expect(() => desktopArtifact(manifest, 'v1.2.3', 'win32', 'x64')).toThrow()
  expect(() =>
    verifyUpdateManifest(
      { ...signed, payload: { ...payload, version: 'v1.2.4' } },
      { key: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
    ),
  ).toThrow()
  const directory = await mkdtemp(join(tmpdir(), 'desktop-update-'))
  try {
    const path = join(directory, 'package.dmg')
    await writeFile(path, data)
    await expect(verifyDesktopDownload(item, path)).resolves.toBeUndefined()
    await writeFile(path, Buffer.alloc(data.length))
    await expect(verifyDesktopDownload(item, path)).rejects.toThrow()
    const link = join(directory, 'link.dmg')
    await symlink(path, link)
    await expect(verifyDesktopDownload(item, link)).rejects.toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('uses the same installation handoff for an idle-triggered update and rejects a missing desktop package', () => {
  expect(shouldHandoffDesktop({ phase: 'draining', target_version: 'v1.2.3' })).toBe(false)
  expect(shouldHandoffDesktop({ phase: 'syncing', target_version: 'v1.2.3' })).toBe(true)
  const manifest = {
    format: 1 as const,
    key_id: 'key',
    signature: 'x',
    payload: {
      version: 'v1.2.3',
      commit: 'a'.repeat(40),
      server_image: `ghcr.io/hhubb22/baton@sha256:${'a'.repeat(64)}`,
      protocol_version: 1,
      artifacts: [
        {
          kind: 'daemon' as const,
          platform: 'darwin' as const,
          arch: 'arm64' as const,
          file: 'daemon.tar.gz',
          size: 1,
          sha256: 'a'.repeat(64),
        },
      ],
    },
  }
  expect(() => desktopArtifact(manifest, 'v1.2.3', 'darwin', 'arm64')).toThrow('桌面安装包')
})
