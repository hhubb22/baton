import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gunzipSync } from 'node:zlib'
import { MaxMessageBytes } from '@baton/protocol'
import { Schema } from 'effect'

type Signal = 'traces' | 'logs' | 'metrics'
export interface TelemetryRelay {
  readonly endpoint: string
  readonly headers: string
  send?: ((signal: Signal, payload: typeof Schema.Json.Type) => void) | undefined
  close: () => Promise<void>
}

export async function startTelemetryRelay(): Promise<TelemetryRelay> {
  const token = randomBytes(32).toString('hex')
  let relay: TelemetryRelay
  const server: Server = createServer((request, response) => {
    const provided = request.headers.authorization ?? ''
    const expected = `Bearer ${token}`
    const valid =
      Buffer.byteLength(provided) === Buffer.byteLength(expected) &&
      timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
    const signal = /^\/v1\/(traces|logs|metrics)$/.exec(request.url ?? '')?.[1] as Signal | undefined
    if (
      !valid ||
      request.method !== 'POST' ||
      !signal ||
      !/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')
    ) {
      request.resume()
      response.writeHead(valid ? 404 : 401).end()
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let exceeded = false
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MaxMessageBytes) {
        exceeded = true
        chunks.length = 0
      } else if (!exceeded) chunks.push(chunk)
    })
    request.on('end', () => {
      if (!exceeded && relay.send) {
        try {
          const body = Buffer.concat(chunks)
          const decoded =
            request.headers['content-encoding'] === 'gzip'
              ? gunzipSync(body, { maxOutputLength: MaxMessageBytes })
              : body
          relay.send(signal, Schema.decodeUnknownSync(Schema.Json)(JSON.parse(decoded.toString('utf8'))))
        } catch {
          /* 丢弃无效遥测。 */
        }
      }
      response.writeHead(exceeded ? 413 : 200).end('{}')
    })
    request.on('error', () => {})
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  relay = {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    headers: `authorization=${encodeURIComponent(`Bearer ${token}`)}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
  return relay
}
