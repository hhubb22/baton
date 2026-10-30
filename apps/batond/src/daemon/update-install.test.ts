import { randomUUID } from 'node:crypto'
import { mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vite-plus/test'
import { releaseMetadata } from '@baton/protocol/release'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { writePrivateFileAtomic } from '../platform/private.ts'
import { writeUpgradePackage } from '../testing/upgrade.ts'

vi.mock('node:child_process', async () => (await import('../testing/upgrade.ts')).upgradeProcessFixture())
const { installationPaths, readCurrentInstallation, dispatchInstallation } = await import('./update-install.ts')

it('accepts a symlinked data directory while keeping version pointers inside versions', async () => {
  if (process.platform === 'win32') return
  const root = await makePrivateTempDirectory('baton-install-path-')
  try {
    const data = join(root, 'data')
    const alias = join(root, 'alias')
    await mkdir(data, { mode: 0o700 })
    await symlink(data, alias)
    const paths = installationPaths(data)
    const id = 'a'.repeat(64)
    await mkdir(paths.versions, { recursive: true, mode: 0o700 })
    await writeUpgradePackage(join(paths.versions, id))
    const pointer = JSON.stringify({ directory: id, release: releaseMetadata() })
    await writePrivateFileAtomic(paths.current, pointer)
    await writePrivateFileAtomic(paths.launcherCurrent, pointer)
    expect((await readCurrentInstallation(alias)).directory).toBe(id)
    expect(await dispatchInstallation(alias, ['unsupported', randomUUID()])).toBe(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
