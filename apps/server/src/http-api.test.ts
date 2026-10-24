import { afterAll, beforeAll, expect, it } from 'vite-plus/test'
import { Cause, Effect, Exit, Scope, Schema } from 'effect'
import * as ServerRequest from 'effect/http/HttpServerRequest'
import * as P from '@baton/protocol'
import { SessionResponse } from '@baton/protocol/http-api'
import * as SqlClient from 'effect/sql/SqlClient'
import * as HttpEffect from 'effect/http/HttpEffect'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { httpApplication, httpRouteTemplate } from './http.ts'
import * as Auth from './auth.ts'
import * as Nodes from './nodes.ts'
import { openTestDatabase, type TestDatabase } from './test-database.ts'
import type { Gateway } from './gateway.ts'

let database: TestDatabase
let scope: Scope.Closeable
let directory: string
let handle: (request: Request) => Promise<Response>
let token = ''
let csrf = ''
let nodeId = ''
let application: Effect.Success<ReturnType<typeof httpApplication>>
let heldStarted: (() => void) | undefined
const origin = 'https://baton.local'
const password = 'http-initial-password-123'
const readyPassword = 'http-ready-password-789'
const request = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
  handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: { origin, cookie: token, 'x-csrf-token': csrf, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
async function login(passwordValue: string, username = 'httpalice') {
  const response = await request('/api/v1/login', 'POST', { username, password: passwordValue })
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  token = response.headers.get('set-cookie')!.split(';')[0]
  const result = Schema.decodeUnknownSync(SessionResponse)(await response.json())
  expect(Object.keys(result).sort()).toEqual(['csrf_token', 'employee', 'expires_at'])
  csrf = result.csrf_token
  return result
}

beforeAll(async () => {
  database = await openTestDatabase()
  scope = await Effect.runPromise(Scope.make())
  directory = await mkdtemp(join(tmpdir(), 'baton-http-'))
  await mkdir(join(directory, 'web'))
  await mkdir(join(directory, 'web', 'assets'))
  await writeFile(join(directory, 'web', 'index.html'), '<title>Baton HTTP</title>')
  await writeFile(join(directory, 'web', 'assets', 'app.js'), 'console.log("Baton")')
  await writeFile(join(directory, 'secret.txt'), 'outside-root')
  await symlink(join(directory, 'secret.txt'), join(directory, 'web', 'escape.txt'))
  await database.run(Auth.createEmployee('httpalice', 'Alice', password))
  const employee = await database.run(Auth.createEmployee('httpready', 'Ready', password))
  await database.run(Auth.changePassword(employee.id, password, readyPassword))
  const enrollment = await database.run(Nodes.issueEnrollment(employee.id))
  const signer = Nodes.CredentialSigner.generate()
  nodeId = (
    await database.run(
      Nodes.registerNode(
        {
          enrollment_token: String(enrollment.enrollment_token),
          display_name: 'Local node',
          system: 'linux',
          capabilities: [],
        },
        signer,
      ),
    )
  ).node_id
  const gateway = {
    disconnectBrowsers: () => {},
    notify: () => {},
    disconnect: async () => {},
    request: async (_nodeId: string, _employeeId: string, input: Record<string, unknown>) => {
      if (input.path === 'hold') {
        heldStarted?.()
        await new Promise<never>(() => {})
      }
      return { type: 'files.browse_result', operation_id: randomUUID(), ok: true, entries: [], kind: 'directory' }
    },
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
  } as unknown as Gateway
  application = await database.runtime.runPromise(
    httpApplication({
      allowedOrigins: [origin],
      signer,
      gateway: () => gateway,
      webDirectory: join(directory, 'web'),
    }).pipe(Effect.provideService(Scope.Scope, scope)),
  )
  const context = await database.runtime.runPromise(Effect.context<SqlClient.SqlClient>())
  handle = HttpEffect.toWebHandler(application.pipe(Effect.provideContext(context)))
}, 30000)

afterAll(async () => {
  if (scope) await Effect.runPromise(Scope.close(scope, Exit.void))
  await database?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

it('preserves login, password, origin and CSRF gates before decoding endpoint requests', async () => {
  const rejected = await request('/api/v1/login', 'POST', {}, { origin: 'https://other.local' })
  expect(rejected.status).toBe(403)
  expect(await rejected.json()).toMatchObject({ code: 'origin_rejected', request_id: expect.any(String) })
  const anonymous = await request('/api/v1/me', 'GET', undefined, { cookie: '' })
  expect(anonymous.status).toBe(401)
  expect(await anonymous.json()).toMatchObject({
    code: 'unauthenticated',
    request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
  })
  expect((await login(password)).employee.must_change_password).toBe(true)
  expect((await request('/api/v1/nodes')).status).toBe(403)
  expect((await request('/api/v1/me')).status).toBe(200)
  const denied = await request('/api/v1/me/password', 'POST', {}, { 'x-csrf-token': 'wrong' })
  expect(denied.status).toBe(403)
  expect(await denied.json()).toMatchObject({ code: 'csrf_rejected' })
  const changed = await request('/api/v1/me/password', 'POST', {
    current_password: password,
    new_password: 'http-replacement-password-456',
  })
  expect(changed.status).toBe(204)
  expect(changed.headers.get('set-cookie')).toContain('Max-Age=0')
  expect((await request('/api/v1/me')).status).toBe(401)
  await login('http-replacement-password-456')
})

it('validates payloads, queries, paths, response shapes and explicit unavailable features', async () => {
  await login(readyPassword, 'httpready')
  const extra = await request('/api/v1/node-enrollments', 'POST', { extra: true })
  expect(extra.status).toBe(400)
  expect(await extra.json()).toMatchObject({
    code: 'invalid_request',
    request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
  })
  const contentType = await request('/api/v1/node-enrollments', 'POST', {}, { 'content-type': 'text/plain' })
  expect(contentType.status).toBe(415)
  expect(await contentType.json()).toMatchObject({ code: 'json_required' })
  for (const query of ['?extra=1', '?limit=0', '?limit=1&limit=2']) {
    expect((await request(`/api/v1/threads${query}`)).status).toBe(400)
  }
  expect((await request('/api/v1/nodes/invalid')).status).toBe(400)
  const denied = await request(`/api/v1/nodes/${randomUUID()}/files?extra=1`)
  expect(denied.status).toBe(403)
  const enrollment = await request('/api/v1/node-enrollments', 'POST', {})
  expect(enrollment.status).toBe(201)
  const value = Schema.decodeUnknownSync(P.EnrollmentResponse)(await enrollment.json())
  expect((await request(`/api/v1/node-enrollments/${value.enrollment_id}`)).status).toBe(200)
  expect((await request('/api/v1/nodes')).status).toBe(200)
  expect((await request(`/api/v1/nodes/${nodeId}`)).status).toBe(200)
  expect((await request(`/api/v1/nodes/${nodeId}/files`)).status).toBe(200)
  expect((await request('/api/v1/me/default-device', 'PUT', { node_id: nodeId })).status).toBe(200)
  expect((await request('/api/v1/diagnostics')).status).toBe(200)
  expect((await request('/api/v1/threads')).status).toBe(200)
  for (const path of ['/api/v1/projects', '/api/v1/inbox', `/api/v1/nodes/${nodeId}/roots`]) {
    const response = await request(path)
    expect(response.status).toBe(501)
    expect(await response.json()).toMatchObject({ code: 'feature_unavailable' })
  }
  for (const path of ['/api/v1/missing', '/api/v1/threads/', '/api/v1//threads', '/api/v1/Threads'])
    expect((await request(path)).status, path).toBe(404)
  expect((await request('/api/v1/me', 'HEAD')).status).toBe(404)
  expect(httpRouteTemplate('GET', `/api/v1/nodes/${nodeId}/files`)).toBe('/api/v1/nodes/:nodeId/files')
  expect(httpRouteTemplate('GET', '/api/v1/private/value')).toBe('/api/*')
  expect(httpRouteTemplate('GET', '/local/secret.txt')).toBe('/*')
  const document = await request('/api/v1/openapi.json')
  expect(document.status).toBe(200)
  expect(await document.json()).toMatchObject({
    paths: { '/api/v1/threads': { post: { responses: { '201': expect.anything() } } } },
  })
  expect((await request('/api/v1/openapi.json', 'GET', undefined, { cookie: '' })).status).toBe(401)
  const revoked = await request(`/api/v1/nodes/${nodeId}/revoke`, 'POST', {})
  expect(revoked.status).toBe(200)
})

it('propagates request cancellation and clears the session on logout', async () => {
  await login(readyPassword, 'httpready')
  const controller = new AbortController()
  const started = new Promise<void>((resolve) => {
    heldStarted = resolve
  })
  const result = database.runtime.runPromiseExit(
    application.pipe(
      Effect.provideService(
        ServerRequest.HttpServerRequest,
        ServerRequest.fromWeb(
          new Request(`http://localhost/api/v1/nodes/${nodeId}/files?path=hold`, { headers: { cookie: token } }),
        ),
      ),
      Effect.provideService(Scope.Scope, scope),
    ),
    { signal: controller.signal },
  )
  await started
  controller.abort()
  const exit = await result
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  const response = await request('/api/v1/logout', 'POST', {})
  expect(response.status).toBe(204)
  expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
  expect((await request('/api/v1/me')).status).toBe(401)
})

it('serves SPA and assets with HEAD while enforcing real directory boundaries', async () => {
  expect(await (await request('/threads/local')).text()).toContain('<title>Baton HTTP</title>')
  const head = await request('/threads/local', 'HEAD')
  expect(head.status).toBe(200)
  expect(await head.text()).toBe('')
  expect((await request('/assets/app.js')).headers.get('cache-control')).toContain('immutable')
  for (const path of ['/escape.txt', '/assets/missing.js', '/%2e%2e%2fsecret.txt'])
    expect((await request(path)).status).toBe(404)
})
