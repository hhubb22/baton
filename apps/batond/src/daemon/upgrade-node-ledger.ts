import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { checkStorageFormat, StorageFormatError } from '../storage-format.ts'
import { storageBaseline } from './ledger.ts'

// v0.1.3 的 node 基线摘要；后续基线变更不能改变旧格式的校验结果。
const legacyChecksum = 'b0c6072be2ce435eb49ad22fe645cddabc081ff54b540386f06f1b9fae98c880'
const checksum = (version: number, statements: readonly string[]) =>
  createHash('sha256')
    .update(JSON.stringify({ kind: 'node', version, payloadVersion: 1, statements }))
    .digest('hex')

function validateLegacy(db: DatabaseSync) {
  let meta: ReturnType<ReturnType<DatabaseSync['prepare']>['all']>
  let migrations: typeof meta
  try {
    meta = db.prepare('SELECT * FROM storage_format').all()
    migrations = db.prepare('SELECT * FROM storage_migrations').all()
  } catch (error) {
    if (
      error instanceof Error &&
      'errcode' in error &&
      typeof error.errcode === 'number' &&
      (error.errcode & 0xff) === 1
    )
      throw new StorageFormatError('storage_version_unsupported', 'node 账本格式不受支持')
    throw error
  }
  if (
    meta.length !== 1 ||
    meta[0]?.id !== 1 ||
    meta[0]?.kind !== 'node' ||
    meta[0]?.version !== 1 ||
    migrations.length !== 1 ||
    migrations[0]?.id !== '0001_baseline'
  )
    throw new StorageFormatError('storage_version_unsupported', 'node 账本格式不受支持')
  if (migrations[0]?.checksum !== legacyChecksum)
    throw new StorageFormatError('migration_checksum_mismatch', 'node 旧版基线迁移 SHA-256 不符')
}

/** 升级预检只读取账本，接受当前格式或经过摘要验证的 v0.1.3 格式。 */
export function checkNodeUpgradeStorage(filename: string) {
  try {
    checkStorageFormat(filename, 'node', storageBaseline)
    return
  } catch (error) {
    if (!(error instanceof StorageFormatError) || error.code !== 'storage_version_unsupported') throw error
  }
  const db = new DatabaseSync(filename, { readOnly: true, allowExtension: false })
  try {
    validateLegacy(db)
  } finally {
    db.close()
  }
}

/** 必须在设备锁和完整备份下运行；事务提交后可安全重试。 */
export function migrateNodeLedger(filename: string) {
  try {
    checkStorageFormat(filename, 'node', storageBaseline)
    return
  } catch (error) {
    if (!(error instanceof StorageFormatError) || error.code !== 'storage_version_unsupported') throw error
  }
  const db = new DatabaseSync(filename, { allowExtension: false })
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      validateLegacy(db)
      db.exec('ALTER TABLE node_outbox ADD COLUMN created_ms INTEGER NOT NULL DEFAULT 0')
      db.prepare('UPDATE node_outbox SET created_ms = ?').run(Date.now())
      db.exec('UPDATE storage_format SET version = 2')
      db.prepare('UPDATE storage_migrations SET checksum = ? WHERE id = ?').run(
        checksum(2, storageBaseline),
        '0001_baseline',
      )
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } finally {
    db.close()
  }
}
