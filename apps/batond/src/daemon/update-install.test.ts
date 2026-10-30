import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it, vi } from 'vite-plus/test'
import { releaseMetadata } from '@baton/protocol/release'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { writePrivateFileAtomic } from '../platform/private.ts'
import { writeUpgradePackage } from '../testing/upgrade.ts'
import { importEnvironment, updateEnvironment } from '../environment.ts'

vi.mock('node:child_process', async () => {
  const fixture = await (await import('../testing/upgrade.ts')).upgradeProcessFixture()
  return {
    ...fixture,
    spawn: (file: string, args: readonly string[], options: object) => {
      if (Array.isArray(args) && args[0] === 'update' && ['manifest', 'status'].includes(args[1]!)) {
        const directory = args[args.indexOf('--data-dir') + 1]
        return Reflect.apply(fixture.spawn, undefined, [
          process.execPath,
          [
            '-e',
            "require('node:fs').writeFileSync(require('node:path').join(process.argv[1], 'update-env.json'), JSON.stringify({value:process.env.UPDATE_FIXTURE, ca:process.env.NODE_EXTRA_CA_CERTS, proxy:process.env.HTTPS_PROXY}))",
            directory,
          ],
          options,
        ])
      }
      return Reflect.apply(fixture.spawn, undefined, [file, args, options])
    },
  }
})
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

it('launches update commands with saved environment instead of stale launcher values', async () => {
  const data = await makePrivateTempDirectory('baton-update-env-')
  const oldManaged = process.env.BATON_ENV_MANAGED_KEYS
  const oldValue = process.env.UPDATE_FIXTURE
  try {
    const paths = installationPaths(data)
    const id = 'c'.repeat(64)
    await mkdir(paths.versions, { recursive: true, mode: 0o700 })
    await writeUpgradePackage(join(paths.versions, id))
    await writePrivateFileAtomic(paths.current, JSON.stringify({ directory: id, release: releaseMetadata() }))
    await importEnvironment(data, {
      PATH: process.env.PATH,
      NODE_EXTRA_CA_CERTS: '/new/ca.pem',
      HTTPS_PROXY: 'http://localhost:8123',
    })
    await updateEnvironment(data, (config) => ({ ...config, scopes: { device: { UPDATE_FIXTURE: 'new' } } }))
    process.env.BATON_ENV_MANAGED_KEYS = JSON.stringify(['UPDATE_FIXTURE'])
    process.env.UPDATE_FIXTURE = 'old'
    expect(await launchInstallation(data, ['update', 'manifest', '--data-dir', data])).toBe(0)
    expect(JSON.parse(await readFile(join(data, 'update-env.json'), 'utf8'))).toEqual({
      value: 'new',
      ca: '/new/ca.pem',
      proxy: 'http://localhost:8123',
    })
  } finally {
    if (oldManaged === undefined) delete process.env.BATON_ENV_MANAGED_KEYS
    else process.env.BATON_ENV_MANAGED_KEYS = oldManaged
    if (oldValue === undefined) delete process.env.UPDATE_FIXTURE
    else process.env.UPDATE_FIXTURE = oldValue
    await rm(data, { recursive: true, force: true })
  }
})

it('starts an update worker with the latest saved environment', async () => {
  if (process.platform === 'win32') return
  const data = await makePrivateTempDirectory('baton-update-worker-env-')
  const oldManaged = process.env.BATON_ENV_MANAGED_KEYS
  const oldValue = process.env.UPDATE_FIXTURE
  try {
    const paths = installationPaths(data)
    const id = 'd'.repeat(64)
    await mkdir(paths.versions, { recursive: true, mode: 0o700 })
    await mkdir(paths.launcher, { recursive: true, mode: 0o700 })
    await writeUpgradePackage(join(paths.versions, id))
    await writePrivateFileAtomic(paths.current, JSON.stringify({ directory: id, release: releaseMetadata() }))
    const binary = join(paths.launcher, paths.binary)
    const output = join(data, 'worker-env.json')
    await writePrivateFileAtomic(
      binary,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({value:process.env.UPDATE_FIXTURE, ca:process.env.NODE_EXTRA_CA_CERTS, proxy:process.env.HTTPS_PROXY}))\n`,
    )
    await chmod(binary, 0o700)
    await importEnvironment(data, {
      PATH: process.env.PATH,
      NODE_EXTRA_CA_CERTS: '/new/ca.pem',
      HTTPS_PROXY: 'http://localhost:8123',
    })
    await updateEnvironment(data, (config) => ({ ...config, scopes: { device: { UPDATE_FIXTURE: 'new' } } }))
    process.env.BATON_ENV_MANAGED_KEYS = JSON.stringify(['UPDATE_FIXTURE'])
    process.env.UPDATE_FIXTURE = 'old'
    const { startUpdate } = await import('./update-orchestrator.ts')
    await startUpdate(data, { operation_id: randomUUID(), attempt: 1 })
    let value: string | undefined
    for (let attempt = 0; attempt < 100 && value === undefined; attempt++) {
      value = await readFile(output, 'utf8').catch(() => undefined)
      if (value === undefined) await delay(25)
    }
    expect(value).toBeDefined()
    expect(JSON.parse(value!)).toEqual({ value: 'new', ca: '/new/ca.pem', proxy: 'http://localhost:8123' })
  } finally {
    if (oldManaged === undefined) delete process.env.BATON_ENV_MANAGED_KEYS
    else process.env.BATON_ENV_MANAGED_KEYS = oldManaged
    if (oldValue === undefined) delete process.env.UPDATE_FIXTURE
    else process.env.UPDATE_FIXTURE = oldValue
    await rm(data, { recursive: true, force: true })
  }
})

it('keeps local update status available when environment configuration is damaged', async () => {
  const data = await makePrivateTempDirectory('baton-update-status-')
  try {
    const paths = installationPaths(data)
    const id = 'e'.repeat(64)
    await mkdir(paths.versions, { recursive: true, mode: 0o700 })
    await writeUpgradePackage(join(paths.versions, id))
    await writePrivateFileAtomic(paths.current, JSON.stringify({ directory: id, release: releaseMetadata() }))
    await importEnvironment(data, { PATH: process.env.PATH })
    await writePrivateFileAtomic(join(data, 'environment', 'environment.json'), '{')
    expect(await launchInstallation(data, ['update', 'status', '--data-dir', data])).toBe(0)
  } finally {
    await rm(data, { recursive: true, force: true })
  }
})
