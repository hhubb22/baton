import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vite-plus/test'
import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as Auth from './auth.ts'
import * as Nodes from './nodes.ts'
import { type NodeSource } from './errors.ts'
import { openTestDatabase, type TestDatabase } from './testing/database.ts'

let db: TestDatabase
let employee: Auth.Employee
let other: Auth.Employee
const signer = Nodes.CredentialSigner.generate()
const sync = { display_name: 'Workstation', system: 'linux', capabilities: [] }
const run: TestDatabase['run'] = (effect) => db.run(effect)
const query = (text: string, parameters: readonly unknown[] = []) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.unsafe(text, parameters)
  })
async function register() {
  const enrollment = await run(Nodes.issueEnrollment(employee.id))
  const identity = await run(
    Nodes.registerNode({ ...sync, enrollment_token: String(enrollment.enrollment_token) }, signer),
  )
  const source: NodeSource = {
    node_id: identity.node_id,
    employee_id: identity.employee_id,
    credential_id: identity.credential.id,
    incarnation: randomUUID(),
    conn_id: randomUUID(),
  }
  await run(Nodes.claimConnection(source))
  await run(Nodes.syncNode(source, sync))
  return { identity, source }
}
const business = (source: NodeSource) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* Nodes.lockNodeSource(source)
        yield* Nodes.recordNodeBusiness(source)
      }),
    )
  })

beforeAll(async () => {
  db = await openTestDatabase()
  employee = await run(Auth.createEmployee('idle', 'Idle', 'offline-password-123'))
  other = await run(Auth.createEmployee('other', 'Other', 'offline-password-123'))
}, 30000)
afterAll(async () => {
  await db?.close()
})

it('uses database idle expiry and keeps heartbeat, reconnect and capability reports separate from business', async () => {
  const { identity, source } = await register()
  const second = await register()
  await run(
    query(
      "UPDATE node_credentials SET created_at=clock_timestamp()-interval '29 days',last_business_at=clock_timestamp()-interval '29 days',expires_at=clock_timestamp()+interval '1 day' WHERE id=$1",
      [identity.credential.id],
    ),
  )
  const before = await run(
    query('SELECT last_business_at,expires_at FROM node_credentials WHERE id=$1', [identity.credential.id]),
  )
  await run(Nodes.touchNode(source))
  await run(
    Nodes.saveRuntimeReport(source, {
      agents: [],
      roots: [],
      repos: [],
      exec: { enabled: false, shell: '/bin/sh' },
      user: 'local',
    }),
  )
  await run(Nodes.disconnectNode(source))
  const reconnected = { ...source, conn_id: randomUUID() }
  await run(Nodes.claimConnection(reconnected))
  await run(Nodes.syncNode(reconnected, sync))
  await run(business(second.source))
  expect(
    await run(query('SELECT last_business_at,expires_at FROM node_credentials WHERE id=$1', [identity.credential.id])),
  ).toEqual(before)
  await run(Nodes.authenticateNode(identity.credential.token, signer))
  await run(business(reconnected))
  const renewed = await run(
    query("SELECT expires_at>clock_timestamp()+interval '29 days' AS renewed FROM node_credentials WHERE id=$1", [
      identity.credential.id,
    ]),
  )
  expect(renewed).toMatchObject([{ renewed: true }])
  const jwt = JSON.parse(Buffer.from(identity.credential.token.split('.')[1]!, 'base64url').toString())
  expect(jwt.exp).toBeUndefined()
  await run(
    query("UPDATE node_credentials SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [
      identity.credential.id,
    ]),
  )
  const expired = await run(
    query('SELECT last_business_at,expires_at FROM node_credentials WHERE id=$1', [identity.credential.id]),
  )
  await expect(run(Nodes.authenticateNode(identity.credential.token, signer))).rejects.toMatchObject({
    code: 'node_idle_expired',
  })
  await expect(run(business(reconnected))).rejects.toMatchObject({ code: 'node_idle_expired' })
  await expect(run(Nodes.touchNode(reconnected))).rejects.toMatchObject({ code: 'node_idle_expired' })
  expect(
    await run(query('SELECT last_business_at,expires_at FROM node_credentials WHERE id=$1', [identity.credential.id])),
  ).toEqual(expired)
  expect(await run(Nodes.getNode(employee.id, identity.node_id))).toMatchObject({
    credential_state: 'idle_expired',
    executable: false,
  })
})

