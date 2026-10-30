import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vite-plus/test'
import { releaseMetadata } from '@baton/protocol/release'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { writePrivateFileAtomic } from '../platform/private.ts'
import { writeUpgradePackage } from '../testing/upgrade.ts'
import { importEnvironment, updateEnvironment } from '../environment.ts'

vi.mock('node:child_process', async () => (await import('../testing/upgrade.ts')).upgradeProcessFixture())
const { installationPaths, readCurrentInstallation, dispatchInstallation, launchInstallation } =
  await import('./update-install.ts')

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

it('launches the selected version with the current environment after a configuration change', async () => {
  if (process.platform === 'win32') return
  const data = await makePrivateTempDirectory('baton-launch-env-')
  const previous = process.env.BATON_ENV_MANAGED_KEYS
  const old = process.env.LAUNCH_FIXTURE
  try {
    const paths = installationPaths(data)
    const id = 'b'.repeat(64)
    const version = join(paths.versions, id)
    await mkdir(paths.versions, { recursive: true, mode: 0o700 })
    await writeUpgradePackage(version)
    const binary = join(version, 'batond')
    const output = join(data, 'result.json')
    await writePrivateFileAtomic(
      binary,
      `#!${process.execPath}\nif(process.argv[2]==='--version'||process.argv[2]==='--binary-version') process.stdout.write(${JSON.stringify(JSON.stringify(releaseMetadata()))}); else { require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({value:process.env.LAUNCH_FIXTURE, revision:process.env.BATON_ENV_REVISION}));setTimeout(()=>process.exit(0),500) }\n`,
    )
    await chmod(binary, 0o700)
    await writePrivateFileAtomic(paths.current, JSON.stringify({ directory: id, release: releaseMetadata() }))
    await importEnvironment(data, { PATH: process.env.PATH })
    const config = await updateEnvironment(data, (value) => ({
      ...value,
      scopes: { device: { LAUNCH_FIXTURE: 'new' } },
    }))
    process.env.BATON_ENV_MANAGED_KEYS = JSON.stringify(['LAUNCH_FIXTURE'])
    process.env.LAUNCH_FIXTURE = 'old'
    expect(await launchInstallation(data, ['run', '--data-dir', data])).toBe(0)
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({ value: 'new', revision: config.revision })
  } finally {
    if (previous === undefined) delete process.env.BATON_ENV_MANAGED_KEYS
    else process.env.BATON_ENV_MANAGED_KEYS = previous
    if (old === undefined) delete process.env.LAUNCH_FIXTURE
    else process.env.LAUNCH_FIXTURE = old
    await rm(data, { recursive: true, force: true })
  }
})
