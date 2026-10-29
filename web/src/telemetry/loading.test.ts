import { expect, it, vi } from 'vite-plus/test'
import { createTransport } from '../data/http/transport'

const pending = vi.hoisted(() => {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return { gate, release: () => release!(), loaded: vi.fn(), start: vi.fn(), stop: vi.fn() }
})
vi.mock('./index', async () => {
  pending.loaded()
  await pending.gate
  return { startTelemetry: pending.start, stopTelemetry: pending.stop, traceSocket: vi.fn() }
})

it('does not start a late-loaded exporter after logout', async () => {
  const transport = createTransport({
    fetch: vi.fn(async () => new Response(JSON.stringify({ csrf_token: 'one', telemetry: {} }))),
  })
  const request = transport.request('/me')
  await vi.waitFor(() => expect(pending.loaded).toHaveBeenCalled())
  transport.clear()
  pending.release()
  await request
  expect(pending.start).not.toHaveBeenCalled()
})
