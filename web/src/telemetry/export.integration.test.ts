import { gunzipSync } from 'node:zlib'
import { Reader } from 'protobufjs/minimal'
import { Replayer, type eventWithTime } from 'rrweb'
import { trace } from '@opentelemetry/api'
import Rum from '@hyperdx/otel-web'
import { expect, it, vi } from 'vite-plus/test'
import { startTelemetry, stopTelemetry, traceSocket } from './index'
import { decodeReplayProtobuf } from '@baton/telemetry/protobuf'
import { filterForward } from '@baton/telemetry/forward'

vi.mock(
  '@opentelemetry/exporter-trace-otlp-http',
  async () => import('@opentelemetry/exporter-trace-otlp-http/build/esm/platform/browser/OTLPTraceExporter.js'),
)

function protobufFields(bytes: Uint8Array, path: readonly number[]): Uint8Array[] {
  const reader = Reader.create(bytes)
  const found: Uint8Array[] = []
  while (reader.pos < reader.len) {
    const tag = reader.uint32()
    if (tag >>> 3 === path[0] && (tag & 7) === 2) {
      const value = reader.bytes()
      found.push(...(path.length === 1 ? [value] : protobufFields(value, path.slice(1))))
    } else reader.skipType(tag & 7)
  }
  return found
}

