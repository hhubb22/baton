import { releaseMetadata } from '@baton/protocol/release'
import { Effect } from 'effect'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { acquireProcessLock, ProcessLockBusy, type ProcessLock } from '../platform/lock.ts'
import { openPrivateFile, validatePrivateDirectory, writePrivateFileAtomic } from '../platform/private.ts'
import { makeNodeLedger } from './ledger.ts'
import { makeProjectLedger } from '../project/ledger.ts'
import { openWorkerLedger } from '../worker/ledger.ts'
import { IPCError } from './ipc.ts'
import { isMissing } from './identity.ts'
import { readUpgradeState, saveUpgradeState, upgradeBlockers, type UpgradeState } from './upgrade.ts'
import { readUpgradePackage, sameRelease, upgradeLedgers } from './upgrade-check.ts'
import { createUpgradeBackup, verifyUpgradeBackup } from './upgrade-backup.ts'

/** 节点锁覆盖备份、逐库核验和阶段提交；根配置沿用各自已有的写锁。 */
export async function migrateUpgrade(dataDirectory: string): Promise<UpgradeState> {
  const directory = await realpath(dataDirectory)
  await validatePrivateDirectory(directory)
  const locks: ProcessLock[] = []
  try {
    try {
      for (const name of ['daemon', 'identity', 'browse-roots', 'project-exec'])
        locks.push(await acquireProcessLock(join(directory, `${name}.lock`)))
    } catch (error) {
      if (error instanceof ProcessLockBusy)
        throw new IPCError('upgrade_busy', 'daemon 或其他数据写入者仍存活，不能迁移')
      throw error
    }
    let state = await readUpgradeState(directory)
    if (
      !state ||
      !(
        ['ready', 'migrating', 'syncing'].includes(state.phase) ||
        (state.phase === 'failed' && state.error_code === 'upgrade_migration_failed')
      )
    )
      throw new IPCError('upgrade_busy', '升级尚未 ready，或失败不属于可继续的迁移')
    if (!state.checked_release || !state.target_path)
      throw new IPCError(
        'upgrade_backup_required',
        '缺少目标预检记录，请先由目标程序执行 prepare --package <目录> --self',
      )
    const target = await readUpgradePackage(state.target_path)
    if (
      state.target_version !== target.release.version ||
      !sameRelease(state.checked_release, target.release) ||
      !sameRelease(releaseMetadata(), target.release)
    )
      throw new IPCError(
        'upgrade_package_invalid',
        '请使用预检目标包中的 batond 执行 migrate；当前程序或安装包身份不符',
      )
    if (
      !state.backup_path !== !state.backup_checksum ||
      (['migrating', 'syncing'].includes(state.phase) && !state.backup_path)
    )
      throw new IPCError('upgrade_backup_required', '迁移记录缺少完整备份信息，保留当前数据并核对原备份')
    const blockers = await upgradeBlockers(directory)
    if (blockers.blockers.length)
      throw new IPCError('upgrade_busy', `仍有执行或清理义务：${JSON.stringify(blockers.blockers)}`)
    try {
      if (state.backup_path && state.backup_checksum) {
        await verifyUpgradeBackup(state.backup_path, state.backup_checksum, state.operation_id, directory)
      } else {
        const backup = await createUpgradeBackup(directory, state.operation_id)
        state = { ...state, ...backup }
      }
      const { reason: _reason, error_code: _error, ...clean } = state
      state = { ...clean, phase: 'migrating' }
      await saveUpgradeState(directory, state)
      // 首版只有基线，逐库仍复用原事务与 commit token 核验，不记录额外迁移进度。
      for (const file of await upgradeLedgers(directory)) {
        try {
          const handle = await openPrivateFile(file.path)
          await handle.close()
        } catch (error) {
          if (!isMissing(error)) throw error
          await writePrivateFileAtomic(file.path, '')
        }
        if (file.kind === 'node') await Effect.runPromise(Effect.scoped(makeNodeLedger(file.path)))
        else if (file.kind === 'project') await Effect.runPromise(Effect.scoped(makeProjectLedger(file.path)))
        else await Effect.runPromise(Effect.scoped(openWorkerLedger({ dbPath: file.path, dataDirectory: directory })))
      }
      state = { ...state, phase: 'syncing' }
      await saveUpgradeState(directory, state)
      return state
    } catch (error) {
      const reason = error instanceof Error ? error.message : '本地迁移失败'
      await saveUpgradeState(directory, { ...state, phase: 'failed', error_code: 'upgrade_migration_failed', reason })
      throw new IPCError('upgrade_migration_failed', reason)
    }
  } finally {
    for (const release of locks.reverse()) await release()
  }
}
