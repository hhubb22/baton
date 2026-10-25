import { randomUUID } from 'node:crypto'
import { Context, Effect, Layer, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as ByteSize from 'effect/ByteSize'
import { HttpApiError } from 'effect/http-api'
import { HttpRouter, HttpServerRequest } from 'effect/http'
import * as Incoming from 'effect/http/HttpIncomingMessage'
import {
  BrowserRequest,
  CurrentBrowserSession,
  HttpErrors,
  HttpErrorStatus,
  PublicRequest,
  type HttpFailure,
} from '@baton/protocol/http-api'
import { UUID } from '@baton/protocol'
import * as Auth from './auth.ts'
import * as Nodes from './nodes.ts'
import * as Threads from './threads.ts'
import * as Projects from './project/projects.ts'
import * as Inbox from './inbox.ts'
import { AppError } from './errors.ts'
import type { HTTPOptions } from './http/options.ts'

export const HttpRequestId = Context.Reference<string>('baton/http/RequestId', { defaultValue: () => randomUUID() })

export function cookieToken(cookie: string): string {
  const values = cookie
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('baton_session='))
  return values.length === 1 ? values[0].slice('baton_session='.length) : ''
}
const isHttpFailure = Schema.is(Schema.Union(HttpErrors))
export const httpFailure = (error: unknown, requestId: string): HttpFailure => {
  if (isHttpFailure(error)) return error
  const appError = HttpApiError.HttpApiSchemaError.is(error)
    ? new AppError(
        ['Body', 'ResponseHeaders'].includes(error.kind) ? 503 : 400,
        ['Body', 'ResponseHeaders'].includes(error.kind) ? 'unavailable' : 'invalid_request',
        '请求格式无效',
      )
    : error instanceof AppError
      ? error
      : new AppError(503, 'unavailable', '暂时无法处理请求')
  const status = Schema.is(HttpErrorStatus)(appError.status) ? appError.status : 503
  return {
    status,
    code: appError.code,
    message: appError.message,
    request_id: requestId,
    ...(status === 409 ? appError.details : {}),
    ...(status === 409 && appError.code === 'inbox_conflict' ? { error: appError.code } : {}),
  }
}
export const httpBusiness = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.catch((error) => Effect.flatMap(HttpRequestId, (id) => Effect.fail(httpFailure(error, id)))))
export const decodeResponse =
  <A>(schema: Schema.Decoder<A>) =>
  (value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError(() => new AppError(503, 'unavailable', '暂时无法处理请求')),
    )

export const checkOrigin = (options: HTTPOptions) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const path = new URL(request.url, 'http://localhost').pathname
    if (path === '/api/v1/nodes/register' && request.method === 'POST') return
    if (
      request.method !== 'GET' &&
      request.method !== 'HEAD' &&
      !options.allowedOrigins.includes(request.headers.origin ?? '')
    )
      return yield* Effect.fail(new AppError(403, 'origin_rejected'))
  })

export const authorizeBrowser = (allowPasswordChange: boolean) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const session = yield* Auth.lookupSession(cookieToken(request.headers.cookie ?? ''))
    if (
      request.method !== 'GET' &&
      request.method !== 'HEAD' &&
      !Auth.checkCSRF(session, request.headers['x-csrf-token'] ?? '')
    )
      return yield* Effect.fail(new AppError(403, 'csrf_rejected'))
    if (!allowPasswordChange && session.employee.must_change_password)
      return yield* Effect.fail(new AppError(403, 'password_change_required'))
    return { employee: session.employee, csrf_token: session.csrf_token, expires_at: session.expires_at }
  })

const checkJson = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? ''))
    return yield* Effect.fail(new AppError(415, 'json_required'))
  yield* request.json.pipe(
    Effect.provideService(Incoming.MaxBodySize, ByteSize.kibibytes(512)),
    Effect.mapError(() => new AppError(400, 'invalid_json')),
  )
})

export const httpSecurity = () =>
  Layer.mergeAll(
    Layer.succeed(
      PublicRequest,
      PublicRequest.of((effect, { endpoint }) =>
        httpBusiness(
          Effect.gen(function* () {
            if (endpoint.payload.size > 0) yield* checkJson
            return yield* effect
          }),
        ),
      ),
    ),
    Layer.effect(
      BrowserRequest,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return BrowserRequest.of({
          session: (effect, { endpoint, group }) =>
            Effect.flatMap(
              httpBusiness(
                Effect.gen(function* () {
                  const session = yield* authorizeBrowser(group.identifier === 'account')
                  const { params } = yield* HttpRouter.RouteContext
                  if (endpoint.params && ('nodeId' in params || 'threadId' in params)) {
                    const id = yield* Schema.decodeUnknownEffect(UUID)(params.nodeId ?? params.threadId).pipe(
                      Effect.mapError(() => new AppError(400, 'invalid_request', '请求格式无效')),
                    )
                    if ('nodeId' in params) yield* Nodes.getNode(session.employee.id, id)
                    else yield* Threads.view(session.employee.id, id)
                  }
                  if (endpoint.params && 'projectId' in params) {
                    const id = yield* Schema.decodeUnknownEffect(UUID)(params.projectId).pipe(
                      Effect.mapError(() => new AppError(400, 'invalid_request', '请求格式无效')),
                    )
                    yield* Projects.getProject(session.employee.id, id)
                  }
                  if (endpoint.params && 'requestId' in params) {
                    const id = yield* Schema.decodeUnknownEffect(UUID)(params.requestId).pipe(
                      Effect.mapError(() => new AppError(400, 'invalid_request', '请求格式无效')),
                    )
                    yield* Inbox.getAttentionRequest(session.employee.id, id)
                  }
                  if (endpoint.payload.size > 0) yield* checkJson
                  const seen = new Set<string>()
                  const request = yield* HttpServerRequest.HttpServerRequest
                  for (const key of new URL(request.url, 'http://localhost').searchParams.keys()) {
                    if (!endpoint.query || seen.has(key)) return yield* Effect.fail(new AppError(400, 'invalid_query'))
                    seen.add(key)
                  }
                  return session
                }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
              ),
              (session) => Effect.provideService(effect, CurrentBrowserSession, session),
            ),
        })
      }),
    ),
  )

export const newRequestId = () => randomUUID()