it('filters serialized traces and masked replay, and stops collection on logout', async () => {
  const payloads: Array<{ url: string; body: Uint8Array }> = []
  const calls: Array<{ url: string; headers: Headers }> = []
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, headers: new Headers(init?.headers) })
    const body = init?.body
    if (url.includes('/api/v1/telemetry/') && ArrayBuffer.isView(body))
      payloads.push({ url, body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength) })
    else if (url.includes('/api/v1/telemetry/') && typeof body === 'string')
      payloads.push({ url, body: new TextEncoder().encode(body) })
    return new Response('{}', { status: 200 })
  })
  vi.stubGlobal('fetch', fetcher)
  const intervals = vi.spyOn(globalThis, 'setInterval')
  const element = document.createElement('div')
  element.innerHTML =
    '<div title="secret-title" data-private="secret-data">secret-text<input placeholder="secret-placeholder" value="secret-input"></div>'
  document.body.append(element)
  try {
    startTelemetry({ session_replay: 'masked' }, () => 'test-csrf')
    await fetch(`${window.location.origin}/api/v1/threads`, {
      method: 'POST',
      body: 'secret-body',
      headers: { authorization: 'secret-header' },
    })
    await fetch(`${window.location.origin}/other`, { method: 'GET' })
    expect(calls.find((call) => call.url.endsWith('/api/v1/threads'))?.headers.get('traceparent')).toMatch(/^00-/)
    expect(calls.find((call) => call.url.endsWith('/other'))?.headers.get('traceparent')).toBeNull()
    const span = trace.getTracer('private-scope').startSpan('secret-span')
    const socket = new EventTarget() as WebSocket
    traceSocket(socket)
    socket.dispatchEvent(new Event('open'))
    span.setAttribute('url.full', 'https://private.invalid/secret-path')
    span.setAttribute('http.request.method', 'GET')
    span.setAttribute('error.type', 'TypeError')
    span.addEvent('exception', { 'exception.message': 'secret-error' })
    span.end()
    window.dispatchEvent(
      new ErrorEvent('error', {
        error: new TypeError('secret-exception'),
        filename: '/private/secret.js',
        lineno: 10,
        colno: 2,
      }),
    )
    element.firstElementChild?.setAttribute('title', 'secret-mutated-title')
    element.append(document.createTextNode('secret-mutated-text'))
    await new Promise((resolve) => setTimeout(resolve, 400))
    await Rum.provider!.forceFlush()
    window.dispatchEvent(new Event('unload'))
    await vi.waitFor(() => expect(payloads.some((payload) => payload.url.endsWith('/v1/logs'))).toBe(true), {
      timeout: 7000,
    })
    expect(calls.map((call) => call.url)).toContain(`${window.location.origin}/api/v1/telemetry/v1/traces`)
    expect(payloads.some((payload) => payload.url.endsWith('/v1/traces'))).toBe(true)
    expect(
      calls
        .filter((call) => call.url.endsWith('/v1/traces'))
        .every(
          (call) =>
            call.url === `${window.location.origin}/api/v1/telemetry/v1/traces` &&
            call.headers.get('x-csrf-token') === 'test-csrf' &&
            !call.headers.has('authorization'),
        ),
    ).toBe(true)
    expect(
      calls
        .filter((call) => call.url.endsWith('/v1/logs'))
        .every(
          (call) =>
            call.url === `${window.location.origin}/api/v1/telemetry/v1/logs` && !call.headers.has('authorization'),
        ),
    ).toBe(true)
    const decoded = payloads
      .map(({ body }) => {
        try {
          return gunzipSync(body).toString('utf8')
        } catch {
          return new TextDecoder().decode(body)
        }
      })
      .join('\n')
    for (const secret of [
      'secret-title',
      'secret-data',
      'secret-text',
      'secret-placeholder',
      'secret-input',
      'secret-span',
      'secret-path',
      'secret-error',
      'secret-body',
      'secret-header',
      'secret-exception',
      'secret.js',
    ])
      expect(decoded).not.toContain(secret)
    expect(decoded).toContain('baton.web.request')
    expect(decoded).toContain('http.request.method')
    expect(decoded).toContain('POST')
    const traceBodies = payloads
      .filter((payload) => payload.url.endsWith('/v1/traces'))
      .map((payload) => JSON.parse(new TextDecoder().decode(payload.body)))
    const spans = traceBodies.flatMap((body) =>
      body.resourceSpans.flatMap(
        (resource: {
          scopeSpans: Array<{
            spans: Array<{
              traceId: string
              attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string } }>
            }>
          }>
        }) => resource.scopeSpans.flatMap((scope) => scope.spans),
      ),
    )
    const request = spans.find((candidate: { attributes: Array<{ key: string; value: { stringValue?: string } }> }) =>
      candidate.attributes.some(
        (attribute) => attribute.key === 'http.request.method' && attribute.value.stringValue === 'POST',
      ),
    )
    expect(request.traceId).toBe(
      calls
        .find((call) => call.url.endsWith('/api/v1/threads'))
        ?.headers.get('traceparent')
        ?.split('-')[1],
    )
    expect(request.attributes).toContainEqual({ key: 'http.response.status_code', value: { intValue: 200 } })
    const error = traceBodies
      .flatMap((body) =>
        body.resourceSpans.flatMap(
          (resource: {
            scopeSpans: Array<{
              spans: Array<{ name: string; status: { code: number }; attributes: Array<{ key: string }> }>
            }>
          }) => resource.scopeSpans.flatMap((scope) => scope.spans),
        ),
      )
      .find((candidate: { name: string }) => candidate.name === 'baton.web.exception')
    expect(error.status.code).toBe(2)
    expect(error.attributes.map((attribute: { key: string }) => attribute.key)).toEqual(['error.type'])
    const socketSpan = spans.find((candidate: { name: string }) => candidate.name === 'baton.web.socket')
    expect(socketSpan).toBeDefined()
    expect(socketSpan.traceId).not.toBe(request.traceId)
    expect(decoded).toContain('rr-web.event')
    const forwardedReplay = payloads
      .filter((payload) => payload.url.endsWith('/v1/logs'))
      .map(({ body }) =>
        filterForward('logs', decodeReplayProtobuf(body), { employeeId: '11111111-1111-4111-8111-111111111111' }),
      )
    expect(JSON.stringify(forwardedReplay)).toContain('rr-web.event')
    expect(JSON.stringify(forwardedReplay)).not.toContain('secret-')
    const events = payloads
      .filter((payload) => payload.url.endsWith('/v1/logs'))
      .flatMap(({ body }) =>
        protobufFields(gunzipSync(body), [1, 2, 2, 5, 1]).map((value) => JSON.parse(new TextDecoder().decode(value))),
      ) as Array<{ type: number; data: Record<string, unknown> }>
    const full = events.find((event) => event.type === 2)
    const mutation = events.find((event) => event.type === 3 && event.data.source === 0)
    expect(full).toBeDefined()
    expect(mutation).toBeDefined()
    const fullText = JSON.stringify(full)
    expect(fullText).toContain('display:block')
    expect(fullText).toContain('***********')
    expect(fullText).not.toContain('secret-')
    expect(JSON.stringify(mutation)).not.toContain('secret-')
    stopTelemetry()
    expect(Rum.inited).toBe(false)
    window.dispatchEvent(new Event('unload'))
    const logsBeforeLogoutMutation = payloads.filter((payload) => payload.url.endsWith('/v1/logs')).length
    element.append(document.createTextNode('secret-after-logout'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    window.dispatchEvent(new Event('unload'))
    expect(payloads.filter((payload) => payload.url.endsWith('/v1/logs'))).toHaveLength(logsBeforeLogoutMutation)
    expect(
      payloads
        .filter((payload) => payload.url.endsWith('/v1/logs'))
        .map(({ body }) => gunzipSync(body).toString('utf8'))
        .join(''),
    ).not.toContain('secret-after-logout')
    const replayer = new Replayer(events as eventWithTime[], {
      root: document.body,
      showWarning: false,
      UNSAFE_replayCanvas: true,
    })
    if (replayer.iframe.contentWindow) replayer.iframe.contentWindow.scrollTo = () => {}
    replayer.play()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(replayer.iframe.contentDocument?.body.textContent).not.toContain('secret')
    replayer.destroy()
    const before = payloads.length
    startTelemetry({ session_replay: 'masked' }, () => 'test-csrf')
    trace.getTracer('baton-web').startSpan('baton.web.exception').end()
    await Rum.provider!.forceFlush()
    expect(payloads.slice(before).some((payload) => payload.url.endsWith('/v1/traces'))).toBe(true)
    expect(intervals.mock.calls.filter((call) => call[1] === 1000)).toHaveLength(1)
    stopTelemetry()
    expect(Rum.inited).toBe(false)
  } finally {
    stopTelemetry()
    element.remove()
    intervals.mockRestore()
    vi.unstubAllGlobals()
  }
}, 10000)
