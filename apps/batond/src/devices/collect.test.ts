import { rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, it, vi } from 'vite-plus/test'
import { makeDeviceService } from './index.ts'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { writePrivateFileAtomic } from '../platform/private.ts'

const mocks = vi.hoisted(() => ({ scan: vi.fn() }))
vi.mock('./scan.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./scan.ts')>()),
  scanRuntimeRoots: mocks.scan,
}))

it('preserves completed provider probes when the one filesystem scan exhausts the shared budget', async () => {
  const directory = await makePrivateTempDirectory('baton-device-probe-')
  let scansActive = 0,
    maximumActive = 0,
    probes = 0
  mocks.scan.mockImplementation(async (_directory: string, signal: AbortSignal) => {
    scansActive++
    maximumActive = Math.max(maximumActive, scansActive)
    try {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => resolve(), { once: true })
      })
      return { roots: [], repos: [], truncated: true }
    } finally {
      scansActive--
    }
  })
  const service = await makeDeviceService({
    dataDirectory: directory,
    runtime: {
      probe: async (signal) => {
        probes++
        signal?.throwIfAborted()
        return { version: '0.1.0', providers: [{ provider: 'xai', status: 'available' }] }
      },
      startDeviceLogin: async () => {
        throw new Error('unused')
      },
    },
  })
  try {
    for (let i = 0; i < 2; i++) {
      const result = await service.collect(AbortSignal.timeout(40))
      expect(result.truncated).toBe(true)
      expect(result.project_runtime).toMatchObject({ providers: [{ provider: 'xai', status: 'available' }] })
    }
    expect(probes).toBe(2)
    expect(maximumActive).toBe(1)
    expect(scansActive).toBe(0)
  } finally {
    await service.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('refreshes roots and exec independently without rescanning unchanged roots for five minutes', async () => {
  const directory = await makePrivateTempDirectory('baton-device-cache-')
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
  mocks.scan.mockReset().mockResolvedValue({ roots: [], repos: [], truncated: false })
  const service = await makeDeviceService({ dataDirectory: directory })
  try {
    await service.collect()
    for (let i = 0; i < 12; i++) {
      clock.mockReturnValue(i * 5000)
      await service.collect()
    }
    expect(mocks.scan).toHaveBeenCalledTimes(1)
    expect(
      await service.handle({ type: 'node.project_exec_set', operation_id: randomUUID(), enabled: true }),
    ).toMatchObject({ ok: true })
    expect(await service.collect()).toMatchObject({ exec: { enabled: true } })
    expect(mocks.scan).toHaveBeenCalledTimes(1)
    await writePrivateFileAtomic(join(directory, 'project-exec.json'), '{"enabled":true}')
    expect(await service.collect()).toMatchObject({ exec: { enabled: false }, truncated: true })
    expect(mocks.scan).toHaveBeenCalledTimes(1)
    await writePrivateFileAtomic(join(directory, 'browse-roots.json'), '{"roots":[]}')
    await service.collect()
    expect(mocks.scan).toHaveBeenCalledTimes(2)
    clock.mockReturnValue(355_000)
    await service.collect()
    expect(mocks.scan).toHaveBeenCalledTimes(3)
  } finally {
    clock.mockRestore()
    await service.close()
    await rm(directory, { recursive: true, force: true })
  }
})
