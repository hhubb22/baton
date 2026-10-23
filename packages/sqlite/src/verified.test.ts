import { mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as SqlClient from 'effect/sql/SqlClient'
import { vi } from 'vitest'
import { CommitUnknown, layer, type CommitVerification } from './index.ts'

const writeSql = 'UPDATE meta SET commit_token = ?'
const readSql = 'SELECT commit_token FROM meta'
const verification: CommitVerification = {
  writeToken: (token) => ({ sql: writeSql, params: [token] }),
  readToken: { sql: readSql },
}

interface Fixture {
  readonly filename: string
  readonly writer: DatabaseSync
  readonly readers: DatabaseSync[]
  readonly tokens: string[]
  readonly commitError: Error
  commit: 'normal' | 'committed' | 'rolledBack' | 'active'
  readError?: Error
  closeError?: Error
  rollbackError?: Error
  onCommit?: () => void
  onRead?: (reader: DatabaseSync) => void
  commits: number
}

// Faults surround real native statements. The verifier must read a different
// DatabaseSync instance, and row assertions inspect real committed state.
const database = <A, E, R>(body: (fixture: Fixture) => Effect.Effect<A, E, R | SqlClient.SqlClient>, uri = false) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), 'baton-verified-'))),
    (directory) => {
      const filename = join(directory, 'ledger.db')
      return Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe('CREATE TABLE meta (commit_token TEXT NOT NULL)')
        yield* sql.unsafe("INSERT INTO meta VALUES ('')")
        yield* sql.unsafe('CREATE TABLE entries (id INTEGER)')
        const capturedWriters: DatabaseSync[] = []
        const prepare = DatabaseSync.prototype.prepare
        const capture = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
          this: DatabaseSync,
          query,
        ) {
          capturedWriters.push(this)
          return prepare.call(this, query)
        })
        yield* sql`SELECT 1`.pipe(Effect.ensuring(Effect.sync(() => capture.mockRestore())))
        const nativeWriter = capturedWriters[0]!
        const fixture: Fixture = {
          filename,
          writer: nativeWriter,
          readers: [],
          tokens: [],
          commitError: new Error('fixture COMMIT acknowledgement failure'),
          commit: 'normal',
          commits: 0,
        }
        const close = DatabaseSync.prototype.close
        const prepareSpy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
          this: DatabaseSync,
          query,
        ) {
          if (this !== nativeWriter && query === readSql) {
            fixture.readers.push(this)
            expect(nativeWriter.isTransaction).toBe(false)
            fixture.onRead?.(this)
            if (fixture.readError) throw fixture.readError
          }
          const statement = prepare.call(this, query)
          if (this === nativeWriter && query === 'ROLLBACK' && fixture.rollbackError) {
            const error = fixture.rollbackError
            delete fixture.rollbackError
            vi.spyOn(statement, 'run').mockImplementationOnce(() => {
              throw error
            })
          }
          if (this === nativeWriter && query === writeSql) {
            const run = statement.run.bind(statement)
            vi.spyOn(statement, 'run').mockImplementationOnce((...params) => {
              expect(nativeWriter.isTransaction).toBe(true)
              fixture.tokens.push(String(params[0]))
              return run(...params)
            })
          }
          if (this === nativeWriter && query === 'COMMIT') {
            const run = statement.run.bind(statement)
            vi.spyOn(statement, 'run').mockImplementationOnce((...params) => {
              fixture.commits++
              if (fixture.commit === 'rolledBack') nativeWriter.exec('ROLLBACK')
              if (fixture.commit === 'committed' || fixture.commit === 'normal') run(...params)
              fixture.onCommit?.()
              if (fixture.commit !== 'normal') throw fixture.commitError
              return { changes: 0, lastInsertRowid: 0 }
            })
          }
          return statement
        })
        const closeSpy = vi.spyOn(DatabaseSync.prototype, 'close').mockImplementation(function (this: DatabaseSync) {
          close.call(this)
          if (this !== nativeWriter && fixture.closeError) throw fixture.closeError
        })
        return yield* body(fixture).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              prepareSpy.mockRestore()
              closeSpy.mockRestore()
            }),
          ),
        )
      }).pipe(
        Effect.provide(
          layer({
            filename: uri ? `file:${filename}?mode=rwc` : filename,
            busyTimeoutMs: 123,
            commitVerification: verification,
          }),
        ),
      )
    },
    (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
  )

