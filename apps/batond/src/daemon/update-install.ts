import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { cp, lstat, realpath, rename, rm } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { isSea } from 'node:sea'
import { Schema } from 'effect'
import { ReleaseMetadata } from '@baton/protocol/release'
import { acquireProcessLock, readProcessLock, type ProcessLock } from '../platform/lock.ts'
import { ensurePrivateDirectory, readPrivateFile, writePrivateFileAtomic } from '../platform/private.ts'
import { readUpgradePackage } from './upgrade-check.ts'
import { isMissing } from './identity.ts'
import { readProcessIdentity } from '../platform/identity.ts'
import { processLockIsHeld } from '../platform/lock.ts'
import { UUID } from '@baton/protocol'
import { spawnDetachedWorker } from '../platform/process.ts'

type InstalledRelease = typeof ReleaseMetadata.Type
const Installation = Schema.Struct({ directory: Schema.String, release: ReleaseMetadata })

export function installationPaths(dataDirectory: string) {
  const root = join(dataDirectory, 'installation')
  const binary = process.platform === 'win32' ? 'batond.exe' : 'batond'
  return {
    root,
    versions: join(root, 'versions'),
    launcher: join(root, 'launcher'),
    binary,
    current: join(root, 'current.json'),
    launcherCurrent: join(root, 'launcher-current.json'),
    lock: join(root, 'installation.lock'),
  }
}

function versionDirectory(release: InstalledRelease): string {
  return createHash('sha256').update(JSON.stringify(release)).digest('hex')
}

/** Copy a complete verified local package into an immutable version directory. */
export async function installVersion(dataDirectory: string, source: string) {
  const paths = installationPaths(dataDirectory)
  await ensurePrivateDirectory(paths.root)
  await ensurePrivateDirectory(paths.versions)
  const checked = await readUpgradePackage(source)
  const id = versionDirectory(checked.release)
  const target = join(paths.versions, id)
  try {
    const existing = await readUpgradePackage(target)
    if (JSON.stringify(existing.release) !== JSON.stringify(checked.release))
      throw new Error('Installed version identity differs')
    return { directory: id, release: checked.release }
  } catch (error) {
    try {
      await lstat(target)
    } catch (missing) {
      if (isMissing(missing)) {
        const staging = join(paths.versions, `.staging-${randomUUID()}`)
        try {
          await cp(checked.path, staging, {
            recursive: true,
            force: false,
            errorOnExist: true,
            preserveTimestamps: true,
          })
          const staged = await readUpgradePackage(staging)
          if (JSON.stringify(staged.release) !== JSON.stringify(checked.release))
            throw new Error('Copied version identity differs')
          await rename(staging, target)
        } finally {
          await rm(staging, { recursive: true, force: true })
        }
        return { directory: id, release: checked.release }
      }
    }
    throw error
  }
}

/** Initialize once from the current SEA package; later invocations preserve the active version. */
export async function bootstrapInstallation(
  dataDirectory: string,
  source = isSea() ? dirname(process.execPath) : undefined,
) {
  if (!source) throw new Error('Update bootstrap requires an installed SEA package')
  const root = await realpath(dataDirectory)
  const paths = installationPaths(root)
  await ensurePrivateDirectory(paths.root)
  const release = await acquireProcessLock(paths.lock)
  try {
    const current = await readCurrentInstallation(root).catch((error: unknown) => {
      if (isMissing(error)) return undefined
      throw error
    })
    if (!current) {
      const installed = await installVersion(root, source)
      try {
        await lstat(paths.launcher)
      } catch (error) {
        if (!isMissing(error)) throw error
        const staging = join(paths.root, `.launcher-${randomUUID()}`)
        try {
          await cp(source, staging, { recursive: true, force: false, errorOnExist: true })
          await rename(staging, paths.launcher)
        } finally {
          await rm(staging, { recursive: true, force: true })
        }
      }
      await writePrivateFileAtomic(paths.current, JSON.stringify(installed))
    }
    try {
      await readPrivateFile(paths.launcherCurrent)
    } catch (error) {
      if (!isMissing(error)) throw error
      const launcherVersion = await installVersion(root, source)
      await writePrivateFileAtomic(paths.launcherCurrent, JSON.stringify(launcherVersion))
    }
    return { executable: join(paths.launcher, paths.binary), args: ['dispatch', '--data-dir', root, '--'] }
  } finally {
    await release()
  }
}

