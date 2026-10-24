import { Cause, Effect, Exit } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { spawnSync } from 'node:child_process'
import { createDatabaseRuntime, migrateDatabase } from './database.ts'

const defaultURL = 'postgres://postgres:baton@127.0.0.1:5432/baton_test?sslmode=disable'
let localPostgres: Promise<void> | undefined

async function ensureLocalPostgres(): Promise<void> {
  const listening = await new Promise<boolean>((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: 5432 })
    socket.setTimeout(300)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
  })
  if (listening) return
  const dataDir = join(homedir(), '.baton-postgres')
  try {
    await access(dataDir)
  } catch {
    return
  }
  for (const bin of [
    'pg_ctl',
    '/opt/homebrew/opt/postgresql@17/bin/pg_ctl',
    '/usr/local/opt/postgresql@17/bin/pg_ctl',
  ]) {
    const result = spawnSync(bin, ['-D', dataDir, '-l', join(dataDir, 'postgres.log'), 'start'], {
      timeout: 30000,
      stdio: 'ignore',
    })
    if (!result.error) return
  }
}

export interface TestDatabase {
  readonly runtime: ReturnType<typeof createDatabaseRuntime>
  readonly schema: string
  readonly url: string
  readonly run: <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => Promise<A>
  readonly close: () => Promise<void>
  readonly dispose: () => Promise<void>
}

/** 每个夹具只迁移和清理自己的随机 schema。 */
export async function openTestDatabase(): Promise<TestDatabase> {
  const configured = process.env.BATON_TEST_DATABASE_URL?.trim()
  if (!configured) await (localPostgres ??= ensureLocalPostgres())
  const url = configured || defaultURL
  const schema = `t_ts_${randomUUID().replaceAll('-', '')}`
  const admin = createDatabaseRuntime({ url })
  const runtime = createDatabaseRuntime({ url, schema, maxConnections: 8 })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try {
      await runtime.dispose()
      await admin.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`
        }),
      )
    } finally {
      await admin.dispose()
    }
  }
  const run: TestDatabase['run'] = async (effect) => {
    const result = await runtime.runPromiseExit(effect)
    if (Exit.isFailure(result)) throw Cause.squash(result.cause)
    return result.value
  }
  try {
    await admin.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE SCHEMA ${sql(schema)}`
      }),
    )
    await run(migrateDatabase())
    return { runtime, schema, url, run, close, dispose: close }
  } catch (error) {
    await close()
    throw error
  }
}

export const createTestDatabase = openTestDatabase
