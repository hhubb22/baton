import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Deferred from 'effect/Deferred'
import * as Stream from 'effect/Stream'
import * as SqlClient from 'effect/sql/SqlClient'
import { layer } from './index.ts'

const database = <A, E, R>(body: Effect.Effect<A, E, R | SqlClient.SqlClient>, filename?: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), 'baton-sqlite-'))),
    (directory) => body.pipe(Effect.provide(layer({ filename: filename ?? join(directory, 'ledger.db') }))),
    (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
  )

it.effect('uses WAL, FULL and foreign keys for file databases', () =>
  database(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      expect(yield* sql.unsafe('PRAGMA journal_mode')).toEqual([{ journal_mode: 'wal' }])
      expect(yield* sql.unsafe('PRAGMA synchronous')).toEqual([{ synchronous: 2 }])
      expect(yield* sql.unsafe('PRAGMA foreign_keys')).toEqual([{ foreign_keys: 1 }])
    }),
  ),
)

it.effect('commits rows and closes the database before reopening it', () =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), 'baton-sqlite-'))),
    (directory) =>
      Effect.gen(function* () {
        const filename = join(directory, 'ledger.db')
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql.unsafe('CREATE TABLE intents (id TEXT PRIMARY KEY, body TEXT NOT NULL)')
          yield* sql.withTransaction(sql`INSERT INTO intents VALUES (${'one'}, ${'durable'})`)
        }).pipe(Effect.provide(layer({ filename })))
        const reopened = new DatabaseSync(filename)
        try {
          expect(reopened.prepare('SELECT * FROM intents').all()).toEqual([{ id: 'one', body: 'durable' }])
        } finally {
          reopened.close()
        }
      }),
    (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
  ),
)