it('reissues once after lost responses and keeps the original device, default and Thread without resending input', async () => {
  const { identity, source } = await register()
  const threadId = randomUUID()
  await run(Nodes.setDefaultDevice(employee.id, identity.node_id))
  await run(
    query(
      "INSERT INTO threads(id,employee_id,node_id,client_thread_id,request_hash,agent_type,working_directory,created_by) VALUES($1::uuid,$2,$3,$1::text,$4,'cursor','/work','employee')",
      [threadId, employee.id, identity.node_id, Buffer.alloc(32)],
    ),
  )
  await run(
    query(
      "UPDATE node_credentials SET created_at=clock_timestamp()-interval '31 days',last_business_at=clock_timestamp()-interval '31 days',expires_at=clock_timestamp()-interval '1 day' WHERE id=$1",
      [identity.credential.id],
    ),
  )
  await run(Nodes.disconnectNode(source))
  await expect(run(Nodes.issueReauthEnrollment(other.id, identity.node_id))).rejects.toMatchObject({
    code: 'forbidden',
  })
  const enrollment = await run(Nodes.issueReauthEnrollment(employee.id, identity.node_id))
  const request = {
    operation_id: randomUUID(),
    enrollment_token: String(enrollment.enrollment_token),
    previous_token: identity.credential.token,
  }
  const results = await Promise.all(
    Array.from({ length: 4 }, () => run(Nodes.reauthenticateNode(identity.node_id, request, signer))),
  )
  const fresh = results[0]!
  for (const result of results) expect(result).toEqual(fresh)
  expect(fresh).toMatchObject({
    node_id: identity.node_id,
    registration_seq: identity.registration_seq,
    registered_at: identity.registered_at,
    credential: { version: 2 },
  })
  await expect(run(Nodes.authenticateNode(identity.credential.token, signer))).rejects.toMatchObject({
    code: 'invalid_node_credential',
  })
  await run(Nodes.authenticateNode(fresh.credential.token, signer))
  await run(
    query(
      "UPDATE node_enrollments SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' WHERE id=$1",
      [enrollment.enrollment_id],
    ),
  )
  expect(await run(Nodes.reauthenticateNode(identity.node_id, request, signer))).toEqual(fresh)
  await expect(
    run(Nodes.reauthenticateNode(identity.node_id, { ...request, operation_id: randomUUID() }, signer)),
  ).rejects.toMatchObject({ code: 'reauth_conflict' })
  expect(await run(query('SELECT credential_version FROM nodes WHERE id=$1', [identity.node_id]))).toMatchObject([
    { credential_version: 2 },
  ])
  expect(await run(query('SELECT node_id::text FROM threads WHERE id=$1', [threadId]))).toMatchObject([
    { node_id: identity.node_id },
  ])
  expect(
    await run(query('SELECT default_device_node_id::text FROM employee_settings WHERE employee_id=$1', [employee.id])),
  ).toMatchObject([{ default_device_node_id: identity.node_id }])
  expect(await run(query('SELECT id FROM thread_outbox WHERE thread_id=$1', [threadId]))).toHaveLength(0)
  await run(Nodes.revokeNode(employee.id, identity.node_id))
  await expect(run(Nodes.reauthenticateNode(identity.node_id, request, signer))).rejects.toMatchObject({
    code: 'forbidden',
  })
  await expect(run(Nodes.issueReauthEnrollment(employee.id, identity.node_id))).rejects.toMatchObject({
    code: 'forbidden',
  })
})

it('returns a conflict when two devices submit the same reauthentication operation ID', async () => {
  const devices = await Promise.all([register(), register()])
  const operationId = randomUUID()
  const attempts = await Promise.all(
    devices.map(async ({ identity, source }) => {
      await run(Nodes.disconnectNode(source))
      const enrollment = await run(Nodes.issueReauthEnrollment(employee.id, identity.node_id))
      return {
        nodeId: identity.node_id,
        request: {
          operation_id: operationId,
          enrollment_token: String(enrollment.enrollment_token),
          previous_token: identity.credential.token,
        },
      }
    }),
  )
  const results = await Promise.allSettled(
    attempts.map(({ nodeId, request }) => run(Nodes.reauthenticateNode(nodeId, request, signer))),
  )
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  const rejected = results.find((result) => result.status === 'rejected')
  expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({ code: 'reauth_conflict' })
})

