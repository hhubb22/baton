import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Cause, Effect, Exit } from 'effect'
import { afterEach, expect, it } from 'vite-plus/test'
import { makeNodeLedger } from './daemon/ledger.ts'
import { makeProjectLedger } from './project/ledger.ts'
import { openWorkerLedger } from './worker/ledger.ts'
import { LEDGER_VERSIONS } from '@baton/protocol/release'
import * as Sqlite from '@baton/sqlite'
import * as Reactivity from 'effect/reactivity/Reactivity'
import { applyStorageMigrations, initializeStorage } from './storage-format.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const stores = [
  { kind: 'node', open: (filename: string) => makeNodeLedger(filename).pipe(Effect.asVoid) },
  { kind: 'project', open: (filename: string) => makeProjectLedger(filename).pipe(Effect.asVoid) },
  { kind: 'thread', open: (filename: string) => openWorkerLedger({ dbPath: filename }).pipe(Effect.asVoid) },
] as const
const run = async <A, E>(effect: Effect.Effect<A, E>) => {
  const result = await Effect.runPromiseExit(effect)
  if (Exit.isFailure(result)) throw Cause.squash(result.cause)
  return result.value
}
function edit(filename: string, sql: string) {
  const db = new DatabaseSync(filename)
  try {
    db.exec(sql)
  } finally {
    db.close()
  }
}
function metadata(filename: string) {
  const db = new DatabaseSync(filename, { readOnly: true })
  try {
    return {
      format: db.prepare('SELECT * FROM storage_format').all(),
      migrations: db.prepare('SELECT * FROM storage_migrations').all(),
    }
  } finally {
    db.close()
  }
}

it.each(stores)('$kind baseline is durable and repeated opens do not reapply it', async ({ kind, open }) => {
  const root = await mkdtemp(join(tmpdir(), 'baton-format-'))
  roots.push(root)
  const filename = join(root, 'ledger.db')
  await run(Effect.scoped(open(filename)))
  const saved = metadata(filename)
  expect(saved.format).toEqual([{ id: 1, kind, version: LEDGER_VERSIONS[kind] }])
  expect(saved.migrations).toEqual([
    {
      id: '0001_baseline',
      checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      applied_at: expect.any(String),
    },
  ])
  await run(Effect.scoped(open(filename)))
  await run(Effect.scoped(open(filename)))
  expect(metadata(filename)).toEqual(saved)
})

for (const mutation of [
  { sql: 'UPDATE storage_format SET version=999', code: 'storage_version_unsupported' },
  { sql: "UPDATE storage_format SET kind='unknown'", code: 'storage_version_unsupported' },
  { sql: 'DELETE FROM storage_migrations', code: 'storage_version_unsupported' },
  { sql: 'DROP TABLE storage_format', code: 'storage_version_unsupported' },
  { sql: "UPDATE storage_migrations SET checksum='tampered'", code: 'migration_checksum_mismatch' },
]) {
  it.each(stores)(`$kind refuses ${mutation.sql} before writing`, async ({ open }) => {
    const root = await mkdtemp(join(tmpdir(), 'baton-format-'))
    roots.push(root)
    const filename = join(root, 'ledger.db')
    await run(Effect.scoped(open(filename)))
    edit(filename, mutation.sql)
    const before = await readFile(filename)
    await expect(run(Effect.scoped(open(filename)))).rejects.toMatchObject({ code: mutation.code })
    expect(await readFile(filename)).toEqual(before)
  })
}

it.each(stores)('$kind rejects unversioned experimental databases without adopting them', async ({ open }) => {
  const root = await mkdtemp(join(tmpdir(), 'baton-format-'))
  roots.push(root)
  const filename = join(root, 'ledger.db')
  edit(filename, "CREATE TABLE old_data(payload TEXT); INSERT INTO old_data VALUES('keep')")
  const before = await readFile(filename)
  await expect(run(Effect.scoped(open(filename)))).rejects.toMatchObject({ code: 'storage_version_unsupported' })
  expect(await readFile(filename)).toEqual(before)
})

it('resumes ordered migrations after a later transaction fails without changing committed history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'baton-format-migrate-'))
  roots.push(root)
  const filename = join(root, 'ledger.db')
  const baseline = ['CREATE TABLE data (id INTEGER PRIMARY KEY)', 'CREATE TABLE guard (id INTEGER)']
  const catalog = {
    node: [
      { id: '0002_add_value', from: 2, to: 3, statements: ['ALTER TABLE data ADD COLUMN value TEXT'] },
      { id: '0003_add_guard', from: 3, to: 4, statements: ['INSERT INTO guard VALUES (1)'] },
    ],
  }
  const withSql = <A, E>(use: (sql: Sqlite.SqliteClient) => Effect.Effect<A, E>) =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* Sqlite.make({ filename }).pipe(Effect.provide(Reactivity.layer))
          return yield* use(sql)
        }),
      ),
    )
  await withSql((sql) => initializeStorage(sql, 'node', baseline))
  edit(filename, "CREATE TRIGGER reject_guard BEFORE INSERT ON guard BEGIN SELECT RAISE(ABORT, 'interrupted'); END")
  await expect(
    withSql((sql) => applyStorageMigrations(sql, 'node', baseline, { catalog, targetVersion: 4 })),
  ).rejects.toBeDefined()
  const intermediate = metadata(filename)
  expect(intermediate.format[0]).toMatchObject({ version: 3 })
  expect(intermediate.migrations.map((row) => row.id)).toEqual(['0001_baseline', '0002_add_value'])
  edit(filename, 'DROP TRIGGER reject_guard')
  await withSql((sql) => applyStorageMigrations(sql, 'node', baseline, { catalog, targetVersion: 4 }))
  const completed = metadata(filename)
  expect(completed.format[0]).toMatchObject({ version: 4 })
  expect(completed.migrations.slice(0, 2)).toEqual(intermediate.migrations)
  expect(completed.migrations.map((row) => row.id)).toEqual(['0001_baseline', '0002_add_value', '0003_add_guard'])
  await withSql((sql) => applyStorageMigrations(sql, 'node', baseline, { catalog, targetVersion: 4 }))
  expect(metadata(filename)).toEqual(completed)
})
