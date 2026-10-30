import { join } from 'node:path'
import { copyFile, lstat, rm } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { BUILD, releaseMetadata } from '@baton/protocol/release'
import { acquireProcessLock, processLockIsHeld, ProcessLockBusy } from '../platform/lock.ts'
import { readProcessLock } from '../platform/lock.ts'
import { identityMatches } from '../platform/identity.ts'
import { ensurePrivateDirectory, readPrivateFile } from '../platform/private.ts'
import { spawnDetachedWorker } from '../platform/process.ts'
import {
  activateInstallation,
  bootstrapInstallation,
  installVersion,
  installationPaths,
  readCurrentInstallation,
} from './update-install.ts'
import {
  downloadUpdateArtifact,
  fetchUpdateManifest,
  reportNodeUpdate,
  requestNodeUpdate,
  selectUpdateArtifact,
  verifyExtractedUpdate,
} from './update-network.ts'
import { extractUpdateArchive, verifyArchive } from './update-archive.ts'
import { readRollbackReceipt, readUpdateState, saveUpdateState, type UpdateState } from './update-state.ts'
import { manageUpgrade } from './upgrade-management.ts'
import { readUpgradeState, requestUpgrade } from './upgrade.ts'
import { upgradePaths } from './upgrade.ts'
import { requestWorker } from './ipc.ts'
import { migrateUpgrade } from './upgrade-migrate.ts'
import { readUpgradePackage, sameRelease } from './upgrade-check.ts'
import { Schema } from 'effect'
import { manageService } from './service.ts'
import { resumeUpdateRollback, rollbackUpdate } from './update-rollback.ts'

const final = (state: UpdateState) => state.phase === 'completed' || state.phase === 'cancelled'
const updateLock = (directory: string) => join(directory, 'update-worker.lock')
async function desktopManaged(directory: string): Promise<boolean> {
  try {
    const record = Schema.decodeUnknownSync(
      Schema.Struct({
        launcher_pid: Schema.Int,
        launcher_creation_time: Schema.String,
        daemon_pid: Schema.Int,
        daemon_creation_time: Schema.String,
        desktop_managed: Schema.optionalKey(Schema.Boolean),
      }),
    )(JSON.parse((await readPrivateFile(join(directory, 'launcher-child.json'))).toString('utf8')))
    const lock = await readProcessLock(join(directory, 'daemon.lock'))
    return (
      record.desktop_managed === true &&
      lock?.pid === record.daemon_pid &&
      lock.creationTime === record.daemon_creation_time &&
      (await identityMatches({ pid: record.launcher_pid, creationTime: record.launcher_creation_time }))
    )
  } catch {
    return false
  }
}

async function stopDrainedDaemon(directory: string, managedByDesktop: boolean, operationId: string) {
  if (managedByDesktop) return
  const lock = await readProcessLock(join(directory, 'daemon.lock'))
  if (!lock || !(await identityMatches(lock))) return
  const paths = upgradePaths(directory)
  const result = await requestWorker({
    endpoint: paths.endpoint,
    token: (await readPrivateFile(paths.token)).toString('utf8'),
    request: { type: 'upgrade_shutdown', ok: false, payload: operationId },
    timeoutMs: 10000,
  })
  if (!result.ok) throw new Error('Daemon could not stop after draining')
}

async function restartInstalledDaemon(directory: string, managedByDesktop: boolean) {
  if (managedByDesktop) return
  let restartLock: () => Promise<void>
  try {
    restartLock = await acquireProcessLock(join(directory, 'update-restart.lock'))
  } catch (error) {
    if (error instanceof ProcessLockBusy) return
    throw error
  }
  try {
    if (await processLockIsHeld(join(directory, 'daemon.lock'))) return
    const service = await manageService('status', directory).catch(() => undefined)
    const paths = installationPaths(directory)
    if (service && 'installed' in service && service.installed) {
      if (!('program_path' in service) || service.program_path !== join(paths.launcher, paths.binary))
        throw new Error('服务入口与更新安装目录不匹配')
      await manageService('install', directory)
    } else
      await spawnDetachedWorker({
        file: join(paths.launcher, paths.binary),
        args: ['dispatch', '--data-dir', directory, '--', 'run', '--data-dir', directory],
      })
    for (let n = 0; n < 100 && !(await processLockIsHeld(join(directory, 'daemon.lock'))); n++) await delay(100)
  } finally {
    await restartLock()
  }
}

