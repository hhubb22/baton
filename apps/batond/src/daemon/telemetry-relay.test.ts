import { afterEach, expect, it } from 'vite-plus/test'
import { startTelemetryRelay } from './telemetry-relay.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})

it('accepts only the per-process token and drops oversized or disconnected batches', async () => {
  const relay = await startTelemetryRelay()
  cleanups.push(relay.close)
  const received: unknown[] = []
  const headers = {
    authorization: decodeURIComponent(relay.headers.slice('authorization='.length)),
    'content-type': 'application/json',
  }
  const post = (body: string, authorization = headers.authorization) =>
    fetch(`${relay.endpoint}/v1/traces`, { method: 'POST', headers: { ...headers, authorization }, body })
  expect((await post('{}', 'Bearer invalid')).status).toBe(401)
  expect((await post('{}')).status).toBe(200)
  relay.send = (signal, payload) => received.push({ signal, payload })
  expect((await post('{"resourceSpans":[]}')).status).toBe(200)
  expect(received).toEqual([{ signal: 'traces', payload: { resourceSpans: [] } }])
  expect((await post(JSON.stringify({ value: 'x'.repeat(256 * 1024) }))).status).toBe(413)
  relay.send = undefined
  expect((await post('{}')).status).toBe(200)
  expect(received).toHaveLength(1)
})
