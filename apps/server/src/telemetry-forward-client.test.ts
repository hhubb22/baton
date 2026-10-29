import { afterEach, expect, it, vi } from 'vite-plus/test'
import { createServer, type ServerResponse } from 'node:http'
import { Effect } from 'effect'
import { telemetryLayer, withTraceSpan } from '@baton/telemetry'
import { makeTelemetryForwardClient, telemetryForwardEnabled } from './telemetry-forward-client.ts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('enables forwarding only with an endpoint and permits explicit opt-out', () => {
  expect(telemetryForwardEnabled({})).toBe(false)
  expect(telemetryForwardEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost' })).toBe(true)
  expect(telemetryForwardEnabled({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://localhost' })).toBe(true)
  expect(
    telemetryForwardEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost', BATON_TELEMETRY_FORWARD: 'off' }),
  ).toBe(false)
})

it('drops excess batches and pauses after a failed export', async () => {
  vi.useFakeTimers()
  const pending: Array<(response: Response) => void> = []
  const send = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((resolve) => pending.push(resolve)))
  const forward = makeTelemetryForwardClient({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' })
  for (let i = 0; i < 5; i++) forward('traces', {})
  expect(send).toHaveBeenCalledTimes(4)
  pending[0]!(new Response(null, { status: 500 }))
  await vi.advanceTimersByTimeAsync(0)
  forward('logs', {})
  expect(send).toHaveBeenCalledTimes(4)
  for (const resolve of pending.slice(1)) resolve(new Response(null, { status: 200 }))
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(60_001)
  forward('logs', {})
  expect(send).toHaveBeenCalledTimes(5)
  const sentUrl = send.mock.calls[4]![0]
  expect(sentUrl instanceof URL ? sentUrl.href : sentUrl).toBe('http://localhost:4318/v1/logs')
  pending[4]!(new Response(null, { status: 200 }))
  await vi.advanceTimersByTimeAsync(0)
})

it('uses per-signal settings and the shortest timeout for a shared endpoint', async () => {
  vi.useFakeTimers()
  const send = vi.spyOn(globalThis, 'fetch').mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      }),
  )
  const forward = makeTelemetryForwardClient({
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://localhost:4318/shared',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://localhost:4318/shared',
    OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: '2000',
    OTEL_EXPORTER_OTLP_LOGS_TIMEOUT: '1000',
    OTEL_EXPORTER_OTLP_HEADERS: 'authorization=local%2Dkey',
    OTEL_METRICS_EXPORTER: 'none',
  })
  forward('traces', {})
  await vi.advanceTimersByTimeAsync(0)
  expect(send).toHaveBeenCalledTimes(1)
  const options = send.mock.calls[0]![1]!
  expect(new Headers(options.headers).get('authorization')).toBe('local-key')
  expect(options.redirect).toBe('error')
  await vi.advanceTimersByTimeAsync(1001)
  expect(options.signal?.aborted).toBe(true)
  expect(forward.available()).toBe(false)
  await vi.advanceTimersByTimeAsync(60_001)
  expect(forward.available()).toBe(true)
})

it('keeps center exports available while four forwarded batches are stalled', async () => {
  const pending: ServerResponse[] = []
  const paths: string[] = []
  const collector = createServer((request, response) => {
    request.resume()
    paths.push(request.url ?? '')
    if (request.url === '/forward') pending.push(response)
    else response.writeHead(200).end('{}')
  })
  await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve))
  const address = collector.address() as { port: number }
  const forward = makeTelemetryForwardClient({
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${address.port}/forward`,
  })
  try {
    for (let i = 0; i < 5; i++) forward('traces', {})
    await vi.waitFor(() => expect(pending).toHaveLength(4))
    const result = await Effect.runPromise(
      withTraceSpan(Effect.succeed('business'), 'baton.business').pipe(
        Effect.provide(
          telemetryLayer('baton-server', {
            OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${address.port}/own`,
          }),
        ),
      ),
    )
    expect(result).toBe('business')
    expect(paths.filter((path) => path === '/forward')).toHaveLength(4)
    expect(paths).toContain('/own')
  } finally {
    for (const response of pending) response.writeHead(200).end('{}')
    collector.closeAllConnections()
    await new Promise<void>((resolve) => collector.close(() => resolve()))
  }
})
