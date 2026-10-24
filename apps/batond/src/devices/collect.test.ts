import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vite-plus/test'
import { makeDeviceService } from './index.ts'

const mocks = vi.hoisted(() => ({ scan: vi.fn() }))
vi.mock('./scan.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./scan.ts')>()),
  scanRuntimeRoots: mocks.scan,
}))

it('preserves completed provider probes when the one filesystem scan exhausts the shared budget', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'baton-device-probe-'))
  await chmod(directory, 0o700)
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
