import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { expect, it, vi } from 'vite-plus/test'
import { connectWebSocket, webSocketText } from './transport.ts'
import { MaxMessageBytes } from '@baton/protocol'

it('drops telemetry when a business write is pending and rejects oversized frames', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await once(server, 'listening')
  const address = server.address()
  if (typeof address !== 'object' || !address) throw new Error('Missing address')
  const received: unknown[] = []
  server.on('connection', (socket) => socket.on('message', (raw) => received.push(JSON.parse(webSocketText(raw)))))
  const controller = new AbortController()
  const connection = await connectWebSocket(`ws://127.0.0.1:${address.port}`, { signal: controller.signal })
  try {
    const business = connection.send({ kind: 'heartbeat' })
    connection.tryTelemetry?.({ kind: 'error', message: 'drop-pending' })
    await business
    connection.tryTelemetry?.({ kind: 'error', message: 'x'.repeat(MaxMessageBytes) })
    connection.tryTelemetry?.({ kind: 'error', message: 'accepted' })
    await vi.waitFor(() => expect(received).toHaveLength(2))
    expect(received).toEqual([{ kind: 'heartbeat' }, { kind: 'error', message: 'accepted' }])
  } finally {
    connection.close()
    server.clients.forEach((socket) => socket.terminate())
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
