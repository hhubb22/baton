import { trace } from '@opentelemetry/api'
import Rum from '@hyperdx/otel-web'
import { expect, it, vi } from 'vite-plus/test'

vi.mock(
  '@opentelemetry/exporter-trace-otlp-http',
  async () => import('@opentelemetry/exporter-trace-otlp-http/build/esm/platform/browser/OTLPTraceExporter.js'),
)

it('stops recording after the real browser trace exporter receives 404', async () => {
  const { startTelemetry, stopTelemetry } = await import('./index')
  const requests: Array<{ url: string; headers: Headers }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      requests.push({ url, headers: new Headers(init?.headers) })
      return new Response('{}', { status: url.endsWith('/v1/traces') ? 404 : 200 })
    }),
  )
  try {
    startTelemetry({ session_replay: 'masked' }, () => 'csrf-value')
    trace.getTracer('test').startSpan('baton.web.exception').end()
    await Rum.provider!.forceFlush().catch(() => {})
    await vi.waitFor(() => expect(Rum.inited).toBe(false))
    const traces = requests.find((request) => request.url.endsWith('/api/v1/telemetry/v1/traces'))
    expect(traces?.headers.get('x-csrf-token')).toBe('csrf-value')
    expect(traces?.headers.has('authorization')).toBe(false)
    window.dispatchEvent(new Event('unload'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    const before = requests.length
    document.body.append(document.createTextNode('after-stop'))
    window.dispatchEvent(new Event('unload'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(requests.length).toBe(before)
  } finally {
    stopTelemetry()
    vi.unstubAllGlobals()
  }
})

it('ignores a delayed 404 from a previous session', async () => {
  const { startTelemetry, stopTelemetry } = await import('./index')
  let release: ((response: Response) => void) | undefined
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
    ),
  )
  try {
    startTelemetry({}, () => 'old-csrf')
    trace.getTracer('test').startSpan('baton.web.exception').end()
    const oldFlush = Rum.provider!.forceFlush().catch(() => {})
    await vi.waitFor(() => expect(release).toBeDefined())
    stopTelemetry()
    startTelemetry({}, () => 'new-csrf')
    release!(new Response('{}', { status: 404 }))
    await oldFlush
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(Rum.inited).toBe(true)
  } finally {
    stopTelemetry()
    vi.unstubAllGlobals()
  }
})
