import { createServer } from 'node:http'
import { Effect, Exit, Metric, Option, Tracer } from 'effect'
import { expect, it, vi } from 'vite-plus/test'
import * as Statement from 'effect/sql/Statement'
import { BUILD } from '@baton/protocol/release.mjs'
import {
  captureTrace,
  decodeTrace,
  telemetryLayer,
  traceFromHeaders,
  tracePromise,
  withTraceSpan,
} from '../src/index.ts'

it('continues W3C context and sampling across independent runtimes', async () => {
  const spans: Tracer.NativeSpan[] = []
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    },
  })
  const incoming = { traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-00`, tracestate: 'vendor=opaque' }
  const queued = await Effect.runPromise(
    withTraceSpan(captureTrace, 'baton.enqueue', incoming).pipe(Effect.provideService(Tracer.Tracer, tracer)),
  )
  const delivered = await tracePromise(tracer, 'baton.dispatch', queued, async (trace) => trace)
  await Effect.runPromise(
    withTraceSpan(Effect.void, 'baton.execute', delivered).pipe(Effect.provideService(Tracer.Tracer, tracer)),
  )
  expect(spans).toHaveLength(3)
  expect(spans.map((span) => span.traceId)).toEqual(Array(3).fill('a'.repeat(32)))
  expect(spans.every((span) => !span.sampled)).toBe(true)
  expect(Option.getOrUndefined(spans[1]!.parent)?.spanId).toBe(spans[0]!.spanId)
  expect(Option.getOrUndefined(spans[2]!.parent)?.spanId).toBe(spans[1]!.spanId)
  expect(delivered?.tracestate).toBe(incoming.tracestate)
  expect(traceFromHeaders({ traceparent: 'bad' })).toBeUndefined()
  expect(decodeTrace({ traceparent: `00-${'0'.repeat(32)}-${'b'.repeat(16)}-01` })).toBeUndefined()
  expect(decodeTrace({ ...incoming, tracestate: 'a\r\nb' })).toBeUndefined()
})

it('exports to a local OTLP capture endpoint on scope release and redacts automatic errors and SQL attributes', async () => {
  const payloads: string[] = []
  const server = createServer((request, response) => {
    let text = ''
    request.on('data', (chunk) => {
      text += String(chunk)
    })
    request.on('end', () => {
      payloads.push(text)
      response.writeHead(200).end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  try {
    const error = new Error('secret prompt credential SQL parameter')
    const result = await Effect.runPromise(
      Effect.exit(
        withTraceSpan(
          Effect.gen(function* () {
            yield* withTraceSpan(
              Effect.gen(function* () {
                const span = yield* Effect.currentSpan
                span.event('effect.sql.transaction.commit', BigInt(Date.now()) * 1_000_000n, { token: 'secret' })
                span.event('effect.sql.transaction.secret', BigInt(Date.now()) * 1_000_000n)
                span.event('exception', BigInt(Date.now()) * 1_000_000n, { message: 'secret' })
                expect(yield* Statement.SpanPropagationEnabled).toBe(true)
                yield* withTraceSpan(Effect.void, 'sql.connection.wait', undefined, {
                  attributes: { 'db.client.connection.wait_time_ms': 12.5 },
                })
              }),
              'sql.execute',
              undefined,
              { attributes: { 'db.query.text': 'secret initial SQL', 'db.operation.name': 'SELECT' } },
            )
            yield* Effect.annotateCurrentSpan({
              'db.query.text': 'secret SQL parameter',
              'baton.command.id': 'command',
            })
            yield* withTraceSpan(Effect.void, 'baton.usage.missing', undefined, {
              attributes: {
                'baton.usage.reported': false,
                'gen_ai.usage.input_tokens': 0,
                'gen_ai.request.model': 'custom-invalid-model',
              },
            })
            yield* withTraceSpan(Effect.void, 'baton.usage.zero', undefined, {
              attributes: {
                'baton.usage.reported': true,
                'gen_ai.usage.input_tokens': 0,
              },
            })
            yield* Effect.log('secret body /private/path')
            yield* Effect.log('baton.wait.start').pipe(
              Effect.annotateLogs({ 'baton.wait.reason': 'queue', secret: 'secret annotation' }),
            )
            yield* Metric.update(
              Metric.gauge('baton.workers.active', {
                description: 'secret description',
                attributes: { 'baton.agent': 'codex', 'baton.thread.id': 'secret thread', secret: 'secret label' },
              }),
              1,
            )
            yield* Effect.sleep('200 millis')
            return yield* Effect.fail(error)
          }),
          'baton.failure',
        ),
      ).pipe(
        Effect.provide(
          telemetryLayer('test-worker', {
            OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${address.port}`,
            OTEL_RESOURCE_ATTRIBUTES:
              'deployment.environment.name=test,secret=secret-resource,service.version=spoof,vcs.ref.head.revision=spoof,baton.node.id=spoof',
            OTEL_SERVICE_VERSION: 'spoof',
            BATON_TELEMETRY_NODE_ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            OTEL_BLRP_SCHEDULE_DELAY: '30',
            OTEL_METRIC_EXPORT_INTERVAL: '30',
          }),
        ),
      ),
    )
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) expect(result.cause.reasons[0]).toMatchObject({ error })
    const raw = payloads.join('')
    expect(raw).not.toContain('secret')
    expect(raw).not.toContain('db.query.text')
    const payload = payloads.map((body) => JSON.parse(body)).find((body) => body.resourceSpans)
    expect(payload).toBeDefined()
    const logs = payloads.map((body) => JSON.parse(body)).find((body) => body.resourceLogs)
    expect(logs.resourceLogs[0].scopeLogs[0].logRecords.map((record: { body: unknown }) => record.body)).toEqual([
      { stringValue: 'baton.wait.start' },
    ])
    const metrics = payloads.map((body) => JSON.parse(body)).find((body) => body.resourceMetrics)
    expect(metrics.resourceMetrics[0].scopeMetrics[0].metrics[0].gauge.dataPoints[0].attributes).toEqual([
      { key: 'baton.agent', value: { stringValue: 'codex' } },
    ])
    const resource = payload.resourceSpans[0]
    for (const signalResource of [resource, logs.resourceLogs[0], metrics.resourceMetrics[0]]) {
      expect(signalResource.resource.attributes).toContainEqual({
        key: 'baton.node.id',
        value: { stringValue: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
      })
      expect(signalResource.resource.attributes).toContainEqual({
        key: 'service.version',
        value: { stringValue: BUILD.version },
      })
      expect(signalResource.resource.attributes).toContainEqual({
        key: 'vcs.ref.head.revision',
        value: { stringValue: BUILD.commit },
      })
    }
    expect(resource.resource.attributes).toContainEqual({ key: 'service.name', value: { stringValue: 'test-worker' } })
    expect(resource.resource.attributes).toContainEqual({
      key: 'deployment.environment.name',
      value: { stringValue: 'test' },
    })
    const spans = resource.scopeSpans[0].spans
    const missing = spans.find((span: { name: string }) => span.name === 'baton.usage.missing')
    expect(missing.attributes).not.toContainEqual({ key: 'gen_ai.usage.input_tokens', value: { intValue: 0 } })
    expect(missing.attributes).toContainEqual({
      key: 'gen_ai.request.model',
      value: { stringValue: 'custom-invalid-model' },
    })
    const zero = spans.find((span: { name: string }) => span.name === 'baton.usage.zero')
    expect(zero.attributes).toContainEqual({ key: 'gen_ai.usage.input_tokens', value: { intValue: 0 } })
    const wait = spans.find((span: { name: string }) => span.name === 'sql.connection.wait')
    expect(wait.attributes).toEqual([{ key: 'db.client.connection.wait_time_ms', value: { doubleValue: 12.5 } }])
    const sql = spans.find((span: { name: string }) => span.name === 'sql.execute')
    expect(sql.attributes).toEqual([{ key: 'db.operation.name', value: { stringValue: 'SELECT' } }])
    expect(sql.events.map((event: { name: string }) => event.name)).toEqual(['effect.sql.transaction.commit'])
    const span = spans.find((span: { name: string }) => span.name === 'baton.failure')
    expect(span.name).toBe('baton.failure')
    expect(span.status.code).toBe(2)
    expect(span.attributes).toContainEqual({ key: 'baton.command.id', value: { stringValue: 'command' } })
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it('has no default network exporter and bounds shutdown when a local collector never answers', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
  try {
    await expect(
      Effect.runPromise(
        withTraceSpan(Effect.succeed(42), 'baton.default').pipe(Effect.provide(telemetryLayer('default', {}))),
      ),
    ).resolves.toBe(42)
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    fetch.mockRestore()
  }
  const server = createServer(() => {})
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  try {
    const started = performance.now()
    const value = await Effect.runPromise(
      withTraceSpan(Effect.succeed('business result'), 'baton.success').pipe(
        Effect.provide(
          telemetryLayer('test-worker', {
            OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${address.port}/v1/traces`,
            OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: '50',
          }),
        ),
      ),
    )
    expect(value).toBe('business result')
    expect(performance.now() - started).toBeLessThan(1000)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it('bounds exports and aborts stalled headers and bodies while the application keeps running', async () => {
  let received = 0
  let active = 0
  let maxActive = 0
  const server = createServer((request, response) => {
    request.resume()
    received++
    active++
    maxActive = Math.max(maxActive, active)
    response.on('close', () => active--)
    if (received === 1) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        for (let index = 0; index < 2; index++) yield* withTraceSpan(Effect.void, 'baton.export')
        yield* Effect.promise(() => vi.waitFor(() => expect(received).toBe(2), { timeout: 1500 }))
        for (let index = 0; index < 8; index++) yield* withTraceSpan(Effect.void, 'baton.export')
        yield* Effect.promise(() => vi.waitFor(() => expect(active).toBe(0), { timeout: 1500 }))
        expect(maxActive).toBeLessThanOrEqual(2)
        expect(received).toBe(2)
        return 'application still running'
      }).pipe(
        Effect.provide(
          telemetryLayer('running-worker', {
            OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${address.port}/v1/traces`,
            OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: '200',
            OTEL_BSP_MAX_EXPORT_BATCH_SIZE: '1',
          }),
        ),
      ),
    )
    expect(result).toBe('application still running')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it('preserves thrown values across the Promise boundary', async () => {
  const failure = new Error('private failure')
  await expect(
    tracePromise(undefined, 'baton.fail', undefined, async () => {
      throw failure
    }),
  ).rejects.toBe(failure)
})

it('drops failed exports without retrying or changing the application result', async () => {
  let requests = 0
  const server = createServer((request, response) => {
    request.resume()
    requests++
    response.writeHead(503).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  try {
    const result = await Effect.runPromise(
      withTraceSpan(Effect.succeed('ok'), 'baton.test').pipe(
        Effect.provide(
          telemetryLayer('test', {
            OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${address.port}/v1/traces`,
          }),
        ),
      ),
    )
    expect(result).toBe('ok')
    expect(requests).toBe(1)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it('shares export capacity and resumes after the pause across signals', async () => {
  let now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  const paths: string[] = []
  const pending: Array<import('node:http').ServerResponse> = []
  const server = createServer((request, response) => {
    request.resume()
    paths.push(request.url!)
    if (paths.length <= 2) pending.push(response)
    else response.writeHead(200).end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* withTraceSpan(Effect.void, 'baton.first')
        yield* Effect.log('baton.wait.start')
        yield* Effect.promise(() => vi.waitFor(() => expect(paths).toHaveLength(2)))
        yield* Metric.update(Metric.gauge('baton.nodes.online'), 1)
        yield* Effect.sleep('100 millis')
        expect(paths).toHaveLength(2)
        for (const response of pending) response.writeHead(200).end('{}')
        yield* withTraceSpan(Effect.void, 'baton.during.pause')
        yield* Effect.sleep('100 millis')
        expect(paths).toHaveLength(2)
        now += 61_000
        yield* Effect.sleep('100 millis')
        yield* withTraceSpan(Effect.void, 'baton.after.pause')
        yield* Effect.promise(() => vi.waitFor(() => expect(paths.length).toBeGreaterThan(2)))
      }).pipe(
        Effect.provide(
          telemetryLayer('test', {
            OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${address.port}`,
            OTEL_BSP_MAX_EXPORT_BATCH_SIZE: '1',
            OTEL_BLRP_MAX_EXPORT_BATCH_SIZE: '1',
            OTEL_METRIC_EXPORT_INTERVAL: '30',
            OTEL_BSP_SCHEDULE_DELAY: '30',
            OTEL_BLRP_SCHEDULE_DELAY: '30',
          }),
        ),
      ),
    )
    expect(paths).toContain('/v1/traces')
    expect(paths).toContain('/v1/logs')
  } finally {
    clock.mockRestore()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