it.effect.each([false, true])(
  'preserves the original business result after real COMMIT succeeds but its acknowledgement is lost (URI: %s)',
  (uri) =>
    database(
      (fixture) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          fixture.commit = 'committed'
          fixture.onRead = (reader) => {
            expect(reader).not.toBe(fixture.writer)
            expect(reader.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal')
            expect(reader.prepare('PRAGMA busy_timeout').get()?.timeout).toBe(123)
            expect(() => reader.prepare('INSERT INTO entries VALUES (99)').run()).toThrow(/readonly/i)
          }
          const result = { command: 'one', payload: new Uint8Array([1, 2]) }
          let executions = 0
          let callbacks = 0
          const actual = yield* sql.withTransaction(
            Effect.gen(function* () {
              executions++
              yield* sql`INSERT INTO entries VALUES (1)`
              yield* sql.afterCommit(
                Effect.gen(function* () {
                  expect(fixture.readers[0]?.isOpen).toBe(false)
                  expect(yield* sql`SELECT * FROM entries`).toEqual([{ id: 1 }])
                  callbacks++
                }).pipe(Effect.orDie),
              )
              return result
            }),
          )
          expect(actual).toBe(result)
          expect(executions).toBe(1)
          expect(callbacks).toBe(1)
          expect(fixture.commits).toBe(1)
          expect(fixture.readers).toHaveLength(1)
          expect(fixture.readers[0]?.isOpen).toBe(false)
          expect(yield* sql`SELECT commit_token FROM meta`).toEqual([{ commit_token: fixture.tokens[0] }])
        }),
      uri,
    ),
)

it.effect('returns the original COMMIT error on a token mismatch, without replaying the body', () =>
  database((fixture) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      fixture.commit = 'rolledBack'
      let executions = 0
      let callbacks = 0
      const error = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            executions++
            yield* sql`INSERT INTO entries VALUES (1)`
            yield* sql.afterCommit(
              Effect.sync(() => {
                callbacks++
              }),
            )
            return 'business result'
          }),
        )
        .pipe(Effect.flip)
      expect(error.reason.cause).toBe(fixture.commitError)
      expect(error).not.toBeInstanceOf(CommitUnknown)
      expect(executions).toBe(1)
      expect(callbacks).toBe(0)
      expect(fixture.readers).toHaveLength(1)
      expect(fixture.readers[0]?.isOpen).toBe(false)
      expect(yield* sql`SELECT * FROM entries`).toEqual([])
      expect(yield* sql`SELECT * FROM meta`).toEqual([{ commit_token: '' }])
      fixture.commit = 'normal'
      expect(yield* sql.withTransaction(sql`INSERT INTO entries VALUES (2)`)).toEqual([])
      expect(new Set(fixture.tokens).size).toBe(2)
      expect(fixture.readers).toHaveLength(1)
    }),
  ),
)

it.effect('rolls back when a COMMIT error leaves the native transaction active, without reading a token', () =>
  database((fixture) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      fixture.commit = 'active'
      const error = yield* sql.withTransaction(sql`INSERT INTO entries VALUES (1)`).pipe(Effect.flip)
      expect(error.reason.cause).toBe(fixture.commitError)
      expect(fixture.writer.isTransaction).toBe(false)
      expect(fixture.readers).toHaveLength(0)
      expect(yield* sql`SELECT * FROM entries`).toEqual([])
      expect(yield* sql`SELECT * FROM meta`).toEqual([{ commit_token: '' }])
      fixture.commit = 'normal'
      yield* sql.withTransaction(sql`INSERT INTO entries VALUES (2)`)
      expect(yield* sql`SELECT * FROM entries`).toEqual([{ id: 2 }])
    }),
  ),
)

it.effect('requires successful rollback cleanup before reusing a connection after COMMIT and rollback both fail', () =>
  database((fixture) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      fixture.commit = 'active'
      fixture.rollbackError = new Error('fixture rollback did not end the transaction')
      let executions = 0
      const exit = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            executions++
            yield* sql`INSERT INTO entries VALUES (1)`
          }),
        )
        .pipe(Effect.exit)
      expect(exit._tag).toBe('Failure')
      expect(fixture.writer.isTransaction).toBe(true)
      expect(fixture.readers).toHaveLength(0)
      // Acquisition retries cleanup under the permit; it does not rerun business.
      expect(yield* sql`SELECT * FROM entries`).toEqual([])
      expect(fixture.writer.isTransaction).toBe(false)
      expect(yield* sql`SELECT * FROM meta`).toEqual([{ commit_token: '' }])
      expect(executions).toBe(1)
      fixture.commit = 'normal'
      yield* sql.withTransaction(sql`INSERT INTO entries VALUES (2)`)
      expect(yield* sql`SELECT * FROM entries`).toEqual([{ id: 2 }])
    }),
  ),
)

