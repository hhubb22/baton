import { readFile, realpath } from 'node:fs/promises'
import { resolve, relative, extname, isAbsolute, sep } from 'node:path'
import { Cause, Effect, Exit, Layer, Option, Schema } from 'effect'
import { NodeHttpPlatform } from '@effect/platform-node'
import { HttpRouter, HttpServer } from 'effect/http'
import * as Incoming from 'effect/http/HttpIncomingMessage'
import * as ByteSize from 'effect/ByteSize'
import * as Request from 'effect/http/HttpServerRequest'
import * as Response from 'effect/http/HttpServerResponse'
import * as SqlClient from 'effect/sql/SqlClient'
import { HttpApiBuilder } from 'effect/http-api'
import { BatonHttpApi, httpOpenApi } from '@baton/protocol/http-api'
import { BUILD } from '@baton/protocol/release.mjs'
import { createLogger } from '@baton/logging'
import { RuntimeMode, UUID } from '@baton/protocol'
import { createDownloads } from '../downloads.ts'
import * as Nodes from '../nodes.ts'
import * as Threads from '../threads/index.ts'
import * as Projects from '../project/projects.ts'
import { AppError } from '../errors.ts'
import type { HTTPOptions } from './options.ts'
import { httpHandlers } from './handlers.ts'
import { authorizeBrowser, checkOrigin, HttpRequestId, httpFailure, httpSecurity, newRequestId } from './security.ts'
import { isLoginRequest, LoginRateError } from './login-protection.ts'
import { loginClientIp } from './login-ip.ts'
import { LoginInput } from '@baton/protocol'
import { DeviceLoginProtection, DeviceLoginRateError, isDeviceLoginCreateRequest } from './device-login-protection.ts'
export { cookieToken } from './security.ts'

