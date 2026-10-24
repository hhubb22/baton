import { expect, it } from 'vite-plus/test'
import { Schema } from 'effect'
import { BatonHttpApi, HttpErrors, httpOpenApi } from '../src/http-api.ts'

it('generates schemas, statuses and cookie security for every implemented HTTP endpoint', () => {
  const endpoints = Object.values(BatonHttpApi.groups).flatMap((group) => Object.values(group.endpoints))
  expect(endpoints).toHaveLength(49)
  const document = httpOpenApi()
  expect(document.info.title).toBe('Baton HTTP API')
  expect(document.paths['/api/v1/login']?.post?.requestBody).toMatchObject({ required: true })
  expect(document.paths['/api/v1/threads']?.post?.responses).toHaveProperty('201')
  expect(document.paths['/api/v1/threads/{threadId}/messages']?.post?.responses).toHaveProperty('202')
  expect(document.paths['/api/v1/logout']?.post?.responses).toHaveProperty('204')
  expect(document.paths['/api/v1/projects']?.post?.responses).toHaveProperty('201')
  expect(document.paths['/api/v1/projects/{projectId}/messages']?.post?.responses).toHaveProperty('202')
  expect(document.paths['/api/v1/attention-requests/{requestId}/answer']?.post?.responses).toHaveProperty('409')
  expect(document.paths['/api/v1/nodes/{nodeId}/roots']?.delete?.requestBody).toMatchObject({ required: true })
  expect(document.paths['/api/v1/nodes']?.get?.security).toEqual([{ session: [] }])
  expect(document.components.securitySchemes.session).toMatchObject({
    type: 'apiKey',
    in: 'cookie',
    name: 'baton_session',
  })
  expect(document.paths['/api/v1/node-enrollments']?.post?.responses).toHaveProperty('501')
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
