import { readFile, realpath } from 'node:fs/promises'
import { resolve, relative, extname, isAbsolute } from 'node:path'
import { Cause, Effect, Layer } from 'effect'
import { HttpRouter, HttpServer } from 'effect/http'
import * as Request from 'effect/http/HttpServerRequest'
import * as Response from 'effect/http/HttpServerResponse'
import * as SqlClient from 'effect/sql/SqlClient'
import { HttpApiBuilder } from 'effect/http-api'
import { BatonHttpApi, httpOpenApi } from '@baton/protocol/http-api'
import { Schema } from 'effect'
import { traceFromHeaders, withTraceSpan } from '@baton/telemetry'
import { UUID } from '@baton/protocol'
import * as Nodes from './nodes.ts'
import * as Threads from './threads.ts'
import * as Projects from './projects.ts'
import { AppError } from './errors.ts'
import type { Gateway } from './gateway.ts'
import type { CredentialSigner } from './nodes.ts'
import { httpHandlers } from './http-handlers.ts'
import {
  authorizeBrowser,
  checkOrigin,
  HttpRequestId,
  httpFailure,
  httpSecurity,
  newRequestId,
} from './http-security.ts'
export { cookieToken } from './http-security.ts'

export interface HTTPOptions {
  readonly allowedOrigins: ReadonlyArray<string>
  readonly signer: CredentialSigner
  readonly sessionTTLSeconds?: number
  readonly enrollmentTTLSeconds?: number
  readonly nodeCredentialTTLSeconds?: number
  readonly webDirectory?: string
  readonly gateway: () => Gateway
}

const json = (value: unknown, status = 200) =>
  Response.jsonUnsafe(value, { status, headers: { 'cache-control': 'no-store' } })
const notFound = () => Effect.fail(new AppError(404, 'not_found'))
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
}

const staticResponse = (options: HTTPOptions) =>
  Effect.gen(function* () {
    const request = yield* Request.HttpServerRequest
    const path = new URL(request.url, 'http://localhost').pathname
    if ((request.method !== 'GET' && request.method !== 'HEAD') || !options.webDirectory) return yield* notFound()
    return yield* Effect.tryPromise({
      try: async () => {
        const root = await realpath(options.webDirectory!)
        let file = resolve(root, path === '/' ? 'index.html' : '.' + decodeURIComponent(path))
        const inside = (target: string) => {
          const rel = relative(root, target)
          return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)
        }
        if (!inside(file)) throw new AppError(404, 'not_found')
        try {
          file = await realpath(file)
        } catch {
          if (extname(file) || path.startsWith('/assets/')) throw new AppError(404, 'not_found')
          file = await realpath(resolve(root, 'index.html'))
        }
        if (!inside(file)) throw new AppError(404, 'not_found')
        const content = await readFile(file)
        return Response.uint8Array(request.method === 'HEAD' ? new Uint8Array() : content, {
          headers: {
            'content-type': mime[extname(file)] ?? 'application/octet-stream',
            'cache-control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
            'x-content-type-options': 'nosniff',
          },
        })
      },
      catch: (error) => (error instanceof AppError ? error : new AppError(404, 'not_found')),
    })
  })

