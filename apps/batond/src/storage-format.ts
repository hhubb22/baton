import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import { Effect } from 'effect'
import type { SqliteClient } from '@baton/sqlite'
import { hasCode } from './platform/errors.ts'

type Row = Record<string, SQLOutputValue>
export class StorageFormatError extends Error {
  constructor(
    readonly code: 'storage_version_unsupported' | 'migration_checksum_mismatch',
    message: string,
  ) {
    super(`${code}: ${message}`)
  }
}

const unsupported = (kind: string): never => {
  throw new StorageFormatError('storage_version_unsupported', `${kind} 账本格式未知、损坏或不受支持`)
}
const checksum = (kind: string, statements: readonly string[]) =>
  createHash('sha256')
    .update(JSON.stringify({ kind, version: 1, payloadVersion: 1, statements }))
    .digest('hex')

function validate(meta: readonly Row[], migrations: readonly Row[], kind: string, statements: readonly string[]) {
  if (
    meta.length !== 1 ||
    meta[0]!.id !== 1 ||
    meta[0]!.kind !== kind ||
    meta[0]!.version !== 1 ||
    migrations.length !== 1 ||
    migrations[0]!.id !== '0001_baseline'
  )
    unsupported(kind)
  if (migrations[0]!.checksum !== checksum(kind, statements))
    throw new StorageFormatError('migration_checksum_mismatch', `${kind} 基线迁移 SHA-256 不符`)
}

/** 在业务解码和打开写连接之前检查已存在的账本。 */
export function checkStorageFormat(filename: string, kind: string, statements: readonly string[]) {
  try {
    if (statSync(filename).size === 0) return
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return
    throw error
  }
  const db = new DatabaseSync(filename, { readOnly: true, allowExtension: false })
  try {
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()
    if (
      !tables.some((row) => row.name === 'storage_format') ||
      !tables.some((row) => row.name === 'storage_migrations')
    )
      unsupported(kind)
    validate(
      db.prepare('SELECT * FROM storage_format').all(),
      db.prepare('SELECT * FROM storage_migrations').all(),
      kind,
      statements,
    )
  } catch (error) {
    if (
      error instanceof Error &&
      'errcode' in error &&
      typeof error.errcode === 'number' &&
      (error.errcode & 0xff) === 1
    )
      unsupported(kind)
    throw error
  } finally {
    db.close()
  }
}

/** 仅为空库建立基线；结构、版本、迁移记录与提交 token 同事务提交。 */
export const initializeStorage = Effect.fnUntraced(function* (
  sql: SqliteClient,
  kind: string,
  statements: readonly string[],
) {
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_schema WHERE type='table'`
      if (tables.length) {
        if (
          !tables.some((row) => row.name === 'storage_format') ||
          !tables.some((row) => row.name === 'storage_migrations')
        )
          return yield* Effect.fail(new StorageFormatError('storage_version_unsupported', `${kind} 账本缺少格式元数据`))
        const meta = yield* sql<Row>`SELECT * FROM storage_format`
        const migrations = yield* sql<Row>`SELECT * FROM storage_migrations`
        yield* Effect.try({
          try: () => validate(meta, migrations, kind, statements),
          catch: (error) => error as StorageFormatError,
        })
        return
      }
      for (const statement of statements) yield* sql.unsafe(statement)
      yield* sql`CREATE TABLE storage_format (id INTEGER PRIMARY KEY CHECK(id=1), kind TEXT NOT NULL, version INTEGER NOT NULL)`
      yield* sql`CREATE TABLE storage_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`
      yield* sql`INSERT INTO storage_format VALUES (1, ${kind}, 1)`
      yield* sql`INSERT INTO storage_migrations VALUES ('0001_baseline', ${checksum(kind, statements)}, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    }),
  )
})
