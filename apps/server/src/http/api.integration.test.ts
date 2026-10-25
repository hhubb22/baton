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
import { httpApplication, httpRouteTemplate } from './index.ts'
import * as Auth from '../auth.ts'
import * as Nodes from '../nodes.ts'
import { openTestDatabase, type TestDatabase } from '../testing/database.ts'
import type { HTTPOptions } from './options.ts'

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
  const identity = await database.run(
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
  nodeId = identity.node_id
  const source = {
    employee_id: employee.id,
    node_id: nodeId,
    credential_id: identity.credential.id,
    incarnation: randomUUID(),
    conn_id: randomUUID(),
  }
  await database.run(Nodes.claimConnection(source))
  await database.run(Nodes.syncNode(source, { display_name: 'Local node', system: 'linux', capabilities: [] }))
  const gateway: ReturnType<HTTPOptions['gateway']> = {
    disconnectBrowsers: () => {},
    notify: () => {},
    disconnect: async () => {
      await database.run(Nodes.disconnectNode(source))
    },
    request: async (_nodeId: string, _employeeId: string, input: Record<string, unknown>) => {
      if (input.path === 'hold') {
        heldStarted?.()
        await new Promise<never>(() => {})
      }
      if (input.type === 'node.browse_roots_get') {
        return { type: 'node.browse_roots_get_result', operation_id: input.operation_id, ok: true, page: { roots: [] } }
      }
      return {
        type: 'files.browse_result',
        operation_id: input.operation_id,
        ok: true,
        ...(typeof input.root_id === 'string'
          ? { kind: 'directory', root_id: input.root_id, path: input.path ?? '', entries: [] }
          : { kind: 'roots', roots: [] }),
      }
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
  }
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

it('validates payloads, queries, paths, response shapes and available feature routes', async () => {
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
  for (const path of ['/api/v1/projects', '/api/v1/inbox']) {
    const response = await request(path)
    expect(response.status).toBe(200)
  }
  expect((await request(`/api/v1/nodes/${nodeId}/roots`)).status).toBe(200)
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
})

it('serves persisted trace pages with raw JSON and distinguishes missing Turns from missing trace', async () => {
  const { employee } = await login(readyPassword, 'httpready')
  const threadId = randomUUID()
  const data = { output: 'raw\u0000\ud800', nested: { value: null } }
  await database.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO threads(id,employee_id,node_id,client_thread_id,request_hash,agent_type,working_directory,created_by)
      VALUES(${threadId},${employee.id},${nodeId},${threadId},${Buffer.alloc(32)},'cursor','/work','employee')`
      for (const seq of [1, 2]) {
        yield* sql`INSERT INTO thread_turns(id,employee_id,thread_id,worker_turn_seq,initiator,started_at,ended_at,end_reason)
        VALUES(${randomUUID()},${employee.id},${threadId},${seq},'employee',now(),now(),'completed')`
      }
      yield* sql`INSERT INTO thread_turn_items(employee_id,thread_id,worker_turn_seq,item_id,worker_seq,ordinal,type,status,data,truncated,original_bytes)
      SELECT ${employee.id},${threadId},1,'item-'||n,n,n,'tool_call','completed',${JSON.stringify(data)}::json,false,100 FROM generate_series(1,60) n`
      yield* sql`UPDATE threads SET last_worker_seq=60 WHERE id=${threadId}`
    }),
  )
  const path = `/api/v1/threads/${threadId}/trace`
  const first = await request(`${path}?worker_turn_seq=1`)
  expect(first.status).toBe(200)
  const page = Schema.decodeUnknownSync(P.ThreadTrace)(await first.json())
  expect(page.steps).toHaveLength(50)
  expect(page.steps![0]!.data).toEqual(data)
  expect(page.next_cursor).toBeTruthy()
  expect(page.page_cursor).toBeTruthy()
  await database.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO thread_turn_items(employee_id,thread_id,worker_turn_seq,item_id,worker_seq,ordinal,type,status,data,truncated,original_bytes)
      VALUES(${employee.id},${threadId},1,'late-item',61,0,'tool_call','completed','{}'::json,false,2)`
      yield* sql`UPDATE threads SET last_worker_seq=61 WHERE id=${threadId}`
    }),
  )
  const replay = await request(`${path}?worker_turn_seq=1&cursor=${page.page_cursor}`)
  expect(replay.status).toBe(200)
  expect(await replay.json()).toEqual(page)
  const fresh = await request(`${path}?worker_turn_seq=1`)
  expect(Schema.decodeUnknownSync(P.ThreadTrace)(await fresh.json()).steps![0]!.item_id).toBe('late-item')
  const next = await request(`${path}?worker_turn_seq=1&cursor=${page.next_cursor}`)
  expect(next.status).toBe(200)
  expect(Schema.decodeUnknownSync(P.ThreadTrace)(await next.json()).steps).toHaveLength(10)
  expect(await (await request(`${path}?worker_turn_seq=2`)).json()).toEqual({
    ok: false,
    code: 'trace_missing',
    steps: [],
    page_cursor: expect.any(String),
  })
  expect((await request(`${path}?worker_turn_seq=3`)).status).toBe(404)
  expect((await request(`${path}?worker_turn_seq=1&cursor=bad`)).status).toBe(422)
  expect((await request(path)).status).toBe(400)
  expect((await request(`/api/v1/threads/${randomUUID()}/trace?worker_turn_seq=1`)).status).toBe(404)
  await login('http-replacement-password-456')
  expect((await request(`${path}?worker_turn_seq=1`)).status).toBe(404)
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
          new Request(`http://localhost/api/v1/nodes/${nodeId}/files?root_id=home&path=hold`, {
            headers: { cookie: token },
          }),
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
  expect((await request(`/api/v1/nodes/${nodeId}/revoke`, 'POST', {})).status).toBe(200)
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

it('preserves Project and memory writes, conflict bodies and employee isolation through the HTTP contracts', async () => {
  await login(readyPassword, 'httpready')
  const input = {
    client_project_id: randomUUID(),
    title: 'Local coordination',
    goal: 'Restore the Project workflow',
    provider: 'openai-codex',
    model: 'fake-model',
  }
  const created = await request('/api/v1/projects', 'POST', input)
  expect(created.status).toBe(201)
  const project = Schema.decodeUnknownSync(P.Project)(await created.json())
  const path = `/api/v1/projects/${project.id}`
  for (const field of ['provider', 'model']) {
    for (const invalid of ['invalid\nlabel', 'x'.repeat(1025)]) {
      expect((await request('/api/v1/projects', 'POST', { ...input, [field]: invalid })).status).toBe(400)
      expect((await request(path, 'PATCH', { [field]: invalid })).status).toBe(400)
    }
  }
  const replay = await request('/api/v1/projects', 'POST', input)
  expect(replay.status).toBe(201)
  expect(await replay.json()).toMatchObject({ id: project.id })
  expect((await request('/api/v1/projects', 'POST', { ...input, goal: 'Other goal' })).status).toBe(409)
  expect((await request(path, 'PATCH', { title: 'Updated coordination' })).status).toBe(200)
  const message = { client_message_id: randomUUID(), content: 'Inspect and coordinate' }
  const accepted = await request(`${path}/messages`, 'POST', message)
  expect(accepted.status).toBe(202)
  const original = Schema.decodeUnknownSync(P.ProjectMessage)(await accepted.json())
  expect(await (await request(`${path}/messages`, 'POST', message)).json()).toMatchObject({ id: original.id })
  expect((await request(`${path}/messages`, 'POST', { ...message, content: 'Other message' })).status).toBe(409)
  expect(await (await request(`${path}/messages?client_message_id=${message.client_message_id}`)).json()).toMatchObject(
    {
      messages: [{ id: original.id, content: message.content }],
    },
  )
  const memoryPath = `${path}/memory/${randomUUID()}`
  const memory = { title: 'Plan', content: 'Inspect the first device', expected_revision: 0 }
  expect((await request(memoryPath, 'PUT', memory)).status).toBe(200)
  const conflict = await request(memoryPath, 'PUT', { ...memory, content: 'Stale replacement' })
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toMatchObject({
    current_revision: 1,
    current: { title: memory.title, content: memory.content, revision: 1 },
  })
  expect(await (await request(`${memoryPath}/revisions`)).json()).toMatchObject({
    revisions: [{ revision: 1, title: memory.title, content: memory.content, author: 'user' }],
  })
  for (const operation of ['stop', 'retry']) {
    expect((await request(`${path}/${operation}?extra=1`, 'POST', {})).status).toBe(400)
    expect((await request(`${path}/${operation}`, 'POST', { extra: true })).status).toBe(400)
    expect((await request(`${path}/${operation}`, 'POST', {})).status).toBe(200)
  }
  expect((await request(`${path}/status`)).status).toBe(200)
  expect((await request(`${path}/events`)).status).toBe(200)
  await login('http-replacement-password-456')
  for (const resource of [path, `${path}/messages`, memoryPath, `${memoryPath}/revisions`])
    expect((await request(resource)).status).toBe(404)
  expect((await request(path, 'PATCH', { title: 'Other employee' })).status).toBe(404)
  expect((await request(memoryPath, 'PUT', memory)).status).toBe(404)
})
