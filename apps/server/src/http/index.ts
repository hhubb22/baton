import { readFile, realpath } from 'node:fs/promises'
import { resolve, relative, extname, isAbsolute, sep } from 'node:path'
import { Cause, Effect, Exit, Layer, Stream } from 'effect'
import { NodeHttpPlatform } from '@effect/platform-node'
import { HttpRouter, HttpServer } from 'effect/http'
import * as Incoming from 'effect/http/HttpIncomingMessage'
import * as ByteSize from 'effect/ByteSize'
import * as Request from 'effect/http/HttpServerRequest'
import * as Response from 'effect/http/HttpServerResponse'
import * as SqlClient from 'effect/sql/SqlClient'
import { HttpApiBuilder } from 'effect/http-api'
import { BatonHttpApi, httpOpenApi } from '@baton/protocol/http-api'
import { Schema } from 'effect'
import { captureTrace, traceFromHeaders, withTraceSpan } from '@baton/telemetry'
import { RuntimeMode, UUID } from '@baton/protocol'
import { createDownloads } from '../downloads.ts'
import * as Nodes from '../nodes.ts'
import * as Threads from '../threads/index.ts'
import * as Projects from '../project/projects.ts'
import { AppError } from '../errors.ts'
import type { HTTPOptions } from './options.ts'
import { httpHandlers } from './handlers.ts'
import { authorizeBrowser, checkOrigin, HttpRequestId, httpFailure, httpSecurity, newRequestId } from './security.ts'
import { telemetryForwardEnabled } from '../telemetry-forward-client.ts'
import { decodeReplayProtobuf } from '@baton/telemetry/protobuf'
export { cookieToken } from './security.ts'

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
      const requestId = newRequestId()
      const operation = Effect.gen(function* () {
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
        if (
          request.method === 'POST' &&
          (path === '/api/v1/telemetry/v1/traces' || path === '/api/v1/telemetry/v1/logs')
        ) {
          if (!telemetryForwardEnabled(options.telemetryEnv) || !options.forwardTelemetry) return yield* notFound()
          const signal = path.endsWith('/traces') ? 'traces' : 'logs'
          const session = yield* authorizeBrowser(false, signal === 'traces')
          const chunks = yield* Stream.runFoldEffect(
            request.stream,
            () => ({ size: 0, chunks: [] as Uint8Array[] }),
            (acc, chunk) => {
              const size = acc.size + chunk.byteLength
              return size > 1024 * 1024
                ? Effect.fail(new AppError(413, 'payload_too_large'))
                : Effect.succeed({ size, chunks: [...acc.chunks, chunk] })
            },
          )
          const bytes = Buffer.concat(chunks.chunks)
          const decoded = yield* Effect.try({
            try: () => {
              if (
                signal === 'logs' &&
                request.headers['content-encoding'] === 'gzip' &&
                /^application\/x-protobuf(?:;|$)/i.test(request.headers['content-type'] ?? '')
              )
                return decodeReplayProtobuf(bytes)
              if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? ''))
                throw new AppError(415, 'unsupported_media_type')
              return JSON.parse(bytes.toString('utf8')) as unknown
            },
            catch: (error) =>
              error instanceof AppError
                ? error
                : error instanceof RangeError ||
                    (error instanceof Error && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE')
                  ? new AppError(413, 'payload_too_large')
                  : new AppError(400, 'invalid_telemetry'),
          })
          options.forwardTelemetry(signal, decoded, session.employee.id)
          return json({})
        }
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
      })
      let responseTrace: string | undefined
      return yield* withTraceSpan(
        Effect.gen(function* () {
          responseTrace = (yield* captureTrace)?.traceparent
          const result = yield* Effect.exit(operation)
          if (Exit.isFailure(result)) {
            if (!Cause.hasInterrupts(result.cause)) {
              const failure = httpFailure(Cause.squash(result.cause), requestId)
              yield* Effect.annotateCurrentSpan({
                'http.response.status_code': failure.status,
                'baton.error.code': failure.code,
              })
            }
            return yield* Effect.failCause(result.cause)
          }
          yield* Effect.annotateCurrentSpan({ 'http.response.status_code': result.value.status })
          return result.value
        }),
        'baton.http.request',
        traceFromHeaders(request.headers),
        {
          kind: 'server',
          attributes: { 'http.request.method': request.method, 'http.route': httpRouteTemplate(request.method, path) },
        },
      ).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
          const { status, ...body } = httpFailure(Cause.squash(cause), requestId)
          return Effect.succeed(json(body, status))
        }),
        Effect.map((response) =>
          responseTrace ? Response.setHeader(response, 'traceresponse', responseTrace) : response,
        ),
        Effect.provideService(HttpRequestId, requestId),
      )
    })
  })
