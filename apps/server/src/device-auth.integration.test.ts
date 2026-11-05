import { afterAll, beforeAll, expect, it } from 'vite-plus/test'
import { Effect, Exit, Scope, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as HttpEffect from 'effect/http/HttpEffect'
import { DeviceLoginCreateResponse, DeviceLoginSession, DeviceLoginTokenResponse } from '@baton/protocol'
import * as Auth from './auth.ts'
import * as Nodes from './nodes.ts'
import * as DeviceAuth from './device-auth.ts'
import { httpApplication } from './http/index.ts'
import { LoginProtection } from './http/login-protection.ts'
import { openTestDatabase, type TestDatabase } from './testing/database.ts'

let db: TestDatabase
let scope: Scope.Closeable
let employee: Auth.Employee
let other: Auth.Employee
let cookie: string
let csrf: string
let handle: (request: Request) => Promise<Response>
const origin = 'https://baton.local'
const signer = Nodes.CredentialSigner.generate()
const run: TestDatabase['run'] = (effect) => db.run(effect)
const query = <A extends object = { count: number }>(text: string, parameters: readonly unknown[] = []) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<A>(text, parameters))
const create = () => run(DeviceAuth.createSession({ display_name: 'Workstation', system: 'linux' }, origin))
const request = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
  handle(
    new Request(`${origin}${path}`, {
      method,
      headers: { host: 'baton.local', 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
const browser = () => ({ origin, cookie, 'x-csrf-token': csrf })

beforeAll(async () => {
  db = await openTestDatabase()
  scope = await Effect.runPromise(Scope.make())
  const password = 'offline-device-auth-password'
  employee = await run(Auth.createEmployee('devicealice', 'Alice', password))
  other = await run(Auth.createEmployee('devicebob', 'Bob', password))
  await run(Auth.changePassword(employee.id, password, `${password}-ready`))
  const session = await run(Auth.login(employee.username, `${password}-ready`))
  cookie = `baton_session=${session.token}`
  csrf = session.csrf_token
  const application = await run(
    httpApplication({
      allowedOrigins: [origin],
      signer,
      loginProtection: new LoginProtection(),
      trustedProxies: [],
      gateway: () => ({
        notify: () => {},
        disconnect: async () => {},
        disconnectBrowsers: () => {},
        request: async () => ({}),
        diagnostics: () => ({
          nodes: 0,
          browsers: 0,
          pending_rpc: 0,
          connections: 0,
          pending_disconnects: 0,
          received_bytes: 0,
          sent_bytes: 0,
          queued_control_messages: 0,
          queued_control_bytes: 0,
        }),
      }),
    }).pipe(Effect.provideService(Scope.Scope, scope)),
  )
  const context = await db.runtime.runPromise(Effect.context<SqlClient.SqlClient>())
  handle = HttpEffect.toWebHandler(application.pipe(Effect.provideContext(context)))
}, 30000)
afterAll(async () => {
  if (scope) await Effect.runPromise(Scope.close(scope, Exit.void))
  await db?.close()
})

it('binds only after browser authentication, Origin, CSRF and matching short code; retries return the identical identity', async () => {
  const created = await request('/api/v1/device-auth/sessions', 'POST', {
    display_name: 'Workstation',
    system: 'linux',
  })
  expect(created.status).toBe(201)
  const session = Schema.decodeUnknownSync(DeviceLoginCreateResponse)(await created.json())
  expect(session.verification_uri_complete).toBe(`${origin}/device-login?code=${session.user_code}`)
  const poll = { session_id: session.session_id, device_code: session.device_code }
  const pending = await request('/api/v1/device-auth/token', 'POST', poll)
  expect(await pending.json()).toEqual({ status: 'pending', interval_seconds: 2 })
  const byCode = `/api/v1/device-auth/sessions/by-code/${session.user_code.toLowerCase().replaceAll('-', '')}`
  expect((await request(byCode)).status).toBe(401)
  const lookup = await request(byCode, 'GET', undefined, browser())
  expect(lookup.status).toBe(200)
  const safe = Schema.decodeUnknownSync(DeviceLoginSession)(await lookup.json())
  expect(Object.keys(safe).sort()).toEqual(['display_name', 'expires_at', 'session_id', 'system', 'user_code'])
  expect(JSON.stringify(safe)).not.toContain(session.device_code)
  const approve = `/api/v1/device-auth/sessions/${session.session_id}/approve`
  expect(
    (await request(approve, 'POST', { user_code: session.user_code }, { ...browser(), origin: 'https://evil.local' }))
      .status,
  ).toBe(403)
  expect(
    (await request(approve, 'POST', { user_code: session.user_code }, { ...browser(), 'x-csrf-token': 'wrong' }))
      .status,
  ).toBe(403)
  expect((await request(approve, 'POST', { user_code: 'ZZZZ-ZZZZ' }, browser())).status).toBe(404)
  expect((await request(approve, 'POST', { user_code: session.user_code }, browser())).status).toBe(204)
  expect((await request(approve, 'POST', { user_code: session.user_code }, browser())).status).toBe(204)
  const response = await request('/api/v1/device-auth/token', 'POST', poll)
  const first = Schema.decodeUnknownSync(DeviceLoginTokenResponse)(await response.json())
  expect(first.status).toBe('approved')
  if (first.status !== 'approved') throw new Error('approval required')
  expect(first.identity.employee_id).toBe(employee.id)
  expect(first.identity.credential).toMatchObject({ version: 1 })
  expect(
    JSON.parse(Buffer.from(first.identity.credential.token.split('.')[1]!, 'base64url').toString()).exp,
  ).toBeUndefined()
  await run(query('UPDATE nodes SET display_name=$1 WHERE id=$2', ['Changed later', first.identity.node_id]))
  expect(await (await request('/api/v1/device-auth/token', 'POST', poll)).json()).toEqual(first)
  const retries = await Promise.all(Array.from({ length: 4 }, () => run(DeviceAuth.token(poll, signer))))
  for (const retry of retries) expect(retry).toEqual(first)
  await run(Nodes.authenticateNode(first.identity.credential.token, signer))
  expect(await run(Nodes.listNodes(other.id))).toMatchObject({ nodes: [] })
  expect(
    (await run(query('SELECT count(*)::integer AS count FROM nodes WHERE employee_id=$1', [employee.id])))[0].count,
  ).toBe(1)
  expect(await run(Nodes.listNodes(employee.id))).toMatchObject({ default_device: { node_id: first.identity.node_id } })
})

it('rejects wrong device proof, denied and expired sessions, including consumed retries after expiry', async () => {
  const session = await create()
  await expect(
    run(DeviceAuth.token({ session_id: session.session_id, device_code: 'wrong' }, signer)),
  ).rejects.toMatchObject({ code: 'invalid_device_code' })
  const deny = `/api/v1/device-auth/sessions/${session.session_id}/deny`
  expect((await request(deny, 'POST', undefined, { ...browser(), 'x-csrf-token': '' })).status).toBe(403)
  expect((await request(deny, 'POST', undefined, browser())).status).toBe(204)
  expect(await run(DeviceAuth.token(session, signer))).toEqual({ status: 'denied' })
  await expect(
    run(DeviceAuth.approveSession(employee.id, session.session_id, session.user_code)),
  ).rejects.toMatchObject({ code: 'device_login_handled' })
  for (const consume of [false, true]) {
    const next = await create()
    if (consume) {
      await run(DeviceAuth.approveSession(employee.id, next.session_id, next.user_code))
      expect((await run(DeviceAuth.token(next, signer))).status).toBe('approved')
    }
    await run(
      query(
        "UPDATE device_login_sessions SET created_at=clock_timestamp()-interval '601 seconds',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [next.session_id],
      ),
    )
    await expect(run(DeviceAuth.sessionByCode(next.user_code))).rejects.toMatchObject({ status: 410 })
    await expect(run(DeviceAuth.approveSession(employee.id, next.session_id, next.user_code))).rejects.toMatchObject({
      status: 410,
    })
    expect(await run(DeviceAuth.token(next, signer))).toEqual({ status: 'expired' })
  }
})

it('serializes competing approvals and protects approved and consumed tokens against revocation', async () => {
  const session = await create()
  const approvals = await Promise.allSettled([
    run(DeviceAuth.approveSession(employee.id, session.session_id, session.user_code)),
    run(DeviceAuth.approveSession(other.id, session.session_id, session.user_code)),
  ])
  expect(approvals.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  const first = await run(DeviceAuth.token(session, signer))
  if (first.status !== 'approved') throw new Error('approval required')
  await run(Nodes.revokeNode(first.identity.employee_id, first.identity.node_id))
  await expect(run(DeviceAuth.token(session, signer))).rejects.toMatchObject({ code: 'credential_revoked' })
  await expect(run(Nodes.authenticateNode(first.identity.credential.token, signer))).rejects.toMatchObject({
    code: 'credential_revoked',
  })
  const next = await create()
  const nodeId = await run(DeviceAuth.approveSession(employee.id, next.session_id, next.user_code))
  await run(Nodes.revokeNode(employee.id, nodeId))
  await expect(run(DeviceAuth.token(next, signer))).rejects.toMatchObject({ code: 'credential_revoked' })
})

it('checks expiration again after waiting for the employee registration lock and rolls back the new node', async () => {
  const session = await create()
  await run(
    query(
      "UPDATE device_login_sessions SET created_at=clock_timestamp()-interval '1 minute',expires_at=clock_timestamp()+interval '0.2 seconds' WHERE id=$1",
      [session.session_id],
    ),
  )
  let release!: () => void
  let acquired!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const locked = new Promise<void>((resolve) => {
    acquired = resolve
  })
  const blocker = run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SELECT employee_id FROM employee_settings WHERE employee_id=${employee.id}::uuid FOR UPDATE`
          acquired()
          yield* Effect.promise(() => gate)
        }),
      )
    }),
  )
  await locked
  const count = async () =>
    (await run(query('SELECT count(*)::integer AS count FROM nodes WHERE employee_id=$1', [employee.id])))[0].count
  const before = await count()
  const approval = expect(
    run(DeviceAuth.approveSession(employee.id, session.session_id, session.user_code)),
  ).rejects.toMatchObject({ code: 'device_login_expired' })
  await new Promise((resolve) => setTimeout(resolve, 250))
  release()
  await blocker
  await approval
  expect(await count()).toBe(before)
})

it('returns expired after a pending poll waits past the session deadline', async () => {
  const session = await create()
  await run(
    query(
      "UPDATE device_login_sessions SET created_at=clock_timestamp()-interval '1 minute',expires_at=clock_timestamp()+interval '0.2 seconds' WHERE id=$1",
      [session.session_id],
    ),
  )
  let release!: () => void
  let acquired!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const locked = new Promise<void>((resolve) => {
    acquired = resolve
  })
  const blocker = run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SELECT id FROM device_login_sessions WHERE id=${session.session_id}::uuid FOR UPDATE`
          acquired()
          yield* Effect.promise(() => gate)
        }),
      )
    }),
  )
  await locked
  const poll = run(DeviceAuth.token(session, signer))
  await new Promise((resolve) => setTimeout(resolve, 250))
  release()
  await blocker
  expect(await poll).toEqual({ status: 'expired' })
})

it('limits anonymous session creation before parsing and rejects unconfigured verification hosts', async () => {
  expect(
    (
      await request(
        '/api/v1/device-auth/sessions',
        'POST',
        { display_name: 'X', system: 'linux' },
        { host: 'evil.local' },
      )
    ).status,
  ).toBe(400)
  let response: Response | undefined
  for (let attempt = 0; attempt < 20; attempt++) {
    response = await request('/api/v1/device-auth/sessions', 'POST', { display_name: 'X', system: 'linux' })
    if (response.status === 429) break
    expect(response.status).toBe(201)
  }
  expect(response?.status).toBe(429)
  expect(Number(response?.headers.get('retry-after'))).toBeGreaterThan(0)
  expect((await request('/api/v1/device-auth/%73essions', 'POST', { display_name: 'X', system: 'linux' })).status).toBe(
    429,
  )
})
