import WebSocket, { type RawData } from 'ws'
import { Agent as HttpAgent } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import { Schema } from 'effect'
import { NodeFrame, MaxMessageBytes, type Frame } from '@baton/protocol'

export const webSocketText = (data: RawData): string =>
  (Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)).toString('utf8')

export interface DaemonConnection {
  readonly frames: AsyncIterable<NodeFrame>
  send(frame: Frame): Promise<void>
  tryTelemetry?(frame: Frame): void
  close(): void
}
export interface DaemonTransport {
  (url: string, options: { readonly signal: AbortSignal; readonly ca?: string }): Promise<DaemonConnection>
}

/** TLS verification stays enabled; a caller may supply additional trust roots. */
export const connectWebSocket: DaemonTransport = (url, options) =>
  new Promise((resolve, reject) => {
    const proxyEnv = process.env.NODE_USE_ENV_PROXY === '0' ? {} : process.env
    const agent = url.startsWith('wss:') ? new HttpsAgent({ proxyEnv }) : new HttpAgent({ proxyEnv })
    const socket = new WebSocket(url, {
      agent,
      ca: options.ca,
      minVersion: 'TLSv1.2',
      maxPayload: MaxMessageBytes,
      handshakeTimeout: 10_000,
    })
    const queue: NodeFrame[] = []
    let wake: (() => void) | undefined
    let ended = false
    let opened = false
    let pendingWrites = 0
    const end = () => {
      ended = true
      wake?.()
      if (!opened) reject(new Error('无法连接 Coordinator'))
    }
    const abort = () => socket.terminate()
    options.signal.addEventListener('abort', abort, { once: true })
    socket.on('error', end)
    socket.on('close', () => {
      agent.destroy()
      options.signal.removeEventListener('abort', abort)
      end()
    })
    socket.on('message', (raw) => {
      try {
        const frame = Schema.decodeUnknownSync(NodeFrame)(JSON.parse(webSocketText(raw)))
        if (queue.length >= 256) {
          socket.terminate()
          return
        }
        queue.push(frame)
        wake?.()
      } catch {
        socket.terminate()
      }
    })
    socket.on('open', () => {
      opened = true
      resolve({
        frames: {
          async *[Symbol.asyncIterator]() {
            while (!ended || queue.length) {
              const frame = queue.shift()
              if (frame) yield frame
              else
                await new Promise<void>((ready) => {
                  wake = ready
                  if (ended || queue.length) ready()
                })
            }
          },
        },
        send: (frame) =>
          new Promise<void>((sent, failed) => {
            const text = JSON.stringify(frame)
            const bytes = Buffer.byteLength(text)
            if (ended || socket.readyState !== WebSocket.OPEN || bytes > MaxMessageBytes) {
              failed(new Error('节点连接已断开'))
              return
            }
            if (pendingWrites >= 64 || socket.bufferedAmount + bytes > 4 * MaxMessageBytes) {
              failed(new Error('节点发送队列已满'))
              return
            }
            pendingWrites++
            socket.send(text, (error) => {
              pendingWrites--
              if (error) failed(new Error('节点发送失败'))
              else sent()
            })
          }),
        tryTelemetry: (frame) => {
          if (ended || socket.readyState !== WebSocket.OPEN || pendingWrites || socket.bufferedAmount) return
          const text = JSON.stringify(frame)
          if (Buffer.byteLength(text) > MaxMessageBytes) return
          pendingWrites++
          try {
            socket.send(text, () => {
              pendingWrites--
            })
          } catch {
            pendingWrites--
          }
        },
        close: () => {
          socket.terminate()
          end()
        },
      })
    })
    if (options.signal.aborted) abort()
  })

/** Exponential reconnect delay with jitter, bounded to 1–30 seconds. */
export const reconnectDelay = (attempt: number, random: () => number = Math.random): number =>
  Math.min(
    30_000,
    Math.max(
      1000,
      Math.min(30_000, 1000 * 2 ** Math.min(5, attempt)) * (0.8 + Math.max(0, Math.min(1, random())) * 0.4),
    ),
  )
