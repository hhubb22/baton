import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'
import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabaseRuntime, migrateDatabase } from './database.ts'
import * as Auth from './auth.ts'
import * as Nodes from './nodes.ts'
import type { NodeSource } from './errors.ts'
import { openTestDatabase, type TestDatabase } from './testing/database.ts'

let database: TestDatabase
let schema: string
let alice: Auth.Employee, bob: Auth.Employee
const signer = Nodes.CredentialSigner.generate()
const password = 'local-initial-password-123'

const run: TestDatabase['run'] = (effect) => database.run(effect)
const query = <A extends object>(text: string, params: readonly unknown[] = []) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.unsafe<A>(text, params)
  })

async function register(employee: Auth.Employee, displayName = 'Test workstation'): Promise<Nodes.NodeIdentity> {
  const enrollment = await run(Nodes.issueEnrollment(employee.id))
  return run(
    Nodes.registerNode(
      {
        enrollment_token: enrollment.enrollment_token as string,
        display_name: displayName,
        system: 'macos',
        capabilities: [],
      },
      signer,
    ),
  )
}
function source(identity: Nodes.NodeIdentity, incarnation = randomUUID()): NodeSource {
  return {
    employee_id: identity.employee_id,
    node_id: identity.node_id,
    credential_id: identity.credential.id,
    incarnation,
    conn_id: randomUUID(),
  }
}
const syncInput = { display_name: 'Synced workstation', system: 'macos', capabilities: ['cursor'] }
const report = { agents: [], exec: { enabled: false, shell: '/bin/sh' }, roots: [], repos: [], user: 'local-user' }

beforeAll(async () => {
  database = await openTestDatabase()
  schema = database.schema
  alice = await run(Auth.createEmployee('alice', 'Alice', password))
  bob = await run(Auth.createEmployee('bob', 'Bob', password))
}, 30000)

afterAll(async () => {
  await database?.close()
}, 20000)