// Unknown API routes retain authentication and resource ownership checks.
const missingRoute = Effect.gen(function* () {
  const request = yield* Request.HttpServerRequest
  const path = new URL(request.url, 'http://localhost').pathname
  const session = yield* authorizeBrowser(false)
  const segments = path.split('/')
  if (segments[1] === 'api' && segments[2] === 'v1') {
    if (segments[3] === 'projects' && segments[4]) {
      const projectId = yield* Schema.decodeUnknownEffect(UUID)(segments[4]).pipe(
        Effect.mapError(() => new AppError(400, 'invalid_request', '请求格式无效')),
      )
      yield* Projects.getProject(session.employee.id, projectId)
    }
    if (
      segments[3] === 'threads' &&
      segments[4] &&
      (segments.length === 5 ||
        (['timeline', 'messages', 'stop', 'resume', 'archive', 'model', 'output', 'history', 'trace'].includes(
          segments[5],
        ) &&
          (segments.length === 6 || (segments.length === 8 && segments[6] && segments[7] === 'withdraw'))))
    ) {
      const threadId = yield* Schema.decodeUnknownEffect(UUID)(segments[4]).pipe(
        Effect.mapError(() => new AppError(400, 'invalid_request', '请求格式无效')),
      )
      yield* Threads.view(session.employee.id, threadId)
    }
    if (
      segments[3] === 'nodes' &&
      segments[4] &&
      (segments.length === 5 ||
        (segments.length === 6 && ['revoke', 'files', 'roots', 'project-exec'].includes(segments[5])) ||
        (segments.length === 7 && segments[5] === 'subscriptions' && segments[6] === 'login'))
    ) {
      const nodeId = yield* Schema.decodeUnknownEffect(UUID)(segments[4]).pipe(
        Effect.mapError(() => new AppError(400, 'invalid_request', '请求格式无效')),
      )
      yield* Nodes.getNode(session.employee.id, nodeId)
    }
  }
  return yield* notFound()
})

const contractRoutes: ReadonlyArray<{ method: string; path: string; segments: ReadonlyArray<string> }> = Object.values(
  BatonHttpApi.groups,
)
  .flatMap((group) => Object.values(group.endpoints))
  .map((endpoint) => ({
    method: endpoint.method,
    path: endpoint.path,
    segments: endpoint.path.split('/'),
  }))

export const httpRouteTemplate = (method: string, pathname: string): string => {
  if (method === 'GET' && pathname === '/api/v1/openapi.json') return '/api/v1/openapi.json'
  const segments = pathname.split('/')
  return (
    contractRoutes.find(
      (route) =>
        route.method === method &&
        route.segments.length === segments.length &&
        route.segments.every((part, index) =>
          part.startsWith(':') ? Boolean(segments[index]) : part === segments[index],
        ),
    )?.path ?? (pathname.startsWith('/api/') ? '/api/*' : '/*')
  )
}

/** Builds routes once in the server scope; each request retains its own security context. */
export const httpApplication = (options: HTTPOptions) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<SqlClient.SqlClient>()
    const routes = HttpApiBuilder.layer(BatonHttpApi).pipe(
      Layer.provide(httpHandlers(options)),
      Layer.provide(httpSecurity()),
      Layer.provide(Layer.succeedContext(services)),
      Layer.provide(HttpServer.layerServices),
    )
    const router = yield* HttpRouter.toHttpEffect(routes).pipe(
      Effect.provideService(HttpRouter.RouterConfig, {
        ignoreDuplicateSlashes: false,
        ignoreTrailingSlash: false,
        caseSensitive: true,
        maxParamLength: 16 * 1024,
      }),
    )
    return Effect.gen(function* () {
      const request = yield* Request.HttpServerRequest
      const path = new URL(request.url, 'http://localhost').pathname
      const requestId = newRequestId()
      const operation = Effect.gen(function* () {
        if (!path.startsWith('/api/')) return yield* staticResponse(options)
        yield* checkOrigin(options)
        if (path === '/api/v1/openapi.json' && request.method === 'GET') {
          yield* authorizeBrowser(false)
          return json(httpOpenApi())
        }
        if (request.method === 'HEAD' || path.endsWith('/') || path.includes('//')) return yield* missingRoute
        return yield* router.pipe(
          Effect.catchTag('HttpServerError', (error) =>
            error.reason._tag === 'RouteNotFound' ? missingRoute : Effect.fail(new AppError(503, 'unavailable')),
          ),
          Effect.map((response) => Response.setHeader(response, 'cache-control', 'no-store')),
        )
      })
      return yield* withTraceSpan(operation, 'baton.http.request', traceFromHeaders(request.headers), {
        kind: 'server',
        attributes: { 'http.request.method': request.method, 'http.route': httpRouteTemplate(request.method, path) },
      }).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
          const { status, ...body } = httpFailure(Cause.squash(cause), requestId)
          return Effect.succeed(json(body, status))
        }),
        Effect.provideService(HttpRequestId, requestId),
      )
    })
  })
