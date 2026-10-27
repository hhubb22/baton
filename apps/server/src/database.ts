import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Redacted } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import type { SqlError } from 'effect/sql/SqlError'
import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { AppError } from './errors.ts'

export type DatabaseEffect<A> = Effect.Effect<A, AppError, SqlClient.SqlClient>

export const dbError = (error: unknown): AppError =>
  error instanceof AppError ? error : new AppError(503, 'unavailable', '暂时无法处理请求')

export const transaction = <A>(effect: Effect.Effect<A, AppError | SqlError, SqlClient.SqlClient>): DatabaseEffect<A> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(effect)
  }).pipe(Effect.mapError(dbError))

export interface DatabaseConfig {
  readonly url: string
  readonly schema?: string
  readonly maxConnections?: number
}

export const databaseLayer = (config: DatabaseConfig) => {
  if (config.schema && !/^[a-z][a-z0-9_]{0,62}$/.test(config.schema)) {
    throw new AppError(400, 'invalid_schema', '数据库 schema 名称无效')
  }
  return PgClient.layer({
    url: Redacted.make(config.url),
    maxConnections: config.maxConnections ?? 10,
    connectTimeout: '5 seconds',
    acquireTimeout: '10 seconds',
    // pgvector 的类型和运算符位于 public。
    ...(config.schema ? { startupParameters: { search_path: `${config.schema},public` } } : {}),
  })
}

export const createDatabaseRuntime = (config: DatabaseConfig, telemetry: Layer.Layer<never> = Layer.empty) =>
  ManagedRuntime.make(databaseLayer(config).pipe(Layer.provideMerge(telemetry)))

/** 在同一事务内锁定迁移并执行 SQL 脚本。 */
export const migrateDatabase = (
  directory = fileURLToPath(new URL('../../../migrations/', import.meta.url)),
): DatabaseEffect<void> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const files = yield* Effect.tryPromise({
      try: async () => {
        const names = (await readdir(directory)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort()
        if (names.length === 0) throw new Error('missing migrations')
        return Promise.all(
          names.map(async (name) => {
            const body = await readFile(`${directory}/${name}`, 'utf8')
            return { name, body, checksum: createHash('sha256').update(body).digest('hex') }
          }),
        )
      },
      catch: dbError,
    })
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT pg_advisory_xact_lock(4815162342)`
        yield* sql`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL)`
        const columns = yield* sql<{
          column_name: string
        }>`SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='schema_migrations'`
        if (!columns.some((column) => column.column_name === 'checksum'))
          return yield* Effect.fail(
            new AppError(503, 'storage_version_unsupported', '数据库缺少迁移摘要，实验格式需要重建'),
          )
        const applied = yield* sql<{
          version: string
          checksum: string
        }>`SELECT version, checksum FROM schema_migrations ORDER BY version`
        if (applied.some((row, index) => row.version !== files[index]?.name)) {
          return yield* Effect.fail(
            new AppError(503, 'storage_version_unsupported', '数据库迁移未知、缺失或超出程序支持范围'),
          )
        }
        if (applied.some((row, index) => row.checksum !== files[index]!.checksum)) {
          return yield* Effect.fail(new AppError(503, 'migration_checksum_mismatch', '已应用 SQL 的 SHA-256 不符'))
        }
        for (const file of files) {
          if (applied.some((row) => row.version === file.name)) continue
          if (!file.body.trim()) return yield* Effect.fail(new AppError(503, 'invalid_migration', '迁移内容为空'))
          // PgClient 使用扩展查询协议；DO 中的 EXECUTE 保持脚本和函数体完整。
          const tag = randomUUID().replaceAll('-', '')
          yield* sql.unsafe(
            `DO $outer_${tag}$ BEGIN EXECUTE $script_${tag}$${file.body}$script_${tag}$; END $outer_${tag}$`,
          ).unprepared
          yield* sql`INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (${file.name}, ${file.checksum}, now())`
        }
        const saved = yield* sql<{ version: string }>`SELECT version FROM schema_migrations ORDER BY version`
        if (saved.length !== files.length || saved.some((row, index) => row.version !== files[index].name)) {
          return yield* Effect.fail(new AppError(503, 'storage_version_unsupported', '数据库迁移未完成'))
        }
      }),
    )
  }).pipe(Effect.mapError(dbError))