it.effect('rolls back an actual deferred constraint COMMIT failure without verification', () =>
  database((fixture) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe('CREATE TABLE parents (id INTEGER PRIMARY KEY)')
      yield* sql.unsafe('CREATE TABLE children (id INTEGER REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED)')
      const error = yield* sql.withTransaction(sql`INSERT INTO children VALUES (1)`).pipe(Effect.flip)
      expect(error.reason._tag).toBe('ConstraintError')
      expect(fixture.writer.isTransaction).toBe(false)
      expect(fixture.readers).toHaveLength(0)
      expect(yield* sql`SELECT * FROM children`).toEqual([])
      expect(yield* sql`SELECT * FROM meta`).toEqual([{ commit_token: '' }])
    }),
  ),
)

it.effect('reports a failed independent read as nonretryable CommitUnknown and blocks every later acquisition', () =>
  database((fixture) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      fixture.commit = 'committed'
      fixture.readError = new Error('fixture independent read failed')
      let callbacks = 0
      let executions = 0
      const error = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            executions++
            yield* sql`INSERT INTO entries VALUES (1)`
            yield* sql.afterCommit(
              Effect.sync(() => {
                callbacks++
              }),
            )
          }),
        )
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(CommitUnknown)
      const unknown = error as CommitUnknown
      expect(unknown.commitOutcome).toBe('unknown')
      expect(unknown.isRetryable).toBe(false)
      expect(unknown.commitError.reason.cause).toBe(fixture.commitError)
      expect(unknown.verificationCause).toBe(fixture.readError)
      expect(unknown.message).toContain('stop execution')
      expect(fixture.readers[0]?.isOpen).toBe(false)
      expect(callbacks).toBe(0)
      expect(executions).toBe(1)
      delete fixture.readError
      expect(yield* sql`SELECT * FROM entries`.pipe(Effect.flip)).toBe(error)
      expect(yield* Effect.scoped(sql.reserve).pipe(Effect.flip)).toBe(error)
      expect(
        yield* sql
          .withTransaction(
            Effect.sync(() => {
              executions++
            }),
          )
          .pipe(Effect.flip),
      ).toBe(error)
      expect(executions).toBe(1)
      expect(fixture.commits).toBe(1)
      const independent = new DatabaseSync(fixture.filename, { readOnly: true })
      try {
        expect(independent.prepare('SELECT * FROM entries').all()).toEqual([{ id: 1 }])
      } finally {
        independent.close()
      }
    }),
  ),
)

it.effect(
  'reports an independent open failure as CommitUnknown while closing the original database with its scope',
  () =>
    Effect.gen(function* () {
      let writer: DatabaseSync | undefined
      yield* database((fixture) =>
        Effect.gen(function* () {
          writer = fixture.writer
          const sql = yield* SqlClient.SqlClient
          fixture.commit = 'committed'
          fixture.onCommit = () => renameSync(fixture.filename, `${fixture.filename}.moved`)
          const error = yield* sql.withTransaction(sql`INSERT INTO entries VALUES (1)`).pipe(Effect.flip)
          expect(error).toBeInstanceOf(CommitUnknown)
          expect(fixture.readers).toHaveLength(0)
          expect(fixture.writer.isTransaction).toBe(false)
        }),
      )
      expect(writer?.isOpen).toBe(false)
    }),
)

it.effect('reports verifier finalization failure as CommitUnknown even when the token matches', () =>
  database((fixture) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      fixture.commit = 'committed'
      fixture.closeError = new Error('fixture verifier close failure')
      const error = yield* sql.withTransaction(sql`INSERT INTO entries VALUES (1)`).pipe(Effect.flip)
      expect(error).toBeInstanceOf(CommitUnknown)
      expect((error as CommitUnknown).verificationCause).toBe(fixture.closeError)
      expect(fixture.readers[0]?.isOpen).toBe(false)
      expect(yield* sql`SELECT 1`.pipe(Effect.flip)).toBe(error)
    }),
  ),
)

it.effect('rejects a missing token row as unknown, rather than claiming rollback', () =>
  database((fixture) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      fixture.commit = 'committed'
      fixture.onCommit = () => fixture.writer.exec('DELETE FROM meta')
      const error = yield* sql.withTransaction(sql`INSERT INTO entries VALUES (1)`).pipe(Effect.flip)
      expect(error).toBeInstanceOf(CommitUnknown)
      expect(fixture.readers[0]?.isOpen).toBe(false)
    }),
  ),
)

