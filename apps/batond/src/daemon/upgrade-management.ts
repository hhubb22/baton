import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { acquireProcessLock, ProcessLockBusy, type ProcessLock } from '../platform/lock.ts'
import { validatePrivateDirectory } from '../platform/private.ts'
import { isMissing } from './identity.ts'
import { IPCError } from './ipc.ts'
import {
  cancelUpgrade,
  prepareSelfUpgrade,
  prepareUpgrade,
  prepareUpgradeVersion,
  readUpgradeState,
  requestUpgrade,
  saveUpgradeState,
  upgradeBlockers,
  type UpgradeBlocker,
  type VersionPreparation,
} from './upgrade.ts'

export type UpgradePreparation = VersionPreparation | { package: string; self?: boolean }

/** 推进就绪的调用者必须持有 daemon.lock，且已关闭自身的业务 Scope。 */
export async function upgradeStatus(directory: string, advance = false) {
  let state = await readUpgradeState(directory)
  let status = await upgradeBlockers(directory)
  if (advance && state?.phase === 'draining' && status.blockers.length === 0) {
    const locks: ProcessLock[] = []
    try {
      for (const name of ['identity', 'browse-roots', 'project-exec']) {
        try {
          locks.push(await acquireProcessLock(join(directory, `${name}.lock`)))
        } catch (error) {
          if (!(error instanceof ProcessLockBusy)) throw error
          status.blockers.push({ kind: 'process', id: name, reason: 'writer_alive_or_unconfirmed' })
          return { state, ...status }
        }
      }
      status = await upgradeBlockers(directory)
      if (status.blockers.length === 0) {
        state = { ...state, phase: 'ready' }
        await saveUpgradeState(directory, state)
      }
    } finally {
      for (const release of locks.reverse()) await release()
    }
  }
  return { state: state ?? null, ...status }
}

/** 无 daemon 时仅管理暂停文件与只读检查，不打开业务写连接或清理存活进程。 */
export async function manageUpgrade(
  dataDirectory: string,
  command: 'prepare' | 'status' | 'cancel',
  target?: UpgradePreparation,
) {
  let directory: string
  try {
    directory = await realpath(dataDirectory)
    await validatePrivateDirectory(directory)
  } catch (error) {
    if (command === 'status' && isMissing(error)) return upgradeStatus(dataDirectory)
    throw error
  }
  const self = target && 'package' in target && target.self
  let release: ProcessLock
  try {
    release = await acquireProcessLock(join(directory, 'daemon.lock'))
  } catch (error) {
    if (!(error instanceof ProcessLockBusy)) throw error
    if (self) throw new IPCError('upgrade_busy', 'daemon 或迁移进程仍持有数据目录锁，请等待其退出后准备本应用')
    const state = await readUpgradeState(directory)
    if (
      command === 'status' &&
      (state?.phase === 'migrating' || state?.phase === 'syncing' || state?.error_code === 'upgrade_migration_failed')
    )
      return upgradeStatus(directory)
    try {
      return await requestUpgrade(
        directory,
        command === 'prepare' ? 'upgrade_prepare' : command === 'cancel' ? 'upgrade_cancel' : 'upgrade_status',
        target && ('version' in target ? target : target.package),
      )
    } catch (failure) {
      if (!isMissing(failure) && !(failure instanceof IPCError && ['unreachable', 'closed'].includes(failure.code)))
        throw failure
      if (command !== 'status') throw new IPCError('upgrade_busy', '数据目录仍被占用，升级管理入口暂不可用，请稍后重试')
      const status = await upgradeStatus(directory)
      const blocker: UpgradeBlocker = { kind: 'process', id: 'daemon', reason: 'daemon_or_upgrade_alive' }
      return { ...status, blockers: [...status.blockers, blocker] }
    }
  }
  try {
    if (command === 'prepare') {
      if (!target) throw new IPCError('invalid_request', '准备升级需要版本或安装包')
      if ('version' in target) await prepareUpgradeVersion(directory, target)
      else if (target.self) await prepareSelfUpgrade(directory, target.package)
      else await prepareUpgrade(directory, target.package)
    } else if (command === 'cancel') await cancelUpgrade(directory)
    return await upgradeStatus(directory, command === 'status')
  } finally {
    await release()
  }
}