it.effect('rolls back failed transactions and nested savepoints', () =>
  database(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe('CREATE TABLE entries (id INTEGER PRIMARY KEY)')
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO entries VALUES (1)`
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO entries VALUES (2)`
                return yield* Effect.fail('cancel nested')
              }),
            )
            .pipe(Effect.catch(() => Effect.void))
          yield* sql`INSERT INTO entries VALUES (3)`
        }),
      )
      expect(yield* sql`SELECT id FROM entries ORDER BY id`).toEqual([{ id: 1 }, { id: 3 }])
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO entries VALUES (4)`
            return yield* Effect.fail('cancel outer')
          }),
        )
        .pipe(Effect.catch(() => Effect.void))
      expect(yield* sql`SELECT count(*) AS n FROM entries`).toEqual([{ n: 2 }])
    }),
  ),
)

it.effect('isolates concurrent statements and releases an interrupted transaction permit', () =>
  database(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe('CREATE TABLE entries (id INTEGER PRIMARY KEY)')
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
      const pending = yield* sql`INSERT INTO entries VALUES (2)`.pipe(Effect.forkChild)
      yield* Fiber.interrupt(transaction)
      yield* Fiber.join(pending)
      expect(yield* sql`SELECT * FROM entries`).toEqual([{ id: 2 }])
    }),
  ),
)

it.live.each(['interrupt', 'timeout'] as const)(
  'cancels a waiting transaction via %s before the holder releases its permit',
  (cancel) =>
    database(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const held = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const holder = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* Deferred.succeed(held, undefined)
              yield* Deferred.await(release)
            }),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(held)
        yield* Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const cancelled = yield* Deferred.make<void>()
          let bodyRan = false
          const transaction = sql.withTransaction(
            Effect.sync(() => {
              bodyRan = true
            }),
          )
          const waiter = yield* Deferred.succeed(started, undefined).pipe(
            Effect.andThen(cancel === 'timeout' ? transaction.pipe(Effect.timeout('10 millis')) : transaction),
            Effect.onExit(() => Deferred.succeed(cancelled, undefined)),
            Effect.forkChild,
          )
          yield* Deferred.await(started)
          yield* Effect.yieldNow
          if (cancel === 'interrupt') yield* Fiber.interrupt(waiter).pipe(Effect.forkChild)
          yield* Deferred.await(cancelled).pipe(Effect.timeout('1 second'))
          const exit = yield* Fiber.await(waiter).pipe(Effect.timeout('1 second'))
          expect(exit._tag).toBe('Failure')
          expect(holder.pollUnsafe()).toBeUndefined()
          expect(bodyRan).toBe(false)
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
        yield* Fiber.join(holder)
        expect(yield* sql.withTransaction(sql`SELECT 1 AS n`)).toEqual([{ n: 1 }])
      }),
      ':memory:',
    ),
)

it.effect('supports array, stream, raw, bigint and blob results', () =>
  database(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe('CREATE TABLE entries (id INTEGER PRIMARY KEY, bytes BLOB)')
      const bytes = new Uint8Array([0, 255, 4])
      expect(yield* sql`INSERT INTO entries VALUES (1, ${bytes})`.raw).toMatchObject({ changes: 1 })
      expect(yield* sql`SELECT id FROM entries`.values).toEqual([[1]])
      expect(yield* Stream.runCollect(sql`SELECT id FROM entries`.stream)).toEqual([{ id: 1 }])
      expect(
        yield* sql`SELECT 9007199254740993 AS n`.pipe(Effect.provideService(SqlClient.SafeIntegers, true)),
      ).toEqual([{ n: 9007199254740993n }])
      const result = yield* sql<{ bytes: Uint8Array }>`SELECT bytes FROM entries`
      expect(result[0]?.bytes).toEqual(bytes)
    }),
  ),
)

it.effect('returns typed unique violations and remains usable after SQL errors', () =>
  database(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe('CREATE TABLE entries (id INTEGER UNIQUE)')
      yield* sql`INSERT INTO entries VALUES (1)`
      const failure = yield* sql`INSERT INTO entries VALUES (1)`.pipe(Effect.flip)
      expect(failure._tag).toBe('SqlError')
      expect(failure.reason._tag).toBe('UniqueViolation')
      expect(yield* sql`SELECT count(*) AS n FROM entries`).toEqual([{ n: 1 }])
    }),
  ),
)

it.effect('supports in-memory databases', () =>
  database(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      expect(yield* sql`SELECT 1 AS n`).toEqual([{ n: 1 }])
    }),
    ':memory:',
  ),
)

it.effect('rolls back a failed COMMIT before reusing the connection', () =>
  database(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe('CREATE TABLE parents (id INTEGER PRIMARY KEY)')
      yield* sql.unsafe(
        'CREATE TABLE children (parent_id INTEGER REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED)',
      )
      const error = yield* sql.withTransaction(sql`INSERT INTO children VALUES (1)`).pipe(Effect.flip)
      expect(error.reason._tag).toBe('ConstraintError')
      expect(yield* sql`SELECT * FROM children`).toEqual([])
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO parents VALUES (1)`
          yield* sql`INSERT INTO children VALUES (1)`
        }),
      )
      expect(yield* sql`SELECT * FROM children`).toEqual([{ parent_id: 1 }])
    }),
  ),
)

it.effect('opens an existing ledger in readonly mode', () =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), 'baton-sqlite-'))),
    (directory) =>
      Effect.gen(function* () {
        const filename = join(directory, 'ledger.db')
        const writer = new DatabaseSync(filename)
        writer.exec('PRAGMA journal_mode=WAL; CREATE TABLE entries (id INTEGER); INSERT INTO entries VALUES (1)')
        writer.close()
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          expect(yield* sql.withTransaction(sql`SELECT * FROM entries`)).toEqual([{ id: 1 }])
          const error = yield* sql`INSERT INTO entries VALUES (2)`.pipe(Effect.flip)
          expect(error._tag).toBe('SqlError')
          expect(yield* sql`SELECT * FROM entries`).toEqual([{ id: 1 }])
        }).pipe(Effect.provide(layer({ filename, readonly: true })))
      }),
    (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
  ),
)