export async function waitLocalStartup(
  directory: string,
  targetVersion: string,
  managedByDesktop: boolean,
  options: { timeoutMs?: number; pollMs?: number } = {},
) {
  if (managedByDesktop) return
  const deadline = performance.now() + (options.timeoutMs ?? 60000)
  while (true) {
    const lock = await readProcessLock(join(directory, 'daemon.lock'))
    const alive = lock && (await identityMatches(lock))
    if (alive) {
      try {
        const status = Schema.decodeUnknownSync(
          Schema.Struct({ pid: Schema.Int, creation_time: Schema.String, batond_version: Schema.String }),
        )(JSON.parse((await readPrivateFile(join(directory, 'daemon-status.json'))).toString('utf8')))
        if (
          status.pid === lock.pid &&
          status.creation_time === lock.creationTime &&
          status.batond_version === targetVersion
        )
          return
      } catch {
        /* Wait while the process publishes its local status. */
      }
    }
    if (performance.now() >= deadline)
      throw new Error(alive ? '目标 daemon 本地身份或状态不匹配' : '目标 daemon 未能启动')
    await delay(options.pollMs ?? 1000)
  }
}
async function transition<A>(directory: string, operation: () => Promise<A>): Promise<A> {
  let release: (() => Promise<void>) | undefined
  for (let n = 0; n < 200 && !release; n++) {
    try {
      release = await acquireProcessLock(join(directory, 'update-transition.lock'))
    } catch (error) {
      if (!(error instanceof ProcessLockBusy)) throw error
      await delay(50)
    }
  }
  if (!release) throw new Error('更新状态正由其他进程修改')
  try {
    return await operation()
  } finally {
    await release()
  }
}

/** Persist the center identity before launching an independent updater. */
export async function startUpdate(directory: string, pending?: { operation_id: string; attempt: number }) {
  await ensurePrivateDirectory(directory)
  const launchLock = await acquireProcessLock(join(directory, 'update-launch.lock'))
  try {
    const request = pending ?? (await requestNodeUpdate(directory))
    return await transition(directory, async () => {
      const previous = await readUpdateState(directory)
      if (previous && !final(previous) && previous.operation_id !== request.operation_id)
        throw new Error('已有其他更新操作')
      if (previous?.operation_id === request.operation_id && final(previous)) return { state: previous }
      if (previous?.operation_id === request.operation_id && request.attempt < previous.attempt)
        return { state: previous }
      if (
        previous?.operation_id === request.operation_id &&
        previous.phase === 'failed' &&
        request.attempt === previous.attempt
      )
        return { state: previous }
      const current = await readCurrentInstallation(directory)
      const upgrade = await readUpgradeState(directory)
      const resumePhase =
        previous?.phase === 'failed' && upgrade?.operation_id === request.operation_id && previous.package_directory
          ? upgrade.phase === 'syncing'
            ? ('ready' as const)
            : ['migrating', 'failed'].includes(upgrade.phase)
              ? ('migrating' as const)
              : ('requested' as const)
          : ('requested' as const)
      const state: UpdateState =
        previous?.operation_id === request.operation_id
          ? previous.phase !== 'failed'
            ? { ...previous, attempt: request.attempt }
            : (() => {
                const {
                  error_code: _code,
                  reason: _reason,
                  startup_failed: _startup,
                  rollback_complete: _rollback,
                  ...rest
                } = previous
                return {
                  ...rest,
                  attempt: request.attempt,
                  ...(previous.phase === 'failed' ? { phase: resumePhase } : {}),
                }
              })()
          : {
              operation_id: request.operation_id,
              attempt: request.attempt,
              phase: 'requested',
              source_version: current.release.version,
              target_version: '',
              previous_directory: current.directory,
            }
      await saveUpdateState(directory, state)
      if (!(await processLockIsHeld(updateLock(directory)))) {
        const paths = installationPaths(directory)
        const executable =
          state.package_directory && ['ready', 'migrating', 'syncing'].includes(state.phase)
            ? join(paths.versions, state.package_directory, paths.binary)
            : join(paths.launcher, paths.binary)
        await spawnDetachedWorker({ file: executable, args: ['update-worker', '--data-dir', directory] })
      }
      return { state }
    })
  } finally {
    await launchLock()
  }
}

