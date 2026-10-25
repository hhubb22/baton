import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vite-plus/test'
import { writePrivateFileAtomic } from '../platform/private.ts'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { probeFingerprint } from './probe-cache.ts'

it('invalidates probe metadata when a file URL loader changes or disappears', async () => {
  const directory = await makePrivateTempDirectory('baton-loader-cache-')
  try {
    const loader = join(directory, 'loader with spaces # 中文.mjs')
    await writePrivateFileAtomic(loader, 'export {}')
    const command = {
      file: process.execPath,
      args: ['--import', pathToFileURL(loader).href],
      env: { BATON_PROJECT_RUNTIME_DATA_DIR: join(directory, 'credentials') },
    }
    const initial = await probeFingerprint(command)
    expect(initial).toBeDefined()
    await writePrivateFileAtomic(loader, 'export const updated = true')
    const updated = await probeFingerprint(command)
    expect(updated).toBeDefined()
    expect(updated).not.toBe(initial)
    await rm(loader)
    expect(await probeFingerprint(command)).not.toBe(updated)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
