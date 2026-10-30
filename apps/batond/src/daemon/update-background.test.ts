import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vite-plus/test'
import { updatePayloadBytes } from '@baton/protocol/update-manifest'
import { checkBackgroundUpdate, readUpdatePolicy, saveUpdatePolicy, tryIdleUpdate } from './update-background.ts'
import { saveUpdateState } from './update-state.ts'
import type { fetchUpdateManifest, downloadUpdateArtifact } from './update-network.ts'
import type { readCurrentInstallation } from './update-install.ts'

it('defaults to manual and persists the user selection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'baton-background-'))
  try {
    expect(await readUpdatePolicy(directory)).toBe('manual')
    await saveUpdatePolicy(directory, 'idle')
    expect(await readUpdatePolicy(directory)).toBe('idle')
    await writeFile(join(directory, 'update-policy.json'), '{invalid')
    await expect(readUpdatePolicy(directory)).rejects.toThrow('更新策略无效')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('predownloads verified bytes in manual mode and starts only when explicitly enabled and idle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'baton-background-'))
  try {
    const bytes = Buffer.from('signed artifact')
    const artifact = {
      kind: 'daemon',
      platform: process.platform,
      arch: process.arch,
      file: process.platform === 'win32' ? 'batond.zip' : 'batond.tar.gz',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
    const manifest = { payload: { version: 'v1.2.4', commit: 'b'.repeat(40), artifacts: [artifact] } }
    const current = { release: { version: 'v1.2.3', commit: 'a'.repeat(40) } }
    const fetchManifest = vi.fn(async () => manifest) as unknown as typeof fetchUpdateManifest
    const currentInstallation = vi.fn(async () => current) as unknown as typeof readCurrentInstallation
    const download = vi.fn(async (_dir: string, _artifact: unknown, target: string) =>
      writeFile(target, bytes),
    ) as unknown as typeof downloadUpdateArtifact
    const isIdle = vi.fn(async () => false)
    const start = vi.fn(async () => {})
    const options = { fetchManifest, currentInstallation, download, isIdle, start }
    const manual = await checkBackgroundUpdate(directory, options)
    expect(manual.status).toBe('downloaded')
    if (manual.status === 'current') throw new Error('expected download')
    expect(await readFile(manual.path)).toEqual(bytes)
    expect(isIdle).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    await saveUpdatePolicy(directory, 'idle')
    expect((await checkBackgroundUpdate(directory, options)).status).toBe('downloaded')
    expect(isIdle).toHaveBeenCalledTimes(1)
    expect(start).not.toHaveBeenCalled()
    isIdle.mockResolvedValue(true)
    expect((await checkBackgroundUpdate(directory, options)).status).toBe('started')
    expect(start).toHaveBeenCalledTimes(1)
    expect(download).toHaveBeenCalledTimes(1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('does not start when the user switches to manual while a download is in progress', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'baton-background-'))
  try {
    await saveUpdatePolicy(directory, 'idle')
    const bytes = Buffer.from('update')
    const artifact = {
      kind: 'daemon',
      platform: process.platform,
      arch: process.arch,
      file: process.platform === 'win32' ? 'package.zip' : 'package.tar.gz',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
    const fetchManifest = (async () => ({
      payload: { version: 'v1.2.4', commit: 'b'.repeat(40), artifacts: [artifact] },
    })) as unknown as typeof fetchUpdateManifest
    const currentInstallation = (async () => ({
      release: { version: 'v1.2.3', commit: 'a'.repeat(40) },
    })) as unknown as typeof readCurrentInstallation
    const download = (async (_dir: string, _artifact: unknown, target: string) => {
      await writeFile(target, bytes)
      await saveUpdatePolicy(directory, 'manual')
    }) as unknown as typeof downloadUpdateArtifact
    const start = vi.fn(async () => {})
    expect(
      (
        await checkBackgroundUpdate(directory, {
          fetchManifest,
          currentInstallation,
          download,
          isIdle: async () => true,
          start,
        })
      ).status,
    ).toBe('downloaded')
    expect(start).not.toHaveBeenCalled()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('prefetches the desktop artifact from the same signed release when provided', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'baton-background-'))
  try {
    const contents = { daemon: Buffer.from('daemon'), desktop: Buffer.from('desktop') }
    const make = (kind: 'daemon' | 'desktop') => ({
      kind,
      platform: process.platform,
      arch: process.arch,
      file: kind === 'daemon' ? 'daemon.tar.gz' : 'desktop.dmg',
      size: contents[kind].length,
      sha256: createHash('sha256').update(contents[kind]).digest('hex'),
    })
    const artifacts = [make('daemon'), make('desktop')]
    const fetchManifest = (async () => ({
      payload: { version: 'v1.2.4', commit: 'b'.repeat(40), artifacts },
    })) as unknown as typeof fetchUpdateManifest
    const currentInstallation = (async () => ({
      release: { version: 'v1.2.3', commit: 'a'.repeat(40) },
    })) as unknown as typeof readCurrentInstallation
    const download = (async (_dir: string, item: { kind: 'daemon' | 'desktop' }, target: string) =>
      writeFile(target, contents[item.kind])) as unknown as typeof downloadUpdateArtifact
    await checkBackgroundUpdate(directory, {
      fetchManifest,
      currentInstallation,
      download,
      isIdle: async () => false,
      start: async () => {},
    })
    for (const item of artifacts)
      expect(await readFile(join(directory, 'installation', 'downloads', item.sha256))).toEqual(contents[item.kind])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('rechecks a signed cached candidate on the idle timer and does not repeat cancelled operations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'baton-background-'))
  try {
    const bytes = Buffer.from('signed archive')
    const artifact = {
      kind: 'daemon' as const,
      platform: process.platform as 'darwin',
      arch: process.arch as 'arm64',
      file: process.platform === 'win32' ? 'package.zip' : 'package.tar.gz',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
    const payload = {
      version: 'v1.2.4',
      commit: 'b'.repeat(40),
      server_image: `ghcr.io/hhubb22/baton@sha256:${'a'.repeat(64)}`,
      protocol_version: 1,
      artifacts: [artifact],
    }
    const pair = generateKeyPairSync('ed25519')
    const manifest = {
      format: 1 as const,
      key_id: 'release',
      payload,
      signature: sign(null, updatePayloadBytes(payload), pair.privateKey).toString('base64url'),
    }
    const fetchManifest = (async () => manifest) as typeof fetchUpdateManifest
    const currentInstallation = (async () => ({
      release: { version: 'v1.2.3', commit: 'a'.repeat(40) },
    })) as unknown as typeof readCurrentInstallation
    const download = (async (_dir: string, _artifact: unknown, target: string) =>
      writeFile(target, bytes)) as unknown as typeof downloadUpdateArtifact
    const start = vi.fn(async () => {})
    const isIdle = vi.fn(async () => false)
    await saveUpdatePolicy(directory, 'idle')
    await checkBackgroundUpdate(directory, { fetchManifest, currentInstallation, download, isIdle, start })
    const keys = async () => ({ release: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() })
    isIdle.mockResolvedValue(true)
    expect(await tryIdleUpdate(directory, { keys, currentInstallation, isIdle, start })).toBe(true)
    expect(start).toHaveBeenCalledTimes(1)
    await saveUpdateState(directory, {
      operation_id: randomUUID(),
      attempt: 1,
      phase: 'cancelled',
      source_version: 'v1.2.3',
      target_version: 'v1.2.4',
    })
    expect(await tryIdleUpdate(directory, { keys, currentInstallation, isIdle, start })).toBe(false)
    expect(start).toHaveBeenCalledTimes(1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