export async function cancelUpdate(directory: string) {
  return transition(directory, async () => {
    const state = await readUpdateState(directory)
    if (!state) return { state: null }
    if (['migrating', 'syncing', 'completed'].includes(state.phase)) throw new Error('迁移开始后不能取消更新')
    const upgrade = await readUpgradeState(directory)
    if (upgrade?.operation_id === state.operation_id && ['migrating', 'syncing', 'completed'].includes(upgrade.phase))
      throw new Error('迁移开始后不能取消更新')
    if (upgrade?.operation_id === state.operation_id && upgrade.phase !== 'cancelled')
      await manageUpgrade(directory, 'cancel')
    const cancelled = { ...state, phase: 'cancelled' as const }
    await saveUpdateState(directory, cancelled)
    await reportNodeUpdate(directory, {
      operation_id: state.operation_id,
      attempt: state.attempt,
      phase: 'cancelled',
    }).catch(() => {})
    if (state.phase === 'ready' && !state.desktop_managed && !(await processLockIsHeld(join(directory, 'daemon.lock'))))
      await restartInstalledDaemon(directory, false)
    return { state: cancelled }
  })
}

/** Desktop may report an exited target launch only after validating the same operation. */
export async function reportLocalStartupFailure(directory: string, operationId: string, attempt: number) {
  return transition(directory, async () => {
    const state = await readUpdateState(directory)
    const upgrade = await readUpgradeState(directory)
    if (
      !state ||
      state.operation_id !== operationId ||
      state.attempt !== attempt ||
      state.phase !== 'syncing' ||
      !upgrade ||
      upgrade.operation_id !== operationId ||
      upgrade.phase !== 'syncing'
    )
      throw new Error('更新操作不处于可回滚启动阶段')
    const launch = Schema.decodeUnknownSync(
      Schema.Struct({
        launcher_pid: Schema.Int,
        launcher_creation_time: Schema.String,
        daemon_pid: Schema.Int,
        daemon_creation_time: Schema.String,
        operation_id: Schema.String,
        attempt: Schema.Int,
      }),
    )(JSON.parse((await readPrivateFile(join(directory, 'launcher-child.json'))).toString('utf8')))
    if (
      launch.operation_id !== operationId ||
      launch.attempt !== attempt ||
      (await identityMatches({ pid: launch.launcher_pid, creationTime: launch.launcher_creation_time })) ||
      (await identityMatches({ pid: launch.daemon_pid, creationTime: launch.daemon_creation_time })) ||
      (await processLockIsHeld(join(directory, 'daemon.lock')))
    )
      throw new Error('目标进程仍运行或启动身份不匹配')
    const status = Schema.decodeUnknownSync(
      Schema.Struct({
        pid: Schema.Int,
        creation_time: Schema.String,
        batond_version: Schema.String,
        state: Schema.Literal('rejected'),
        code: Schema.String,
      }),
    )(JSON.parse((await readPrivateFile(join(directory, 'daemon-status.json'))).toString('utf8')))
    if (
      status.pid !== launch.daemon_pid ||
      status.creation_time !== launch.daemon_creation_time ||
      status.batond_version !== state.target_version ||
      ![
        'storage_version_unsupported',
        'migration_checksum_mismatch',
        'upgrade_migration_failed',
        'upgrade_package_invalid',
      ].includes(status.code)
    )
      throw new Error('缺少可确认的本地启动失败证据')
    const next = { ...state, startup_failed: true }
    await saveUpdateState(directory, next)
    return { state: next }
  })
}

export async function beginLocalUpdate(directory: string) {
  await bootstrapInstallation(directory)
  return startUpdate(directory)
}

export async function recoverUpdateRollback(directory: string) {
  const resumed = await resumeUpdateRollback(directory)
  const progress = await readUpdateState(directory)
  if (!progress) {
    if (resumed) throw new Error('回滚完成但更新状态缺失')
    return false
  }
  const receipt = await readRollbackReceipt(directory, progress.operation_id)
  if (!receipt || receipt.attempt !== progress.attempt || receipt.previous_directory !== progress.previous_directory) {
    if (resumed) throw new Error('回滚完成凭据缺失')
    return false
  }
  const restored = await readUpgradeState(directory)
  const current = await readCurrentInstallation(directory)
  if (
    !restored ||
    restored.operation_id !== progress.operation_id ||
    restored.phase !== 'cancelled' ||
    current.directory !== receipt.previous_directory
  )
    throw new Error('回滚结果身份不匹配')
  await transition(directory, async () => {
    const state = await readUpdateState(directory)
    if (!state) throw new Error('回滚完成但更新状态缺失')
    const failed = {
      ...state,
      phase: 'failed' as const,
      error_code: 'update_failed',
      rollback_complete: true,
      reason: '更新中断，已恢复旧版本',
    }
    await saveUpdateState(directory, failed)
    await reportNodeUpdate(directory, {
      operation_id: state.operation_id,
      attempt: state.attempt,
      phase: 'failed',
      reason: 'update_failed',
    }).catch(() => {})
  })
  return true
}

