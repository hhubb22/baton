import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vite-plus/test'

const restore = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('./update-install.ts', () => ({
  installationPaths: (directory: string) => ({ root: join(directory, 'installation') }),
  restoreInstallation: restore,
}))

import { createUpgradeBackup } from './upgrade-backup.ts'
import { saveUpgradeState, readUpgradeState } from './upgrade.ts'
import { resumeUpdateRollback, rollbackUpdate } from './update-rollback.ts'
import { ensurePrivateDirectory } from '../platform/private.ts'
import { readRollbackReceipt, saveUpdateState } from './update-state.ts'

it('restores the verified backup before resuming the old installation and refuses completed updates', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'baton-rollback-')))
  try {
    await ensurePrivateDirectory(join(directory, 'installation'))
    const operation = randomUUID()
    const oldDirectory = 'a'.repeat(64)
    await saveUpdateState(directory, {
      operation_id: operation,
      attempt: 1,
      phase: 'failed',
      source_version: 'v1.0.0',
      target_version: 'v1.1.0',
    })
    await writeFile(join(directory, 'identity.json'), 'before')
    await saveUpgradeState(directory, {
      operation_id: operation,
      source_version: 'v1.0.0',
      target_version: 'v1.1.0',
      phase: 'ready',
    })
    const backup = await createUpgradeBackup(directory, operation)
    await saveUpgradeState(directory, {
      operation_id: operation,
      source_version: 'v1.0.0',
      target_version: 'v1.1.0',
      phase: 'failed',
      ...backup,
    })
    await writeFile(join(directory, 'identity.json'), 'after')
    await writeFile(join(directory, 'new-data'), 'uncommitted')
    await rollbackUpdate(directory, operation, oldDirectory)
    expect(await readFile(join(directory, 'identity.json'), 'utf8')).toBe('before')
    await expect(readFile(join(directory, 'new-data'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(restore).toHaveBeenCalledWith(directory, oldDirectory, operation, expect.any(Function))
    expect((await readUpgradeState(directory))?.phase).toBe('cancelled')
    expect(await readRollbackReceipt(directory, operation)).toMatchObject({
      attempt: 1,
      backup_checksum: backup.backup_checksum,
    })
    await saveUpgradeState(directory, {
      operation_id: operation,
      source_version: 'v1.0.0',
      target_version: 'v1.1.0',
      phase: 'completed',
      ...backup,
    })
    await expect(rollbackUpdate(directory, operation, oldDirectory)).rejects.toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
    await rm(`${directory}.upgrade-backups`, { recursive: true, force: true })
  }
})

it('resumes a journal after interruption without overwriting the restored data', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'baton-rollback-resume-')))
  try {
    await ensurePrivateDirectory(join(directory, 'installation'))
    const operation = randomUUID()
    await saveUpdateState(directory, {
      operation_id: operation,
      attempt: 1,
      phase: 'failed',
      source_version: 'v1.0.0',
      target_version: 'v1.1.0',
    })
    await writeFile(join(directory, 'saved-data'), 'before')
    await saveUpgradeState(directory, {
      operation_id: operation,
      source_version: 'v1.0.0',
      target_version: 'v1.1.0',
      phase: 'ready',
    })
    const backup = await createUpgradeBackup(directory, operation)
    await saveUpgradeState(directory, {
      operation_id: operation,
      source_version: 'v1.0.0',
      target_version: 'v1.1.0',
      phase: 'failed',
      ...backup,
    })
    await writeFile(join(directory, 'saved-data'), 'after')
    restore.mockRejectedValueOnce(new Error('interrupted'))
    await expect(rollbackUpdate(directory, operation, 'b'.repeat(64))).rejects.toThrow('interrupted')
    expect(await readFile(join(directory, 'saved-data'), 'utf8')).toBe('before')
    expect(await resumeUpdateRollback(directory)).toBe(true)
    expect(await readFile(join(directory, 'saved-data'), 'utf8')).toBe('before')
    expect((await readUpgradeState(directory))?.phase).toBe('cancelled')
    expect(await resumeUpdateRollback(directory)).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
    await rm(`${directory}.upgrade-backups`, { recursive: true, force: true })
  }
})

it('preserves current data when the backup has been modified', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'baton-rollback-tamper-')))
  try {
    await ensurePrivateDirectory(join(directory, 'installation'))
    const operation = randomUUID()
    await writeFile(join(directory, 'saved-data'), 'before')
    await saveUpgradeState(directory, {
      operation_id: operation,
      source_version: 'v1.0.0',
      target_version: 'v1.1.0',
      phase: 'ready',
    })
    const backup = await createUpgradeBackup(directory, operation)
    await saveUpgradeState(directory, {
      operation_id: operation,
      source_version: 'v1.0.0',
      target_version: 'v1.1.0',
      phase: 'failed',
      ...backup,
    })
    await writeFile(join(directory, 'saved-data'), 'current')
    await writeFile(join(backup.backup_path, 'data', 'saved-data'), 'tampered')
    await expect(rollbackUpdate(directory, operation, 'c'.repeat(64))).rejects.toThrow('备份')
    expect(await readFile(join(directory, 'saved-data'), 'utf8')).toBe('current')
  } finally {
    await rm(directory, { recursive: true, force: true })
    await rm(`${directory}.upgrade-backups`, { recursive: true, force: true })
  }
})
