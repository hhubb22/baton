// Copyright (c) 2026 T3 Tools Inc.
// SPDX-License-Identifier: MIT
// Adapted from t3code's nodeSqliteClient.ts; see third_party/t3code/README.md.
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Semaphore from 'effect/Semaphore'
import * as Stream from 'effect/Stream'
import * as Reactivity from 'effect/reactivity/Reactivity'
import * as Client from 'effect/sql/SqlClient'
import type { Connection } from 'effect/sql/SqlConnection'
import { classifySqliteError, SqlError } from 'effect/sql/SqlError'
import * as Statement from 'effect/sql/Statement'

export interface SqliteClientConfig {
  readonly filename: string
  readonly readonly?: boolean
  readonly busyTimeoutMs?: number
  readonly transformQueryNames?: (name: string) => string
  readonly transformResultNames?: (name: string) => string
}

const sqlError = (cause: unknown, operation: string) => {
  // node:sqlite uses errcode; Effect's SQLite classifier reads errno.
  if (cause instanceof Error && 'errcode' in cause && typeof cause.errcode === 'number') {
    Object.assign(cause, { errno: cause.errcode })
  }
  return new SqlError({ reason: classifySqliteError(cause, { operation, message: `SQLite ${operation} failed` }) })
}

/** A scoped, single-connection client. Transactions and standalone queries share the same permit. */
export const make = Effect.fn('SqliteClient.make')(function* (config: SqliteClientConfig) {
  const db = yield* Effect.acquireRelease(
    Effect.try({
      try: () => new DatabaseSync(config.filename, { readOnly: config.readonly ?? false, allowExtension: false }),
      catch: (cause) => sqlError(cause, 'open'),
    }),
    (database) => Effect.sync(() => database.close()),
  )
  yield* Effect.try({
    try: () => {
      const timeout = config.busyTimeoutMs ?? 5000
      if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 2147483647) {
        throw new RangeError('busyTimeoutMs must be an integer between 0 and 2147483647')
      }
      db.exec(`PRAGMA busy_timeout = ${timeout}; PRAGMA foreign_keys = ON;`)
      if (!config.readonly) {
        const mode = db.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode
        if (config.filename !== ':memory:' && mode !== 'wal') throw new Error(`Expected WAL, got ${String(mode)}`)
        db.exec('PRAGMA synchronous = FULL;')
      }
    },
    catch: (cause) => sqlError(cause, 'configure'),
  })

  const run = (sql: string, params: ReadonlyArray<unknown>, mode: 'rows' | 'values' | 'raw' = 'rows') =>
    Effect.withFiber((fiber) =>
      Effect.try({
        try: () => {
          const statement = db.prepare(sql)
          statement.setReadBigInts(Context.get(fiber.context, Client.SafeIntegers))
          if (statement.columns().length === 0) {
            const result = statement.run(...(params as SQLInputValue[]))
            return mode === 'raw' ? result : []
          }
          if (mode === 'values') statement.setReturnArrays(true)
          return statement.all(...(params as SQLInputValue[]))
        },
        catch: (cause) => sqlError(cause, 'execute'),
      }),
    )

  const rows = (sql: string, params: ReadonlyArray<unknown>) =>
    run(sql, params) as Effect.Effect<ReadonlyArray<Record<string, SQLOutputValue>>, SqlError>
  const values = (sql: string, params: ReadonlyArray<unknown>) =>
    run(sql, params, 'values') as unknown as Effect.Effect<ReadonlyArray<ReadonlyArray<SQLOutputValue>>, SqlError>
  const execute: Connection['execute'] = (sql, params, transform) =>
    transform ? Effect.map(rows(sql, params), transform) : rows(sql, params)
  const connection: Connection = {
    execute,
    executeUnprepared: execute,
    executeRaw: (sql, params) => run(sql, params, 'raw'),
    executeValues: values,
    executeValuesUnprepared: values,
    executeStream: (sql, params, transform) =>
      Stream.fromEffect(execute(sql, params, transform)).pipe(Stream.flatMap(Stream.fromIterable)),
  }
  const semaphore = yield* Semaphore.make(1)
  const acquirers = Client.makeSqliteAcquirers({
    connection: Effect.succeed(connection),
    semaphore,
    isTransaction: () => db.isTransaction,
  })
  return yield* Client.make({
    ...acquirers,
    driver: 'baton-sqlite',
    compiler: Statement.makeCompilerSqlite(config.transformQueryNames),
    beginTransaction: config.readonly ? 'BEGIN' : 'BEGIN IMMEDIATE',
    releaseSavepoint: (name) => `RELEASE SAVEPOINT ${name}`,
    spanAttributes: [['db.system.name', 'sqlite']],
    transformRows: config.transformResultNames
      ? Statement.defaultTransforms(config.transformResultNames).array
      : undefined,
  })
})

export const layer = (config: SqliteClientConfig): Layer.Layer<Client.SqlClient, SqlError> =>
  Layer.effect(Client.SqlClient, make(config)).pipe(Layer.provide(Reactivity.layer))

export type SqliteClient = Client.SqlClient
