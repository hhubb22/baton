import { cp, lstat, realpath, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Schema } from 'effect'
import { UUID } from '@baton/protocol'
import { acquireProcessLock, type ProcessLock } from '../platform/lock.ts'
import { ensurePrivateDirectory, readPrivateFile, writePrivateFileAtomic } from '../platform/private.ts'
import { isMissing } from './identity.ts'
import { dataEntries, verifyUpgradeBackup } from './upgrade-backup.ts'
import { readUpgradeState, saveUpgradeState, upgradeBlockers } from './upgrade.ts'
import { installationPaths, restoreInstallation } from './update-install.ts'
import { readUpdateState, writeRollbackReceipt } from './update-state.ts'

const Journal = Schema.Struct({
  operation_id: UUID,
  previous_directory: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  backup_path: Schema.String,
  backup_checksum: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  names: Schema.Array(Schema.String),
  backup_names: Schema.Array(Schema.String),
})
type Journal = typeof Journal.Type

const exists = async (path: string) => {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}
const journalPath = (directory: string) => join(installationPaths(directory).root, 'rollback.json')
const safeName = (name: string) => name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\')

async function withDataLocks<A>(directory: string, work: (daemonLock: ProcessLock) => Promise<A>): Promise<A> {
  const releases: ProcessLock[] = []
  try {
    for (const name of ['daemon', 'identity', 'browse-roots', 'project-exec'])
      releases.push(await acquireProcessLock(join(directory, `${name}.lock`)))
    return await work(releases[0]!)
  } finally {
    for (const release of releases.reverse()) await release()
  }
}

async function applyRollback(directory: string, journal: Journal, daemonLock: ProcessLock): Promise<void> {
  if (journal.names.some((name) => !safeName(name)) || journal.backup_names.some((name) => !safeName(name)))
    throw new Error('回滚记录路径无效')
  await verifyUpgradeBackup(journal.backup_path, journal.backup_checksum, journal.operation_id, directory)
  const root = join(installationPaths(directory).root, `rollback-${journal.operation_id}`)
  const stage = join(root, 'staged')
  const original = join(root, 'original')
  await ensurePrivateDirectory(original)
  for (const name of journal.names) {
    const current = join(directory, name)
    const pending = join(stage, name)
    const saved = join(original, name)
    const hasBackup = journal.backup_names.includes(name)
    if (await exists(pending)) {
      if (await exists(current)) {
        if (await exists(saved)) throw new Error('回滚目录状态冲突')
        await rename(current, saved)
      }
      await rename(pending, current)
    } else if (hasBackup) {
      if (!(await exists(current))) throw new Error('回滚数据缺失')
    } else if (await exists(current)) {
      if (await exists(saved)) throw new Error('回滚目录状态冲突')
      await rename(current, saved)
    }
  }
  await restoreInstallation(directory, journal.previous_directory, journal.operation_id, daemonLock)
  const restored = await readUpgradeState(directory)
  if (!restored || restored.operation_id !== journal.operation_id || restored.phase === 'completed')
    throw new Error('恢复后的升级状态无效')
  await saveUpgradeState(directory, { ...restored, phase: 'cancelled' })
  const progress = await readUpdateState(directory)
  if (!progress || progress.operation_id !== journal.operation_id) throw new Error('回滚操作状态不匹配')
  await writeRollbackReceipt(directory, {
    operation_id: journal.operation_id,
    attempt: progress.attempt,
    previous_directory: journal.previous_directory,
    backup_checksum: journal.backup_checksum,
  })
  await rm(journalPath(directory))
}

/** A durable journal blocks launch until all backup entries and the old installation are restored. */
export async function resumeUpdateRollback(dataDirectory: string): Promise<boolean> {
  const directory = await realpath(dataDirectory)
  let journal: Journal
  try {
    journal = Schema.decodeUnknownSync(Journal)(
      JSON.parse((await readPrivateFile(journalPath(directory))).toString('utf8')),
    )
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
  await withDataLocks(directory, (daemonLock) => applyRollback(directory, journal, daemonLock))
  return true
}

export async function rollbackUpdate(
  dataDirectory: string,
  operationId: string,
  previousDirectory: string,
): Promise<void> {
  const directory = await realpath(dataDirectory)
  Schema.decodeUnknownSync(UUID)(operationId)
  if (!/^[a-f0-9]{64}$/.test(previousDirectory)) throw new Error('旧版本目录无效')
  await withDataLocks(directory, async (daemonLock) => {
    if (await exists(journalPath(directory))) {
      const journal = Schema.decodeUnknownSync(Journal)(
        JSON.parse((await readPrivateFile(journalPath(directory))).toString('utf8')),
      )
      if (journal.operation_id !== operationId) throw new Error('已有其他回滚操作')
      await applyRollback(directory, journal, daemonLock)
      return
    }
    const state = await readUpgradeState(directory)
    if (
      !state ||
      state.operation_id !== operationId ||
      state.phase === 'completed' ||
      !state.backup_path ||
      !state.backup_checksum
    )
      throw new Error('升级已完成或缺少一致备份，不能自动回滚')
    const blockers = await upgradeBlockers(directory)
    if (blockers.blockers.length) throw new Error('仍有设备进程或未确认的清理，不能回滚')
    await verifyUpgradeBackup(state.backup_path, state.backup_checksum, operationId, directory)
    const root = join(installationPaths(directory).root, `rollback-${operationId}`)
    const stage = join(root, 'staged')
    const temp = join(root, 'copying')
    await ensurePrivateDirectory(root)
    if (!(await exists(stage))) {
      await rm(temp, { recursive: true, force: true })
      await cp(join(state.backup_path, 'data'), temp, { recursive: true, force: false, errorOnExist: true })
      await rename(temp, stage)
    }
    const top = async (path: string) =>
      (await dataEntries(path))
        .filter((entry) => !entry.path.includes('/') && !entry.path.includes('\\'))
        .map((entry) => entry.path)
    const backupNames = await top(stage)
    const names = [...new Set([...(await top(directory)), ...backupNames])].sort()
    const journal = Schema.decodeUnknownSync(Journal)({
      operation_id: operationId,
      previous_directory: previousDirectory,
      backup_path: state.backup_path,
      backup_checksum: state.backup_checksum,
      names,
      backup_names: backupNames,
    })
    await writePrivateFileAtomic(journalPath(directory), JSON.stringify(journal))
    await applyRollback(directory, journal, daemonLock)
  })
}