describe('identity storage on local PostgreSQL', () => {
  it('applies migrations in order, records versions, skips applied scripts and rolls back failures inside the selected schema', async () => {
    await Promise.all([run(migrateDatabase()), run(migrateDatabase())])
    const rows = await run(query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version'))
    expect(rows.map((row) => row.version)).toEqual([
      '0001_initial.sql',
      '0002_ts_threads.sql',
      '0003_thread_tracing.sql',
      '0004_inbox_options.sql',
      '0005_thread_settings.sql',
      '0006_thread_answers.sql',
    ])
    const names = await run(query<{ current: string }>('SELECT current_schema() AS current'))
    expect(names[0].current).toBe(schema)
    const columns = await run(
      query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
      WHERE table_schema=$1 AND table_name='thread_outbox' AND column_name IN ('completed_at','completion','trace_context') ORDER BY column_name`,
        [schema],
      ),
    )
    expect(columns.map((row) => row.column_name)).toEqual(['completed_at', 'completion', 'trace_context'])
    const directory = await mkdtemp(join(tmpdir(), 'baton-migrations-'))
    try {
      const initial = await readFile(new URL('../../../migrations/0001_initial.sql', import.meta.url), 'utf8')
      const completion = await readFile(new URL('../../../migrations/0002_ts_threads.sql', import.meta.url), 'utf8')
      await writeFile(join(directory, '0001_initial.sql'), initial)
      await writeFile(join(directory, '0002_ts_threads.sql'), completion)
      const tracing = await readFile(new URL('../../../migrations/0003_thread_tracing.sql', import.meta.url), 'utf8')
      await writeFile(join(directory, '0003_thread_tracing.sql'), tracing)
      const inboxOptions = await readFile(
        new URL('../../../migrations/0004_inbox_options.sql', import.meta.url),
        'utf8',
      )
      await writeFile(join(directory, '0004_inbox_options.sql'), inboxOptions)
      const threadSettings = await readFile(
        new URL('../../../migrations/0005_thread_settings.sql', import.meta.url),
        'utf8',
      )
      await writeFile(join(directory, '0005_thread_settings.sql'), threadSettings)
      const threadAnswers = await readFile(
        new URL('../../../migrations/0006_thread_answers.sql', import.meta.url),
        'utf8',
      )
      await writeFile(join(directory, '0006_thread_answers.sql'), threadAnswers)
      await writeFile(
        join(directory, '0007_ordered.sql'),
        "CREATE TABLE migration_order (position integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, step text NOT NULL); INSERT INTO migration_order(step) VALUES ('first');",
      )
      await writeFile(join(directory, '0008_ordered.sql'), "INSERT INTO migration_order(step) VALUES ('second');")
      await run(migrateDatabase(directory))
      const versions = await run(
        query<{ version: string; applied_at: string }>(
          'SELECT version, applied_at::text FROM schema_migrations ORDER BY version',
        ),
      )
      expect(versions.map((row) => row.version)).toEqual([
        ...rows.map((row) => row.version),
        '0007_ordered.sql',
        '0008_ordered.sql',
      ])
      await Promise.all([run(migrateDatabase(directory)), run(migrateDatabase(directory))])
      expect(await run(query('SELECT step FROM migration_order ORDER BY position'))).toEqual([
        { step: 'first' },
        { step: 'second' },
      ])
      expect(await run(query('SELECT version, applied_at::text FROM schema_migrations ORDER BY version'))).toEqual(
        versions,
      )
      await writeFile(join(directory, '0009_rollback.sql'), 'CREATE TABLE migration_rollback (id int); SELECT 1/0;')
      await expect(run(migrateDatabase(directory))).rejects.toMatchObject({ code: 'unavailable' })
      const rolledBack = await run(
        query<{ exists: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM information_schema.tables
        WHERE table_schema=$1 AND table_name='migration_rollback') AS exists`,
          [schema],
        ),
      )
      expect(rolledBack[0].exists).toBe(false)
      expect(
        await run(query('SELECT version FROM schema_migrations WHERE version=$1', ['0009_rollback.sql'])),
      ).toHaveLength(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('stores Argon2id and session hashes, preserves CSRF through runtime restart, and isolates sessions', async () => {
    await expect(run(Auth.login('missing', password))).rejects.toMatchObject({ code: 'invalid_credentials' })
    await expect(run(Auth.login('alice', `${password}-wrong`))).rejects.toMatchObject({ code: 'invalid_credentials' })
    const first = await run(Auth.login('alice', password)),
      second = await run(Auth.login('bob', password))
    const session = await run(Auth.lookupSession(first.token))
    expect(session.employee.id).toBe(alice.id)
    expect((await run(Auth.lookupSession(second.token))).employee.id).toBe(bob.id)
    expect(Auth.checkCSRF(session, second.csrf_token)).toBe(false)
    expect(Auth.checkCSRF(session, first.csrf_token)).toBe(true)
    expect(first.csrf_token).not.toBe(first.token)
    const saved = await run(
      query<{ password_hash: string; token_hash: Uint8Array; csrf_hash: Uint8Array }>(
        `
      SELECT e.password_hash,s.token_hash,s.csrf_hash FROM employees e JOIN login_sessions s ON s.employee_id=e.id
      WHERE s.id=$1::uuid`,
        [session.id],
      ),
    )
    expect(saved[0].password_hash).toMatch(/^\$argon2id\$v=19\$/)
    expect(Buffer.from(saved[0].token_hash)).toEqual(Auth.digest(first.token))
    expect(Buffer.from(saved[0].csrf_hash)).toEqual(Auth.digest(first.csrf_token))
    const restarted = createDatabaseRuntime({ url: database.url, schema })
    try {
      const recovered = await restarted.runPromise(Auth.lookupSession(first.token))
      expect(recovered.csrf_token).toBe(first.csrf_token)
      expect(recovered.expires_at).toBe(first.expires_at)
    } finally {
      await restarted.dispose()
    }
    expect(Auth.sessionCookie(first.token, first.expires_at)).toMatch(/Secure; HttpOnly; SameSite=Strict/)
    await run(Auth.logout(first.token))
    await expect(run(Auth.lookupSession(first.token))).rejects.toMatchObject({ code: 'unauthenticated' })
    expect((await run(Auth.lookupSession(second.token))).employee.id).toBe(bob.id)
    await run(
      query("UPDATE login_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [
        Auth.digest(second.token),
      ]),
    )
    await expect(run(Auth.lookupSession(second.token))).rejects.toMatchObject({ code: 'session_expired' })
  })

  it('password change and reset invalidate every old session and password', async () => {
    const employee = await run(Auth.createEmployee('passwords', 'Password account', password))
    const first = await run(Auth.login(employee.username, password)),
      second = await run(Auth.login(employee.username, password))
    await expect(
      run(Auth.changePassword(employee.id, 'wrong-current-password', 'replacement-password-123')),
    ).rejects.toMatchObject({ code: 'invalid_credentials' })
    await expect(run(Auth.changePassword(employee.id, password, password))).rejects.toMatchObject({
      code: 'password_reused',
    })
    for (const invalid of ['short', ' leading-password-123', 'control\npassword-123', 'x'.repeat(129)]) {
      await expect(run(Auth.changePassword(employee.id, password, invalid))).rejects.toMatchObject({
        code: 'invalid_password',
      })
    }
    expect((await run(Auth.lookupSession(first.token))).employee.must_change_password).toBe(true)
    const changed = await run(Auth.changePassword(employee.id, password, 'replacement-password-123'))
    expect(changed.must_change_password).toBe(false)
    for (const token of [first.token, second.token])
      await expect(run(Auth.lookupSession(token))).rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(run(Auth.login(employee.username, password))).rejects.toMatchObject({ code: 'invalid_credentials' })
    const fresh = await run(Auth.login(employee.username, 'replacement-password-123'))
    const reset = await run(Auth.resetPassword(employee.username))
    expect(reset.employee.must_change_password).toBe(true)
    await expect(run(Auth.lookupSession(fresh.token))).rejects.toMatchObject({ code: 'unauthenticated' })
    expect((await run(Auth.login(employee.username, reset.password))).employee.id).toBe(employee.id)
  })

  it('consumes enrollment once under concurrent registration and isolates employee objects and defaults', async () => {
    const enrollment = await run(Nodes.issueEnrollment(alice.id))
    const id = enrollment.enrollment_id as string
    await expect(run(Nodes.getEnrollment(bob.id, id))).rejects.toMatchObject({ status: 404 })
    const input = {
      enrollment_token: enrollment.enrollment_token as string,
      display_name: 'Concurrent registration',
      system: 'macos',
      capabilities: [],
    }
    const attempts = await Promise.allSettled(Array.from({ length: 6 }, () => run(Nodes.registerNode(input, signer))))
    const succeeded = attempts.filter((result) => result.status === 'fulfilled')
    expect(succeeded).toHaveLength(1)
    for (const attempt of attempts)
      if (attempt.status === 'rejected') expect(attempt.reason).toMatchObject({ code: 'enrollment_used' })
    const identity = (succeeded[0] as PromiseFulfilledResult<Nodes.NodeIdentity>).value
    const claims = await run(Nodes.authenticateNode(identity.credential.token, signer))
    expect(claims.employee_id).toBe(alice.id)
    expect(identity.signing_public_key).toBe(signer.signingPublicKey)
    await expect(
      run(Nodes.authenticateNode(identity.credential.token, Nodes.CredentialSigner.generate())),
    ).rejects.toMatchObject({ code: 'invalid_node_credential' })
    const other = await register(bob)
    await expect(run(Nodes.getNode(bob.id, identity.node_id))).rejects.toMatchObject({ status: 403 })
    await expect(run(Nodes.revokeNode(bob.id, identity.node_id))).rejects.toMatchObject({ status: 403 })
    await expect(run(Nodes.setDefaultDevice(bob.id, identity.node_id))).rejects.toMatchObject({ status: 403 })
    const aliceNodes = await run(Nodes.listNodes(alice.id)),
      bobNodes = await run(Nodes.listNodes(bob.id))
    expect((aliceNodes.nodes as Array<{ id: string }>).some((node) => node.id === other.node_id)).toBe(false)
    expect((bobNodes.default_device as { node_id: string }).node_id).toBe(other.node_id)
    const originalDefault = (aliceNodes.default_device as { node_id: string }).node_id
    await register(alice, 'Later registration')
    expect(((await run(Nodes.listNodes(alice.id))).default_device as { node_id: string }).node_id).toBe(originalDefault)
    await run(Nodes.setDefaultDevice(alice.id, identity.node_id))
    const expired = await run(Nodes.issueEnrollment(alice.id))
    await run(
      query(
        "UPDATE node_enrollments SET created_at=now()-interval '2 seconds',expires_at=now()-interval '1 second' WHERE id=$1::uuid",
        [expired.enrollment_id],
      ),
    )
    await expect(
      run(Nodes.registerNode({ ...input, enrollment_token: expired.enrollment_token as string }, signer)),
    ).rejects.toMatchObject({ code: 'enrollment_expired' })
  })

  it('guards connection incarnation, sync readiness, late disconnects, report versions and revocation', async () => {
    const identity = await register(alice),
      current = source(identity)
    await run(Nodes.claimConnection(current))
    expect((await run(Nodes.getNode(alice.id, identity.node_id))).executable).toBe(false)
    await expect(run(Nodes.saveRuntimeReport(current, report))).rejects.toMatchObject({ code: 'node_source_rejected' })
    await expect(run(Nodes.claimConnection(source(identity)))).rejects.toMatchObject({ code: 'incarnation_conflict' })
    await run(Nodes.syncNode(current, syncInput))
    expect((await run(Nodes.getNode(alice.id, identity.node_id))).executable).toBe(true)
    expect(await run(Nodes.saveRuntimeReport(current, report))).toBe(1)
    expect(await run(Nodes.saveRuntimeReport(current, { ...report }))).toBe(1)
    expect(await run(Nodes.saveRuntimeReport(current, { ...report, user: 'changed-user' }))).toBe(2)
    await expect(run(Nodes.saveRuntimeReport(current, { ...report, exec: { enabled: 'yes' } }))).rejects.toMatchObject({
      code: 'invalid_runtime_report',
    })
    const replacement = { ...current, conn_id: randomUUID() }
    await run(Nodes.claimConnection(replacement))
    await run(Nodes.disconnectNode(current))
    expect((await run(Nodes.getNode(alice.id, identity.node_id))).online).toBe(true)
    expect((await run(Nodes.getNode(alice.id, identity.node_id))).synced).toBe(false)
    await expect(run(Nodes.saveRuntimeReport(current, report))).rejects.toMatchObject({ code: 'node_source_rejected' })
    await run(Nodes.syncNode(replacement, syncInput))
    await expect(run(Nodes.touchNode({ ...replacement, employee_id: bob.id }))).rejects.toMatchObject({
      code: 'node_source_rejected',
    })
    await run(Nodes.setDefaultDevice(alice.id, identity.node_id))
    expect((await run(Nodes.revokeNode(alice.id, identity.node_id))).status).toBe('pending')
    await expect(run(Nodes.authenticateNode(identity.credential.token, signer))).rejects.toMatchObject({
      code: 'invalid_node_credential',
    })
    await expect(run(Nodes.touchNode(replacement))).rejects.toMatchObject({ code: 'node_source_rejected' })
    await expect(run(Nodes.markRevocationApplied(alice.id, identity.node_id))).rejects.toMatchObject({
      code: 'revocation_pending',
    })
    await run(Nodes.disconnectNode(replacement))
    await run(Nodes.markRevocationApplied(alice.id, identity.node_id))
    expect((await run(Nodes.getRevocation(alice.id, identity.node_id))).status).toBe('effective')
    const defaults = (await run(Nodes.listNodes(alice.id))).default_device as { node_id: string; invalid: boolean }
    expect(defaults).toMatchObject({ node_id: identity.node_id, invalid: true })
    await register(alice, 'New after revocation')
    expect(((await run(Nodes.listNodes(alice.id))).default_device as { node_id: string }).node_id).toBe(
      identity.node_id,
    )
  })

  it('revalidates credential expiry after waiting for a business lock', async () => {
    const identity = await register(alice),
      current = source(identity)
    await run(Nodes.claimConnection(current))
    await run(Nodes.syncNode(current, syncInput))
    await run(
      query("UPDATE node_credentials SET expires_at=clock_timestamp()+interval '0.3 seconds' WHERE id=$1::uuid", [
        identity.credential.id,
      ]),
    )
    await run(query('CREATE TABLE expiry_business (id integer PRIMARY KEY, changed boolean NOT NULL)'))
    await run(query('INSERT INTO expiry_business VALUES (1,false)'))
    let release!: () => void, locked!: () => void
    const gate = new Promise<void>((resolve) => {
        release = resolve
      }),
      acquired = new Promise<void>((resolve) => {
        locked = resolve
      })
    const blocker = run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT id FROM expiry_business WHERE id=1 FOR UPDATE`
            locked()
            yield* Effect.promise(() => gate)
          }),
        )
      }),
    )
    await acquired
    const waiting = run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* Nodes.lockNodeSource(current)
            yield* sql`SELECT id FROM expiry_business WHERE id=1 FOR UPDATE`
            yield* Nodes.revalidateNodeSource(current)
            yield* sql`UPDATE expiry_business SET changed=true WHERE id=1`
          }),
        )
      }),
    )
    // 让真实 PostgreSQL 的锁等待跨过凭据期限。
    await new Promise((resolve) => setTimeout(resolve, 400))
    release()
    await blocker
    await expect(waiting).rejects.toMatchObject({ code: 'node_source_rejected' })
    expect((await run(query<{ changed: boolean }>('SELECT changed FROM expiry_business')))[0].changed).toBe(false)
  })

  it('resetting Coordinator presence requires a fresh connection and synchronization', async () => {
    const identity = await register(bob),
      current = source(identity)
    await run(Nodes.claimConnection(current))
    await run(Nodes.syncNode(current, syncInput))
    await run(Nodes.resetConnections())
    await expect(run(Nodes.touchNode(current))).rejects.toMatchObject({ code: 'node_source_rejected' })
    const restarted = source(identity)
    await run(Nodes.claimConnection(restarted))
    expect((await run(Nodes.getNode(bob.id, identity.node_id))).executable).toBe(false)
    await run(Nodes.syncNode(restarted, syncInput))
    expect((await run(Nodes.getNode(bob.id, identity.node_id))).executable).toBe(true)
  })
})

describe('signing key files', () => {
  it('persists one Ed25519 key under concurrent creation and rejects unsafe existing paths', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'baton-signing-'))
    try {
      const path = join(directory, 'signing.key')
      const [first, second] = await Promise.all([Nodes.loadSigningKey(path), Nodes.loadSigningKey(path)])
      expect(second.signingPublicKey).toBe(first.signingPublicKey)
      const claims = {
        node_id: randomUUID(),
        employee_id: randomUUID(),
        credential_id: randomUUID(),
        expires_at: new Date(Date.now() + 60000).toISOString(),
      }
      expect(second.verify(first.sign(claims))).toMatchObject({
        node_id: claims.node_id,
        employee_id: claims.employee_id,
      })
      await symlink(path, join(directory, 'link.key'))
      await expect(Nodes.loadSigningKey(join(directory, 'link.key'))).rejects.toMatchObject({
        code: 'invalid_signing_key',
      })
      await chmod(path, 0o644)
      await expect(Nodes.loadSigningKey(path)).rejects.toMatchObject({ code: 'invalid_signing_key' })
      await writeFile(join(directory, 'invalid.key'), 'invalid private key', { mode: 0o600 })
      await expect(Nodes.loadSigningKey(join(directory, 'invalid.key'))).rejects.toMatchObject({
        code: 'invalid_signing_key',
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