/** The process is detached from the daemon and can continue while that daemon exits. */
export async function runUpdateWorker(directory: string) {
  let release: (() => Promise<void>) | undefined
  for (let n = 0; n < 200 && !release; n++) {
    try {
      release = await acquireProcessLock(updateLock(directory))
    } catch (error) {
      if (!(error instanceof ProcessLockBusy)) throw error
      await delay(50)
    }
  }
  if (!release) throw new Error('更新进程仍在运行')
  const checkCancelled = async () => {
    const current = await readUpdateState(directory)
    if (!current || current.phase === 'cancelled') throw new Error('更新已取消')
    return current
  }
  const advance = async (phase: UpdateState['phase'], extra: Partial<UpdateState> = {}) => {
    return transition(directory, async () => {
      const state = await checkCancelled()
      const next = { ...state, ...extra, phase }
      await saveUpdateState(directory, next)
      await reportNodeUpdate(directory, { operation_id: next.operation_id, attempt: next.attempt, phase }).catch(
        () => {},
      )
      return next
    })
  }
  let shutdownRequested = false
  try {
    if (await recoverUpdateRollback(directory)) return
    let state = await checkCancelled()
    const source = await readCurrentInstallation(directory)
    if (state.phase === 'ready' || state.phase === 'migrating' || state.phase === 'syncing') {
      let launched = false
      if (!state.package_directory) throw new Error('更新目标目录缺失')
      if (!/^[a-f0-9]{64}$/.test(state.package_directory)) throw new Error('更新目标目录无效')
      const paths = installationPaths(directory)
      const target = join(paths.versions, state.package_directory)
      const targetPackage = await readUpgradePackage(target)
      if (BUILD.version !== state.target_version || !sameRelease(releaseMetadata(), targetPackage.release))
        throw new Error('更新进程版本与目标不一致')
      if (state.phase !== 'syncing') {
        await stopDrainedDaemon(directory, state.desktop_managed === true, state.operation_id)
        shutdownRequested = state.desktop_managed !== true
        while (await processLockIsHeld(join(directory, 'daemon.lock'))) {
          await checkCancelled()
          await delay(1000)
        }
        const daemonLock = await acquireProcessLock(join(directory, 'daemon.lock'))
        try {
          const saved = await readUpgradeState(directory)
          if (
            !saved ||
            !['ready', 'migrating', 'syncing'].includes(saved.phase) ||
            saved.target_version !== state.target_version
          )
            throw new Error('升级准备状态不匹配')
          if (saved.operation_id !== state.operation_id) throw new Error('升级操作身份不匹配')
        } finally {
          await daemonLock()
        }
        await manageUpgrade(directory, 'prepare', { package: target, self: true })
        await advance('migrating')
        await migrateUpgrade(directory)
        const installation = { directory: state.package_directory, release: targetPackage.release }
        while (true) {
          try {
            await activateInstallation(directory, installation, state.operation_id)
            break
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !['Daemon is still running', 'Launcher is still running'].includes(error.message)
            )
              throw error
            await delay(1000)
          }
        }
        state = await advance('syncing')
        await restartInstalledDaemon(directory, state.desktop_managed === true)
        launched = true
      }
      if (!launched && !(await processLockIsHeld(join(directory, 'daemon.lock'))))
        await restartInstalledDaemon(directory, state.desktop_managed === true)
      await waitLocalStartup(directory, state.target_version, state.desktop_managed === true)
      while (true) {
        state = await checkCancelled()
        if (state.startup_failed) throw new Error('目标 daemon 本地启动失败')
        const upgrade = await readUpgradeState(directory)
        if (upgrade?.operation_id === state.operation_id && upgrade.phase === 'completed') {
          await advance('completed')
          return
        }
        if (upgrade?.phase === 'failed') throw new Error('更新迁移或同步失败')
        await delay(1000)
      }
    }
    state = await advance('downloading')
    const manifest = await fetchUpdateManifest(directory)
    const artifact = selectUpdateArtifact(manifest, source.release)
    state = await advance('downloading', {
      target_version: manifest.payload.version,
      target_commit: manifest.payload.commit,
    })
    if (manifest.payload.version === source.release.version && manifest.payload.commit === source.release.commit) {
      await advance('completed')
      return
    }
    const paths = installationPaths(directory)
    const work = join(paths.root, `.update-${state.operation_id}`)
    await rm(work, { recursive: true, force: true })
    await ensurePrivateDirectory(work)
    try {
      const archive = join(work, 'artifact')
      const controller = new AbortController()
      const cancellation = setInterval(() => {
        void readUpdateState(directory)
          .then((current) => {
            if (current?.phase === 'cancelled') controller.abort()
          })
          .catch(() => controller.abort())
      }, 1000)
      try {
        const cached = join(paths.root, 'downloads', artifact.sha256)
        let present = false
        try {
          const info = await lstat(cached)
          if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('更新缓存无效')
          try {
            await verifyArchive(cached, artifact)
            await copyFile(cached, archive)
            await verifyArchive(archive, artifact)
            present = true
          } catch {
            await rm(archive, { force: true })
            await rm(cached, { force: true })
          }
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        }
        if (!present) await downloadUpdateArtifact(directory, artifact, archive, controller.signal)
      } finally {
        clearInterval(cancellation)
      }
      await advance('verifying')
      const unpacked = join(work, 'package')
      await extractUpdateArchive(archive, unpacked, artifact)
      await verifyExtractedUpdate(unpacked, manifest, artifact)
      const installed = await installVersion(directory, unpacked)
      state = await advance('draining', { package_directory: installed.directory })
      await transition(directory, async () => {
        await checkCancelled()
        await requestUpgrade(directory, 'upgrade_prepare', {
          package: join(paths.versions, installed.directory),
          operation_id: state.operation_id,
        })
      })
      while (true) {
        await checkCancelled()
        const status = (await requestUpgrade(directory, 'upgrade_status')) as { state?: { phase?: string } }
        if (status.state?.phase === 'ready') break
        if (status.state?.phase === 'failed' || status.state?.phase === 'cancelled') throw new Error('升级准备失败')
        await delay(1000)
      }
      state = await advance('ready', { desktop_managed: await desktopManaged(directory) })
      await spawnDetachedWorker({
        file: join(paths.versions, installed.directory, paths.binary),
        args: ['update-worker', '--data-dir', directory],
      })
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  } catch (error) {
    await transition(directory, async () => {
      const state = await readUpdateState(directory)
      if (state && state.phase !== 'cancelled') {
        const upgrade = await readUpgradeState(directory)
        let rollbackError: unknown
        let rollbackComplete = false
        if (
          state.previous_directory &&
          ['migrating', 'syncing'].includes(state.phase) &&
          upgrade?.operation_id === state.operation_id &&
          upgrade.phase !== 'completed' &&
          upgrade.backup_path &&
          upgrade.backup_checksum &&
          !(await processLockIsHeld(join(directory, 'daemon.lock')))
        ) {
          try {
            await rollbackUpdate(directory, state.operation_id, state.previous_directory)
            rollbackComplete = true
          } catch (failure) {
            rollbackError = failure
          }
        }
        const reason = error instanceof Error ? error.message : '更新失败'
        const failed = {
          ...state,
          phase: 'failed' as const,
          error_code: 'update_failed',
          rollback_complete: rollbackComplete,
          reason: rollbackError instanceof Error ? `${reason}；回滚未完成：${rollbackError.message}` : reason,
        }
        await saveUpdateState(directory, failed)
        await reportNodeUpdate(directory, {
          operation_id: state.operation_id,
          attempt: state.attempt,
          phase: 'failed',
          reason: 'update_failed',
        }).catch(() => {})
      }
    })
    const cancelled = await readUpdateState(directory)
    if (cancelled?.phase === 'cancelled' && shutdownRequested && !cancelled.desktop_managed) {
      for (let n = 0; n < 100 && (await processLockIsHeld(join(directory, 'daemon.lock'))); n++) await delay(100)
      if (!(await processLockIsHeld(join(directory, 'daemon.lock')))) await restartInstalledDaemon(directory, false)
    }
    throw error
  } finally {
    await release()
  }
}
