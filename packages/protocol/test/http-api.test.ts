import { expect, it } from 'vite-plus/test'
import { Schema } from 'effect'
import { BatonHttpApi, EnrollmentResponse, HttpErrors, SessionResponse, httpOpenApi } from '../src/http-api.ts'
import { EnrollmentResponse as DeviceEnrollmentResponse, SessionResponse as AuthSessionResponse } from '../src/index.ts'

it('generates schemas, statuses and cookie security for every implemented HTTP endpoint', () => {
  const endpoints = Object.values(BatonHttpApi.groups).flatMap((group) => Object.values(group.endpoints))
  expect(endpoints).toHaveLength(64)
  const document = httpOpenApi()
  expect(document.info.title).toBe('Baton HTTP API')
  expect(document.paths['/api/v1/release']?.get?.responses).toHaveProperty('200')
  expect(document.paths['/api/v1/release']?.get?.security ?? []).toEqual([])
  expect(document.paths['/api/v1/downloads']?.get?.responses).toHaveProperty('200')
  expect(document.paths['/api/v1/downloads']?.get?.security ?? []).toEqual([])
  expect(document.paths['/api/v1/login']?.post?.requestBody).toMatchObject({ required: true })
  expect(document.paths['/api/v1/threads']?.post?.responses).toHaveProperty('201')
  expect(document.paths['/api/v1/threads/{threadId}/messages']?.post?.responses).toHaveProperty('202')
  expect(document.paths['/api/v1/threads/{threadId}/answer']?.post?.responses).toHaveProperty('202')
  expect(document.paths['/api/v1/threads/{threadId}/answer']?.post?.security).toEqual([{ session: [] }])
  expect(document.paths['/api/v1/threads/{threadId}/settings']?.patch?.requestBody).toMatchObject({ required: true })
  expect(document.paths['/api/v1/threads/{threadId}/settings']?.patch?.responses).toHaveProperty('200')
  expect(document.paths['/api/v1/logout']?.post?.responses).toHaveProperty('204')
  expect(document.paths['/api/v1/projects']?.post?.responses).toHaveProperty('201')
  expect(document.paths['/api/v1/projects/{projectId}/messages']?.post?.responses).toHaveProperty('202')
  for (const path of ['/api/v1/projects/{projectId}/memory/topics', '/api/v1/projects/{projectId}/memory/status']) {
    expect(document.paths[path]?.get?.responses).toHaveProperty('200')
    expect(document.paths[path]?.get?.security).toEqual([{ session: [] }])
  }
  expect(document.paths['/api/v1/attention-requests/{requestId}/answer']?.post?.responses).toHaveProperty('409')
  expect(document.paths['/api/v1/nodes/{nodeId}/roots']?.get?.responses).toHaveProperty('200')
  expect(document.paths['/api/v1/nodes/{nodeId}/roots']?.get?.security).toEqual([{ session: [] }])
  expect(document.paths['/api/v1/nodes/{nodeId}/roots']?.delete?.requestBody).toMatchObject({ required: true })
  expect(document.paths['/api/v1/nodes']?.get?.security).toEqual([{ session: [] }])
  for (const path of ['/api/v1/nodes/{nodeId}/model-connections', '/api/v1/nodes/{nodeId}/subscriptions/logout']) {
    expect(document.paths[path]?.post?.requestBody).toMatchObject({ required: true })
    expect(document.paths[path]?.post?.responses).toHaveProperty('200')
    expect(document.paths[path]?.post?.security).toEqual([{ session: [] }])
  }
  for (const path of ['/api/v1/events/replay', '/api/v1/activity']) {
    expect(document.paths[path]?.get?.responses).toHaveProperty('200')
    expect(document.paths[path]?.get?.security).toEqual([{ session: [] }])
  }
  expect(document.paths['/api/v1/nodes/{nodeId}/reauth-enrollments']?.post?.security).toEqual([{ session: [] }])
  expect(document.paths['/api/v1/nodes/{nodeId}/reauth-enrollments']?.post?.responses).toHaveProperty('201')
  expect(document.paths['/api/v1/nodes/{nodeId}/reauth']?.post?.responses).toHaveProperty('200')
  expect(document.paths['/api/v1/nodes/{nodeId}/reauth']?.post?.security ?? []).toEqual([])
  expect(document.components.securitySchemes.session).toMatchObject({
    type: 'apiKey',
    in: 'cookie',
    name: 'baton_session',
  })
  expect(document.paths['/api/v1/node-enrollments']?.post?.responses).toHaveProperty('501')
})

it('Session 与 Enrollment 在领域和 HTTP 入口保留实际响应约束', () => {
  const session = {
    employee: {
      id: 'employee',
      username: 'alice',
      display_name: '',
      auth_source: 'local',
      must_change_password: false,
    },
    csrf_token: '\0',
    expires_at: '2026-10-24T00:00:00.123456789Z',
  }
  for (const schema of [SessionResponse, AuthSessionResponse]) {
    const decoded = Schema.decodeUnknownSync(schema)({ ...session, future_field: true })
    expect(Schema.encodeSync(schema)(decoded)).toEqual(session)
    expect(Schema.is(schema)({ ...session, csrf_token: 1 })).toBe(false)
    expect(Schema.is(schema)({ ...session, expires_at: 'tomorrow' })).toBe(false)
  }
  const enrollment = {
    enrollment_id: 'enrollment',
    enrollment_token: 'token',
    expires_at: '2026-10-24T00:00:00.123456789Z',
    expires_in_ms: 60000,
  }
  for (const schema of [EnrollmentResponse, DeviceEnrollmentResponse]) {
    const decoded = Schema.decodeUnknownSync(schema)({ ...enrollment, future_field: true })
    expect(Schema.encodeSync(schema)(decoded)).toEqual(enrollment)
    expect(Schema.is(schema)({ ...enrollment, expires_at: 0 })).toBe(false)
    expect(Schema.is(schema)({ ...enrollment, expires_at: 'tomorrow' })).toBe(false)
  }
})

it('round trips declared error statuses without adding internal fields to the response body', () => {
  const body = { code: 'forbidden', message: '不能操作该设备', request_id: '28a6945e-f488-436c-a5b5-20b30496a437' }
  for (const schema of HttpErrors) {
    const decoded = Schema.decodeUnknownSync(schema)(body)
    expect(decoded.status).toBeTypeOf('number')
    expect(Schema.encodeSync(schema)(decoded)).toEqual(body)
  }
})

it('preserves the current memory revision in declared conflict responses', () => {
  const current = {
    id: '5c482828-b1eb-4ea3-8c86-bc447f7fc780',
    kind: 'fact',
    status: 'active',
    basis: 'explicit',
    topic: '',
    conditions: '',
    semantic_key: '',
    core: false,
    valid_from: null,
    valid_until: null,
    time_precision: 'unknown',
    successor_id: null,
    suppression_id: null,
    action: 'correct',
    reason: '',
    retracted: false,
    effective: true,
    evidence: [],
    title: 'Project memory',
    content: 'Saved by another writer',
    revision: 2,
    author: 'user',
    source_seq: null,
    updated_at: '2026-10-24T00:00:00Z',
  }
  const body = {
    code: 'memory_conflict',
    message: '记忆已被修改',
    request_id: '28a6945e-f488-436c-a5b5-20b30496a437',
    current_revision: 2,
    current,
  }
  const conflict = HttpErrors.find((schema) => Schema.decodeUnknownSync(schema)(body).status === 409)!
  expect(Schema.encodeSync(conflict)(Schema.decodeUnknownSync(conflict)(body))).toEqual(body)
})
