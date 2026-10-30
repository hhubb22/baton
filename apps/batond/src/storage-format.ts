import { LEDGER_VERSIONS } from '@baton/protocol/release'
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
const formatVersion = (kind: string) =>
  Object.hasOwn(LEDGER_VERSIONS, kind) ? LEDGER_VERSIONS[kind as keyof typeof LEDGER_VERSIONS] : unsupported(kind)
const baselineVersions: Readonly<Record<string, number>> = { node: 2, project: 1, thread: 1, execution: 1 }
const checksum = (kind: string, statements: readonly string[]) =>
  createHash('sha256')
    .update(JSON.stringify({ kind, version: baselineVersions[kind], payloadVersion: 1, statements }))
    .digest('hex')

export interface StorageMigration {
  readonly id: string
  readonly from: number
  readonly to: number
  readonly statements: readonly string[]
}
// 发布后的结构变化按账本类型追加固定迁移，不修改已发布的内容或摘要。
const migrationsByKind: Readonly<Record<string, readonly StorageMigration[]>> = {
  node: [],
  project: [],
  thread: [],
  execution: [],
}
const migrationChecksum = (migration: StorageMigration) =>
  createHash('sha256').update(JSON.stringify(migration)).digest('hex')

function validate(
  meta: readonly Row[],
  migrations: readonly Row[],
  kind: string,
  statements: readonly string[],
  requireCurrent = true,
  catalog = migrationsByKind,
  targetVersion: number = formatVersion(kind),
) {
  const known = catalog[kind]
  const baseline = baselineVersions[kind]
  if (!known || baseline === undefined) return unsupported(kind)
  if (
    meta.length !== 1 ||
    meta[0]!.id !== 1 ||
    meta[0]!.kind !== kind ||
    migrations.length < 1 ||
    migrations.length > known.length + 1 ||
    migrations[0]!.id !== '0001_baseline'
  )
    unsupported(kind)
  if (migrations[0]!.checksum !== checksum(kind, statements))
    throw new StorageFormatError('migration_checksum_mismatch', `${kind} 基线迁移 SHA-256 不符`)
  let version = baseline
  for (let index = 1; index < migrations.length; index++) {
    const expected = known[index - 1]!
    if (expected.from !== version || expected.to <= version || migrations[index]!.id !== expected.id) unsupported(kind)
    if (migrations[index]!.checksum !== migrationChecksum(expected))
      throw new StorageFormatError('migration_checksum_mismatch', `${kind} 迁移 SHA-256 不符`)
    version = expected.to
  }
  if (meta[0]!.version !== version || (requireCurrent && version !== targetVersion)) unsupported(kind)
  return version
}

/** 在业务解码和打开写连接之前检查已存在的账本。 */
export function checkStorageFormat(filename: string, kind: string, statements: readonly string[], allowOlder = false) {
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
      db.prepare('SELECT * FROM storage_migrations ORDER BY id').all(),
      kind,
      statements,
      !allowOlder,
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

/** Apply only declared migrations, in separate transactions, after the caller has taken an offline backup. */
export const applyStorageMigrations = Effect.fnUntraced(function* (
  sql: SqliteClient,
  kind: string,
  baseline: readonly string[],
  options?: { catalog: Readonly<Record<string, readonly StorageMigration[]>>; targetVersion: number },
) {
  const catalog = options?.catalog ?? migrationsByKind
  const targetVersion = options?.targetVersion ?? formatVersion(kind)
  const known = catalog[kind]
  if (!known)
    return yield* Effect.fail(new StorageFormatError('storage_version_unsupported', `${kind} 账本类型不受支持`))
  for (const migration of known) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const meta = yield* sql<Row>`SELECT * FROM storage_format`
        const records = yield* sql<Row>`SELECT * FROM storage_migrations ORDER BY id`
        const version = yield* Effect.try({
          try: () => validate(meta, records, kind, baseline, false, catalog, targetVersion),
          catch: (error) => error as StorageFormatError,
        })
        if (version >= migration.to) return
        if (version !== migration.from)
          return yield* Effect.fail(new StorageFormatError('storage_version_unsupported', `${kind} 迁移顺序不受支持`))
        for (const statement of migration.statements) yield* sql.unsafe(statement)
        yield* sql`UPDATE storage_format SET version=${migration.to} WHERE id=1`
        yield* sql`INSERT INTO storage_migrations VALUES (${migration.id}, ${migrationChecksum(migration)}, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
      }),
    )
  }
  const meta = yield* sql<Row>`SELECT * FROM storage_format`
  const records = yield* sql<Row>`SELECT * FROM storage_migrations ORDER BY id`
  yield* Effect.try({
    try: () => validate(meta, records, kind, baseline, true, catalog, targetVersion),
    catch: (error) => error as StorageFormatError,
  })
})

/** 仅为空库建立基线；结构、版本、迁移记录与提交 token 同事务提交。 */
export const initializeStorage = Effect.fnUntraced(function* (
  sql: SqliteClient,
  kind: string,
  statements: readonly string[],
) {
  const baselineVersion = baselineVersions[kind]
  if (baselineVersion === undefined)
    return yield* Effect.fail(new StorageFormatError('storage_version_unsupported', `${kind} 账本类型不受支持`))
  const created = yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_schema WHERE type='table'`
      if (tables.length) {
        if (
          !tables.some((row) => row.name === 'storage_format') ||
          !tables.some((row) => row.name === 'storage_migrations')
        )
          return yield* Effect.fail(new StorageFormatError('storage_version_unsupported', `${kind} 账本缺少格式元数据`))
        const meta = yield* sql<Row>`SELECT * FROM storage_format`
        const migrations = yield* sql<Row>`SELECT * FROM storage_migrations ORDER BY id`
        yield* Effect.try({
          try: () => validate(meta, migrations, kind, statements),
          catch: (error) => error as StorageFormatError,
        })
        return false
      }
      for (const statement of statements) yield* sql.unsafe(statement)
      yield* sql`CREATE TABLE storage_format (id INTEGER PRIMARY KEY CHECK(id=1), kind TEXT NOT NULL, version INTEGER NOT NULL)`
      yield* sql`CREATE TABLE storage_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`
      yield* sql`INSERT INTO storage_format VALUES (1, ${kind}, ${baselineVersion})`
      yield* sql`INSERT INTO storage_migrations VALUES ('0001_baseline', ${checksum(kind, statements)}, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
      return true
    }),
  )
  if (created) yield* applyStorageMigrations(sql, kind, statements)
})
