import { expect, it, vi } from 'vite-plus/test'
import { createTransport } from '../data/http/transport'

const sdk = vi.hoisted(() => ({
  loaded: vi.fn(),
  startTelemetry: vi.fn(),
  stopTelemetry: vi.fn(),
  traceSocket: vi.fn(),
}))
vi.mock('./index', () => {
  sdk.loaded()
  return sdk
})

it('loads telemetry only after a configured session and stops on logout', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ csrf_token: 'one' })))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ csrf_token: 'two', telemetry: { endpoint: 'http://collector', key: 'write-key' } }),
      ),
    )
  const transport = createTransport({ fetch: fetcher })
  await transport.request('/me')
  expect(sdk.loaded).not.toHaveBeenCalled()
  expect(sdk.startTelemetry).not.toHaveBeenCalled()
  expect(sdk.stopTelemetry).not.toHaveBeenCalled()
  await transport.request('/me')
  expect(sdk.startTelemetry).toHaveBeenCalledWith({ endpoint: 'http://collector', key: 'write-key' })
  transport.clear()
  expect(sdk.stopTelemetry).toHaveBeenCalledOnce()
})
