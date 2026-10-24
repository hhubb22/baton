import { Cause, Effect, Exit } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { spawnSync } from 'node:child_process'
import type * as P from '@baton/protocol'
import { createDatabaseRuntime, migrateDatabase } from '../database.ts'
import type { NodeSource } from '../errors.ts'

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
  readonly restart: () => Promise<TestDatabase['run']>
}

/** 每个夹具只迁移和清理自己的随机 schema。 */
export async function openTestDatabase(): Promise<TestDatabase> {
  const configured = process.env.BATON_TEST_DATABASE_URL?.trim()
  if (!configured) await (localPostgres ??= ensureLocalPostgres())
  const url = configured || defaultURL
  const schema = `t_ts_${randomUUID().replaceAll('-', '')}`
  const admin = createDatabaseRuntime({ url })
  let runtime = createDatabaseRuntime({ url, schema, maxConnections: 8 })
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
    return {
      get runtime() {
        return runtime
      },
      schema,
      url,
      run,
      close,
      restart: async () => {
        await runtime.dispose()
        runtime = createDatabaseRuntime({ url, schema, maxConnections: 8 })
        return run
      },
    }
  } catch (error) {
    await close()
    throw error
  }
}

export async function withTestDatabase<A>(test: (db: TestDatabase) => Promise<A>): Promise<A> {
  const db = await openTestDatabase()
  try {
    return await test(db)
  } finally {
    await db.close()
  }
}

export interface SeedNodeOverrides {
  readonly employeeId?: string
  readonly nodeId?: string
  readonly credentialId?: string
  readonly incarnation?: string
  readonly connId?: string
  readonly online?: boolean
  readonly synced?: boolean
  readonly report?: P.RuntimeReport
}

export async function seedNode(run: TestDatabase['run'], overrides: SeedNodeOverrides = {}) {
  const employeeId = overrides.employeeId ?? randomUUID()
  const nodeId = overrides.nodeId ?? randomUUID()
  const credentialId = overrides.credentialId ?? randomUUID()
  const source: NodeSource = {
    employee_id: employeeId,
    node_id: nodeId,
    credential_id: credentialId,
    incarnation: overrides.incarnation ?? 'inc',
    conn_id: overrides.connId ?? 'conn',
  }
  await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO employees(id,username,display_name,auth_source,external_subject,must_change_password,created_at,updated_at) VALUES(${employeeId},${'u' + employeeId.replaceAll('-', '')},'Employee','test',${employeeId},false,now(),now()) ON CONFLICT (id) DO NOTHING`
      yield* sql`INSERT INTO nodes(id,employee_id,display_name,system_name,capabilities,registration_seq,registered_at,credential_version) VALUES(${nodeId},${employeeId},'Device','linux',ARRAY[]::text[],nextval('node_registration_seq'),now(),1)`
      yield* sql`INSERT INTO node_credentials(id,node_id,employee_id,version,created_at,expires_at) VALUES(${credentialId},${nodeId},${employeeId},1,now(),now()+interval '1 day')`
      yield* sql`INSERT INTO node_presence(node_id,employee_id,online,synced,incarnation,conn_id,status_updated_at) VALUES(${nodeId},${employeeId},${overrides.online ?? true},${overrides.synced ?? true},${source.incarnation},${source.conn_id},now())`
      if (overrides.report)
        yield* sql`INSERT INTO node_runtime_reports(node_id,employee_id,report_version,reported_at,report) VALUES(${nodeId},${employeeId},1,now(),${JSON.stringify(overrides.report)}::jsonb)`
    }),
  )
  return { employeeId, nodeId, credentialId, source }
}
