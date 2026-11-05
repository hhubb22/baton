import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { expect, it, vi } from 'vite-plus/test'
import { connectWebSocket, webSocketText } from './transport.ts'
import { MaxMessageBytes } from '@baton/protocol'

it('sends business frames and rejects oversized frames', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await once(server, 'listening')
  const address = server.address()
  if (typeof address !== 'object' || !address) throw new Error('Missing address')
  const received: unknown[] = []
  server.on('connection', (socket) => socket.on('message', (raw) => received.push(JSON.parse(webSocketText(raw)))))
  const controller = new AbortController()
  const connection = await connectWebSocket(`ws://127.0.0.1:${address.port}`, { signal: controller.signal })
  try {
    await connection.send({ kind: 'heartbeat' })
    await expect(connection.send({ kind: 'error', message: 'x'.repeat(MaxMessageBytes) })).rejects.toThrow(
      '节点连接已断开',
    )
    await vi.waitFor(() => expect(received).toEqual([{ kind: 'heartbeat' }]))
  } finally {
    connection.close()
    server.clients.forEach((socket) => socket.terminate())
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