it.effect('does not COMMIT or verify when the token write fails before COMMIT', () =>
  database((fixture) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`DELETE FROM meta`
      const error = yield* sql.withTransaction(sql`INSERT INTO entries VALUES (1)`).pipe(Effect.flip)
      expect(error.reason.operation).toBe('commitToken')
      expect(error).not.toBeInstanceOf(CommitUnknown)
      expect(fixture.commits).toBe(0)
      expect(fixture.readers).toHaveLength(0)
      expect(fixture.writer.isTransaction).toBe(false)
      expect(yield* sql`SELECT * FROM entries`).toEqual([])
    }),
  ),
)

it.effect('does not verify when a failed token write makes SQLite roll back the transaction itself', () =>
  database((fixture) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(
        "CREATE TRIGGER reject_token BEFORE UPDATE ON meta BEGIN SELECT RAISE(ROLLBACK, 'token rejected'); END",
      )
      const error = yield* sql.withTransaction(sql`INSERT INTO entries VALUES (1)`).pipe(Effect.flip)
      expect(error.reason.operation).toBe('commitToken')
      expect(error).not.toBeInstanceOf(CommitUnknown)
      expect(fixture.writer.isTransaction).toBe(false)
      expect(fixture.commits).toBe(0)
      expect(fixture.readers).toHaveLength(0)
      expect(yield* sql`SELECT * FROM entries`).toEqual([])
      expect(yield* sql`SELECT * FROM meta`).toEqual([{ commit_token: '' }])
    }),
  ),
)

it.effect('rejects queued statements and transactions after unknown commit before executing their business', () =>
  database((fixture) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      fixture.commit = 'committed'
      fixture.readError = new Error('fixture verifier failure with queued waiters')
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const transaction = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO entries VALUES (1)`
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          }),
        )
        .pipe(Effect.flip, Effect.forkChild)
      yield* Deferred.await(entered)
      let executions = 0
      const statement = yield* sql`INSERT INTO entries VALUES (2)`.pipe(Effect.flip, Effect.forkChild)
      const queued = yield* sql
        .withTransaction(
          Effect.sync(() => {
            executions++
          }),
        )
        .pipe(Effect.flip, Effect.forkChild)
      yield* Effect.yieldNow
      expect(statement.pollUnsafe()).toBeUndefined()
      expect(queued.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      const error = yield* Fiber.join(transaction)
      expect(error).toBeInstanceOf(CommitUnknown)
      expect(yield* Fiber.join(statement)).toBe(error)
      expect(yield* Fiber.join(queued)).toBe(error)
      expect(executions).toBe(0)
      expect(fixture.readers[0]?.isOpen).toBe(false)
      const reader = new DatabaseSync(fixture.filename, { readOnly: true })
      try {
        expect(reader.prepare('SELECT * FROM entries').all()).toEqual([{ id: 1 }])
      } finally {
        reader.close()
      }
    }),
  ),
)

it.effect('keeps nested savepoint rollback and afterCommit behavior, writing only the outer token', () =>
  database((fixture) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      fixture.commit = 'committed'
      const callbacks: number[] = []
      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO entries VALUES (1)`
              yield* sql.afterCommit(
                Effect.sync(() => {
                  callbacks.push(1)
                }),
              )
            }),
          )
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO entries VALUES (2)`
                yield* sql.afterCommit(
                  Effect.sync(() => {
                    callbacks.push(2)
                  }),
                )
                return yield* Effect.fail('nested failed')
              }),
            )
            .pipe(Effect.catch(() => Effect.void))
          yield* sql`INSERT INTO entries VALUES (3)`
          return 42
        }),
      )
      expect(result).toBe(42)
      expect(callbacks).toEqual([1])
      expect(fixture.tokens).toHaveLength(1)
      expect(fixture.commits).toBe(1)
      expect(fixture.readers).toHaveLength(1)
      expect(yield* sql`SELECT * FROM entries ORDER BY id`).toEqual([{ id: 1 }, { id: 3 }])
      const failure = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql.withTransaction(sql`INSERT INTO entries VALUES (4)`)
            return yield* Effect.fail('outer failed')
          }),
        )
        .pipe(Effect.flip)
      expect(failure).toBe('outer failed')
      expect(fixture.tokens).toHaveLength(1)
      expect(yield* sql`SELECT * FROM entries ORDER BY id`).toEqual([{ id: 1 }, { id: 3 }])
    }),
  ),
)

it.live.each(['interrupt', 'timeout'] as const)(
  'cancels a verified transaction waiting for a permit via %s',
  (cancel) =>
    database((fixture) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const holder = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
            }),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        yield* Effect.gen(function* () {
          let executions = 0
          const started = yield* Deferred.make<void>()
          const transaction = sql.withTransaction(
            Effect.sync(() => {
              executions++
            }),
          )
          const waiter = yield* Deferred.succeed(started, undefined).pipe(
            Effect.andThen(cancel === 'timeout' ? transaction.pipe(Effect.timeout('10 millis')) : transaction),
            Effect.forkChild,
          )
          yield* Deferred.await(started)
          yield* Effect.yieldNow
          if (cancel === 'interrupt') yield* Fiber.interrupt(waiter).pipe(Effect.timeout('1 second'))
          expect((yield* Fiber.await(waiter).pipe(Effect.timeout('1 second')))._tag).toBe('Failure')
          expect(holder.pollUnsafe()).toBeUndefined()
          expect(executions).toBe(0)
          expect(fixture.tokens).toHaveLength(0)
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
        yield* Fiber.join(holder)
        expect(yield* sql.withTransaction(sql`SELECT 1 AS n`)).toEqual([{ n: 1 }])
        expect(fixture.tokens).toHaveLength(2)
      }),
    ),
)

it.effect('rolls back cancellation in the business body before writing any token', () =>
  database((fixture) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const entered = yield* Deferred.make<void>()
      const transaction = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO entries VALUES (1)`
            yield* Deferred.succeed(entered, undefined)
            yield* Effect.never
          }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(transaction)
      expect(fixture.tokens).toHaveLength(0)
      expect(fixture.commits).toBe(0)
      expect(fixture.readers).toHaveLength(0)
      expect(fixture.writer.isTransaction).toBe(false)
      expect(yield* sql`SELECT * FROM entries`).toEqual([])
    }),
  ),
)