async function readInstallationPointer(dataDirectory: string, pointer: string) {
  const paths = installationPaths(dataDirectory)
  const value = Schema.decodeUnknownSync(Installation)(JSON.parse((await readPrivateFile(pointer)).toString('utf8')))
  if (!/^[a-f0-9]{64}$/.test(value.directory)) throw new Error('Invalid current installation')
  const versions = await realpath(paths.versions)
  const directory = await realpath(join(versions, value.directory))
  if (relative(versions, directory) !== value.directory) throw new Error('Invalid current installation path')
  const checked = await readUpgradePackage(directory)
  if (JSON.stringify(value.release) !== JSON.stringify(checked.release))
    throw new Error('Current installation identity differs')
  return { ...value, path: directory }
}
export const readCurrentInstallation = (dataDirectory: string) =>
  readInstallationPointer(dataDirectory, installationPaths(dataDirectory).current)
export const readLauncherInstallation = (dataDirectory: string) =>
  readInstallationPointer(dataDirectory, installationPaths(dataDirectory).launcherCurrent)

/** Called by the target updater after the old launcher and daemon have exited. */
export async function activateInstallation(
  dataDirectory: string,
  installation: { directory: string; release: InstalledRelease },
  operationId: string,
) {
  Schema.decodeUnknownSync(UUID)(operationId)
  if (!/^[a-f0-9]{64}$/.test(installation.directory)) throw new Error('Invalid target installation')
  const paths = installationPaths(dataDirectory)
  const release = await acquireProcessLock(paths.lock)
  try {
    if (await processLockIsHeld(join(dataDirectory, 'daemon.lock'))) throw new Error('Daemon is still running')
    const target = await readUpgradePackage(join(paths.versions, installation.directory))
    if (JSON.stringify(target.release) !== JSON.stringify(installation.release))
      throw new Error('Target installation identity differs')
    const previous = join(paths.root, `launcher-previous-${operationId}.json`)
    try {
      await readPrivateFile(previous)
    } catch (error) {
      if (!isMissing(error)) throw error
      const current = await readLauncherInstallation(dataDirectory)
      await writePrivateFileAtomic(previous, JSON.stringify({ directory: current.directory, release: current.release }))
    }
    await writePrivateFileAtomic(paths.launcherCurrent, JSON.stringify(installation))
    await writePrivateFileAtomic(paths.current, JSON.stringify(installation))
  } finally {
    await release()
  }
}

/** Restore the previous executable entry only after its matching data backup is restored. */
export async function restoreInstallation(
  dataDirectory: string,
  previousDirectory: string,
  operationId: string,
  daemonLock: ProcessLock,
) {
  Schema.decodeUnknownSync(UUID)(operationId)
  if (!/^[a-f0-9]{64}$/.test(previousDirectory)) throw new Error('Invalid previous installation')
  const paths = installationPaths(dataDirectory)
  const release = await acquireProcessLock(paths.lock)
  try {
    const owner = await readProcessLock(join(dataDirectory, 'daemon.lock'))
    if (
      !owner ||
      owner.token !== daemonLock.record.token ||
      owner.pid !== process.pid ||
      owner.creationTime !== daemonLock.record.creationTime
    )
      throw new Error('Rollback requires ownership of daemon lock')
    const previousPath = join(paths.versions, previousDirectory)
    const previous = await readUpgradePackage(previousPath)
    const launcherBackup = join(paths.root, `launcher-previous-${operationId}.json`)
    try {
      const oldLauncher = await readInstallationPointer(dataDirectory, launcherBackup)
      await writePrivateFileAtomic(
        paths.launcherCurrent,
        JSON.stringify({ directory: oldLauncher.directory, release: oldLauncher.release }),
      )
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    await writePrivateFileAtomic(
      paths.current,
      JSON.stringify({ directory: previousDirectory, release: previous.release }),
    )
  } finally {
    await release()
  }
}

/** The stable shim forwards all work to the selected, replaceable launcher. */
export async function dispatchInstallation(dataDirectory: string, args: readonly string[]): Promise<number> {
  const paths = installationPaths(dataDirectory)
  const pointer = Schema.decodeUnknownSync(
    Schema.Struct({ directory: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)) }),
  )(JSON.parse((await readPrivateFile(paths.launcherCurrent)).toString('utf8')))
  const versions = await realpath(paths.versions)
  const versionPath = await realpath(join(versions, pointer.directory))
  if (relative(versions, versionPath) !== pointer.directory) throw new Error('Invalid launcher path')
  const shim = await readProcessIdentity(process.pid)
  if (!shim) throw new Error('Unable to verify launcher identity')
  const child = spawn(
    join(versionPath, paths.binary),
    ['versioned-dispatch', '--data-dir', dataDirectory, '--', ...args],
    {
      stdio: 'inherit',
      windowsHide: true,
      env: { ...process.env, BATON_SHIM_PID: String(shim.pid), BATON_SHIM_CREATION_TIME: shim.creationTime },
    },
  )
  const interrupt = () => child.kill('SIGINT')
  const terminate = () => child.kill('SIGTERM')
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', terminate)
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGTERM' ? 0 : 1)))
    })
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
  }
}