const log = createLogger('baton-server')

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
        // relative() 在 Windows 上用反斜杠分隔，只比对 "../" 会漏判逃逸。
        const inside = (target: string) => {
          const rel = relative(root, target)
          return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
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
      yield* Threads.view({ employeeId: session.employee.id }, threadId)
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
    const deviceLoginProtection = new DeviceLoginProtection()
    const downloads = options.downloads
      ? yield* Effect.acquireRelease(
          Effect.tryPromise(() => createDownloads(options.downloads!, options.allowedOrigins)),
          (owned) => Effect.promise(() => owned.close()),
        )
      : undefined
    const routes = HttpApiBuilder.layer(BatonHttpApi).pipe(
      Layer.provide(httpHandlers(options, downloads)),
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
      const requestId = newRequestId(request.headers['x-request-id'])
      const started = Date.now()
      const operation = Effect.gen(function* () {
        if (isDeviceLoginCreateRequest(request.method, request.url)) {
          const ip =
            loginClientIp(
              Option.getOrUndefined(request.peerAddress),
              request.headers['x-forwarded-for'],
              options.trustedProxies,
            ) ?? 'unknown'
          yield* Effect.tryPromise({ try: () => deviceLoginProtection.checkIP(ip), catch: (error) => error })
        }
        if (isLoginRequest(request.method, request.url)) {
          const ip =
            loginClientIp(
              Option.getOrUndefined(request.peerAddress),
              request.headers['x-forwarded-for'],
              options.trustedProxies,
            ) ?? 'unknown'
          yield* Effect.tryPromise({ try: () => options.loginProtection.checkIP(ip), catch: (error) => error })
          yield* checkOrigin(options)
          if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? ''))
            return yield* Effect.fail(new AppError(415, 'json_required'))
          const text = yield* request.text.pipe(
            Effect.provideService(Incoming.MaxBodySize, ByteSize.kibibytes(8)),
            Effect.mapError(() => new AppError(413, 'payload_too_large')),
          )
          if (Buffer.byteLength(text, 'utf8') > 8192) return yield* Effect.fail(new AppError(413, 'payload_too_large'))
          const body = yield* Effect.try({
            try: () => JSON.parse(text) as unknown,
            catch: () => new AppError(400, 'invalid_json'),
          })
          const payload = yield* Schema.decodeUnknownEffect(LoginInput)(body).pipe(
            Effect.mapError(() => new AppError(400, 'invalid_request', '请求格式无效')),
          )
          yield* Effect.tryPromise({
            try: () => options.loginProtection.checkAccount(payload.username),
            catch: (error) => error,
          })
        }
        if (path.startsWith('/downloads/')) {
          if (request.method !== 'GET' || !downloads) return yield* notFound()
          const asset = yield* Effect.tryPromise({
            try: () => downloads.file(request.headers.host ?? '', path.slice('/downloads/'.length)),
            catch: () => new AppError(404, 'not_found'),
          })
          if (!asset) return yield* notFound()
          return yield* Response.file(asset.path, {
            contentType: 'application/octet-stream',
            headers: {
              'content-length': String(asset.item.size),
              'content-disposition': `attachment; filename="${asset.item.file}"`,
              'cache-control': 'no-cache',
              'x-content-type-options': 'nosniff',
            },
          }).pipe(
            Effect.provide(NodeHttpPlatform.layer),
            Effect.mapError(() => new AppError(404, 'not_found')),
          )
        }
        if (!path.startsWith('/api/')) return yield* staticResponse(options)
        yield* checkOrigin(options)
        if (path === '/api/v1/openapi.json' && request.method === 'GET') {
          yield* authorizeBrowser(false)
          return json(httpOpenApi())
        }
        if (request.method === 'HEAD' || path.endsWith('/') || path.includes('//')) return yield* missingRoute
        const createThread = request.method === 'POST' && path === '/api/v1/threads'
        const changeThread =
          /\x2fapi\x2fv1\x2fthreads\x2f[^/]+\x2f(messages|settings|resume)$/.test(path) &&
          (request.method === 'POST' || request.method === 'PATCH')
        if (
          (createThread || changeThread) &&
          /^application\x2fjson(?:;|$)/i.test(request.headers['content-type'] ?? '')
        ) {
          yield* authorizeBrowser(false)
          const body = yield* request.json.pipe(
            Effect.provideService(Incoming.MaxBodySize, ByteSize.kibibytes(512)),
            Effect.mapError(() => new AppError(400, 'invalid_json')),
          )
          if (
            body &&
            typeof body === 'object' &&
            'runtime_mode' in body &&
            (changeThread || !Schema.is(RuntimeMode)(body.runtime_mode))
          )
            return yield* Effect.fail(new AppError(422, 'invalid', '执行模式无效或不可修改'))
        }
        return yield* router.pipe(
          Effect.catchTag('HttpServerError', (error) =>
            error.reason._tag === 'RouteNotFound' ? missingRoute : Effect.fail(new AppError(503, 'unavailable')),
          ),
          Effect.map((response) => Response.setHeader(response, 'cache-control', 'no-store')),
        )
      }).pipe(Effect.provideService(HttpRequestId, requestId))
      const result = yield* Effect.exit(operation)
      let response: Response.HttpServerResponse
      let errorCode: string | undefined
      if (Exit.isSuccess(result)) response = result.value
      else {
        if (Cause.hasInterrupts(result.cause)) return yield* Effect.failCause(result.cause)
        const error = Cause.squash(result.cause)
        const { status, code, ...body } = httpFailure(error, requestId)
        errorCode = code
        const failure = json({ code, ...body }, status)
        response =
          error instanceof LoginRateError || error instanceof DeviceLoginRateError
            ? Response.setHeader(failure, 'retry-after', String(error.retryAfter))
            : failure
      }
      response = Response.setHeader(
        Response.setHeader(response, 'x-request-id', requestId),
        'x-baton-version',
        BUILD.version,
      )
      if (path.startsWith('/api/')) {
        const fields = {
          request_id: requestId,
          method: request.method,
          route: httpRouteTemplate(request.method, path),
          status: response.status,
          duration_ms: Date.now() - started,
          ...(errorCode ? { error_code: errorCode } : {}),
        }
        if (response.status >= 500) log.error('http.request', fields)
        else if (response.status >= 400) log.warn('http.request', fields)
        else log.info('http.request', fields)
      }
      return response
    })
  })