it('checks enrollment time after the node lock wait and cannot revive a concurrently revoked device', async () => {
  const { identity, source } = await register()
  await run(Nodes.disconnectNode(source))
  const enrollment = await run(Nodes.issueReauthEnrollment(employee.id, identity.node_id))
  const request = {
    operation_id: randomUUID(),
    enrollment_token: String(enrollment.enrollment_token),
    previous_token: identity.credential.token,
  }
  let release!: () => void
  let acquired!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const locked = new Promise<void>((resolve) => {
    acquired = resolve
  })
  const holder = run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SELECT id FROM nodes WHERE id=${identity.node_id} FOR UPDATE`
          acquired()
          yield* Effect.promise(() => gate)
        }),
      )
    }),
  )
  await locked
  const pending = run(Nodes.reauthenticateNode(identity.node_id, request, signer))
  await run(
    query(
      "UPDATE node_enrollments SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' WHERE id=$1",
      [enrollment.enrollment_id],
    ),
  )
  release()
  await holder
  await expect(pending).rejects.toMatchObject({ code: 'enrollment_expired' })
  const fresh = await run(Nodes.issueReauthEnrollment(employee.id, identity.node_id))
  const [replacement, revoked] = await Promise.allSettled([
    run(
      Nodes.reauthenticateNode(
        identity.node_id,
        { ...request, operation_id: randomUUID(), enrollment_token: String(fresh.enrollment_token) },
        signer,
      ),
    ),
    run(Nodes.revokeNode(employee.id, identity.node_id)),
  ])
  expect(revoked.status).toBe('fulfilled')
  if (replacement.status === 'fulfilled')
    await expect(run(Nodes.authenticateNode(replacement.value.credential.token, signer))).rejects.toMatchObject({
      code: 'invalid_node_credential',
    })
  else expect(replacement.reason).toMatchObject({ code: 'forbidden' })
  await expect(run(Nodes.authenticateNode(identity.credential.token, signer))).rejects.toMatchObject({
    code: 'invalid_node_credential',
  })
})

it('rejects expired enrollments, wrong targets and missing original proof without consuming the credential', async () => {
  const { identity, source } = await register()
  const second = await register()
  await run(Nodes.disconnectNode(source))
  const enrollment = await run(Nodes.issueReauthEnrollment(employee.id, identity.node_id))
  const request = {
    operation_id: randomUUID(),
    enrollment_token: String(enrollment.enrollment_token),
    previous_token: identity.credential.token,
  }
  await expect(run(Nodes.reauthenticateNode(second.identity.node_id, request, signer))).rejects.toMatchObject({
    code: 'forbidden',
  })
  await expect(
    run(Nodes.reauthenticateNode(identity.node_id, { ...request, previous_token: '' }, signer)),
  ).rejects.toMatchObject({ code: 'invalid_node_credential' })
  const foreignEnrollment = await run(Nodes.issueEnrollment(other.id))
  await expect(
    run(
      Nodes.reauthenticateNode(
        identity.node_id,
        { ...request, enrollment_token: String(foreignEnrollment.enrollment_token) },
        signer,
      ),
    ),
  ).rejects.toMatchObject({ code: 'invalid_enrollment' })
  await run(
    query(
      "UPDATE node_enrollments SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' WHERE id=$1",
      [enrollment.enrollment_id],
    ),
  )
  await expect(run(Nodes.reauthenticateNode(identity.node_id, request, signer))).rejects.toMatchObject({
    code: 'enrollment_expired',
  })
  expect(
    await run(query('SELECT used_at,operation_id FROM node_enrollments WHERE id=$1', [enrollment.enrollment_id])),
  ).toMatchObject([{ used_at: null, operation_id: null }])
  expect(await run(query('SELECT credential_version FROM nodes WHERE id=$1', [identity.node_id]))).toMatchObject([
    { credential_version: 1 },
  ])
})