/** The versioned launcher owns the daemon and forwards shutdown. */
export async function launchInstallation(dataDirectory: string, args: readonly string[]): Promise<number> {
  const paths = installationPaths(dataDirectory)
  if (args[0] === 'run' || args[0] === 'up') {
    try {
      await lstat(join(paths.root, 'rollback.json'))
      const { readUpdateState } = await import('./update-state.ts')
      const state = await readUpdateState(dataDirectory)
      if (!state?.package_directory) throw new Error('Rollback updater is unavailable')
      await spawnDetachedWorker({
        file: join(paths.versions, state.package_directory, paths.binary),
        args: ['update-recover', '--data-dir', dataDirectory],
      })
      return 75
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    const { readUpdateState } = await import('./update-state.ts')
    const state = await readUpdateState(dataDirectory)
    if (
      state &&
      ['requested', 'downloading', 'verifying', 'draining', 'ready', 'migrating', 'syncing'].includes(state.phase)
    ) {
      const { startUpdate } = await import('./update-orchestrator.ts')
      await startUpdate(dataDirectory, { operation_id: state.operation_id, attempt: state.attempt })
      if (state.phase === 'ready' || state.phase === 'migrating') return 75
    }
  }
  const current = await readCurrentInstallation(dataDirectory)
  const binary = args[0] === 'update' ? process.execPath : join(current.path, paths.binary)
  let env = process.env
  if (args[0] === 'run' || args[0] === 'up') {
    const { initializeEnvironment, applyEnvironment } = await import('../environment.ts')
    const config = await initializeEnvironment(dataDirectory, process.env)
    if (config.revision)
      env = {
        ...applyEnvironment(config, process.env),
        BATON_ENV_REEXEC: '1',
        BATON_ENV_DATA_DIR: dataDirectory,
        BATON_ENV_REVISION: config.revision,
      }
  }
  const child = spawn(binary, [...args], { stdio: 'inherit', windowsHide: true, env })
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGTERM' ? 0 : 1)))
  })
  void exited.catch(() => {})
  const interrupt = () => child.kill('SIGINT')
  const terminate = () => child.kill('SIGTERM')
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', terminate)
  try {
    if (args[0] === 'run' || args[0] === 'up') {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })
      const parentPid = Number(process.env.BATON_SHIM_PID)
      const parentCreation = process.env.BATON_SHIM_CREATION_TIME
      const launcher =
        Number.isSafeInteger(parentPid) && parentPid > 1 && parentCreation
          ? await readProcessIdentity(parentPid)
          : await readProcessIdentity(process.pid)
      const daemon = child.pid ? await readProcessIdentity(child.pid) : undefined
      if (!launcher || !daemon || (parentCreation && launcher.creationTime !== parentCreation)) {
        child.kill('SIGTERM')
        throw new Error('Unable to verify launched daemon identity')
      }
      const { readUpdateState } = await import('./update-state.ts')
      const update = await readUpdateState(dataDirectory)
      await writePrivateFileAtomic(
        join(dataDirectory, 'launcher-child.json'),
        JSON.stringify({
          launcher_pid: launcher.pid,
          launcher_creation_time: launcher.creationTime,
          daemon_pid: daemon.pid,
          daemon_creation_time: daemon.creationTime,
          desktop_managed: process.env.BATON_DESKTOP_MANAGED === '1',
          ...(update?.phase === 'syncing' ? { operation_id: update.operation_id, attempt: update.attempt } : {}),
        }),
      )
    }
    return await exited
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await exited.catch(() => undefined)
    throw error
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
  }
}