it.effect.each(['normal', 'committed', 'rolledBack'] as const)(
  'settles native commit and cleanup when cancellation races with %s COMMIT, without executing business twice',
  (commit) =>
    database((fixture) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        fixture.commit = commit
        let executions = 0
        let callbacks = 0
        const transaction = yield* sql
          .withTransaction(
            Effect.withFiber((fiber) =>
              Effect.gen(function* () {
                fixture.onCommit = () => fiber.interruptUnsafe()
                executions++
                yield* sql`INSERT INTO entries VALUES (1)`
                yield* sql.afterCommit(
                  Effect.sync(() => {
                    callbacks++
                  }),
                )
                return { business: 'result' }
              }),
            ),
          )
          .pipe(Effect.forkChild)
        expect((yield* Fiber.await(transaction))._tag).toBe('Failure')
        expect(executions).toBe(1)
        expect(fixture.commits).toBe(1)
        expect(fixture.writer.isTransaction).toBe(false)
        expect(fixture.readers).toHaveLength(commit === 'normal' ? 0 : 1)
        for (const reader of fixture.readers) expect(reader.isOpen).toBe(false)
        expect(callbacks).toBe(commit === 'rolledBack' ? 0 : 1)
        expect(yield* sql`SELECT * FROM entries`).toEqual(commit === 'rolledBack' ? [] : [{ id: 1 }])
        fixture.commit = 'normal'
        delete fixture.onCommit
        expect(yield* sql.withTransaction(sql`SELECT 1 AS n`)).toEqual([{ n: 1 }])
        expect(executions).toBe(1)
      }),
    ),
)

it.effect(
  'completes verification and poisons the client when cancellation races with an independent read failure',
  () =>
    database((fixture) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        fixture.commit = 'committed'
        fixture.readError = new Error('fixture read failed during interruption')
        const transaction = yield* sql
          .withTransaction(
            Effect.withFiber((fiber) =>
              Effect.gen(function* () {
                fixture.onRead = () => fiber.interruptUnsafe()
                yield* sql`INSERT INTO entries VALUES (1)`
              }),
            ),
          )
          .pipe(Effect.forkChild)
        expect((yield* Fiber.await(transaction))._tag).toBe('Failure')
        expect(fixture.readers[0]?.isOpen).toBe(false)
        const error = yield* sql`SELECT 1`.pipe(Effect.flip)
        expect(error).toBeInstanceOf(CommitUnknown)
        expect((error as CommitUnknown).verificationCause).toBe(fixture.readError)
      }),
    ),
)

it.effect.each([
  { filename: ':memory:' },
  { filename: '' },
  { filename: 'file::memory:?cache=shared' },
  { filename: 'unused.db', readonly: true },
])('rejects verification on unsupported database configuration %j', (config) =>
  Effect.gen(function* () {
    const error = yield* SqlClient.SqlClient.pipe(
      Effect.provide(layer({ ...config, commitVerification: verification })),
      Effect.flip,
    )
    expect(error.reason.operation).toBe('configure')
    expect(String(error.reason.cause)).toContain('writable file database')
  }),
)
