import { timingSafeEqual } from 'node:crypto'
import { createConnection, createServer, type Socket } from 'node:net'
import { Effect, Schema } from 'effect'
import type * as Scope from 'effect/Scope'
import { WorkerAuth, WorkerIPCMessage, WorkerRequest, type WorkerIPCMessage as Message } from '@baton/protocol'

const frameLimit = 256 * 1024
const decodeRequest = Schema.decodeUnknownSync(WorkerRequest)
const decodeMessage = Schema.decodeUnknownSync(WorkerIPCMessage)
const decodeAuth = Schema.decodeUnknownSync(WorkerAuth)

export class IPCError extends Error {
  readonly _tag = 'IPCError'
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const sameToken = (actual: string, expected: string) => {
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** One authenticated command per connection; disconnecting never cancels accepted work. */
export const listenWorker = (options: {
  readonly endpoint: string
  readonly token: string
  readonly handle: (request: typeof WorkerRequest.Type) => Effect.Effect<Message, unknown>
}): Effect.Effect<void, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<never>()
    const run = Effect.runPromiseWith(context)
    const sockets = new Set<Socket>()
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.on('error', () => socket.destroy())
      socket.setTimeout(1000, () => socket.destroy())
      let authenticated = false
      let busy = false
      let buffer = Buffer.alloc(0)
      const reject = (code: string) => socket.end(`${JSON.stringify({ type: 'result', ok: false, code })}\n`)
      socket.on('data', (chunk: Buffer) => {
        if (busy || buffer.length + chunk.length > frameLimit + 1) {
          socket.destroy()
          return
        }
        buffer = Buffer.concat([buffer, chunk])
        while (buffer.includes(10)) {
          const newline = buffer.indexOf(10)
          const frame = buffer.subarray(0, newline)
          buffer = buffer.subarray(newline + 1)
          let value: unknown
          try {
            value = JSON.parse(frame.toString('utf8'))
            if (!authenticated) {
              const auth = decodeAuth(value)
              if (!sameToken(auth.token, options.token)) {
                reject('unauthorized')
                return
              }
              authenticated = true
              socket.write(`${JSON.stringify({ type: 'result', ok: true })}\n`)
              continue
            }
            const request = decodeRequest(value)
            if (request.type === 'auth') throw new IPCError('invalid_request', 'Already authenticated')
            if (buffer.length !== 0) throw new IPCError('invalid_request', 'One command per connection')
            busy = true
            socket.setTimeout(0)
            void run(options.handle(request))
              .then(
                (result) => {
                  const encoded = JSON.stringify(decodeMessage(result))
                  if (Buffer.byteLength(encoded) > frameLimit) {
                    reject('response_too_large')
                    return
                  }
                  socket.end(`${encoded}\n`)
                },
                () => reject('worker_unavailable'),
              )
              .catch(() => socket.destroy())
          } catch {
            reject(authenticated ? 'invalid_request' : 'unauthorized')
            return
          }
        }
      })
    })
    server.maxConnections = 32
    yield* Effect.addFinalizer(() =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            for (const socket of sockets) socket.destroy()
            server.close(() => resolve())
          }),
      ),
    )
    yield* Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(options.endpoint, () => {
            server.removeListener('error', reject)
            resolve()
          })
        }),
      catch: (cause) => (cause instanceof Error ? cause : new Error('Cannot listen on Worker IPC')),
    })
  })

export function requestWorker(options: {
  readonly endpoint: string
  readonly token: string
  readonly request: typeof WorkerRequest.Type
  readonly timeoutMs?: number
}): Promise<Message> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(options.endpoint)
    let authenticated = false
    let buffer = Buffer.alloc(0)
    let settled = false
    const finish = (error?: Error, result?: Message) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else if (result) resolve(result)
    }
    const timer = setTimeout(
      () => finish(new IPCError('timeout', 'Worker IPC deadline exceeded')),
      options.timeoutMs ?? 1000,
    )
    socket.once('error', (cause) => finish(new IPCError('unreachable', `Worker IPC is unavailable: ${cause.message}`)))
    socket.once('close', () => finish(new IPCError('closed', 'Worker IPC closed before the result')))
    socket.once('connect', () => socket.write(`${JSON.stringify({ type: 'auth', ok: false, token: options.token })}\n`))
    socket.on('data', (chunk: Buffer) => {
      if (buffer.length + chunk.length > frameLimit + 1) {
        finish(new IPCError('frame_too_large', 'Worker IPC response exceeds the limit'))
        return
      }
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.includes(10)) {
        const newline = buffer.indexOf(10)
        const frame = buffer.subarray(0, newline)
        buffer = buffer.subarray(newline + 1)
        try {
          const result = decodeMessage(JSON.parse(frame.toString('utf8')))
          if (!authenticated) {
            if (!result.ok) {
              finish(new IPCError('unauthorized', 'Worker authentication failed'))
              return
            }
            authenticated = true
            const encoded = JSON.stringify(decodeRequest(options.request))
            if (Buffer.byteLength(encoded) > frameLimit) {
              finish(new IPCError('frame_too_large', 'Worker IPC request exceeds the limit'))
              return
            }
            socket.write(`${encoded}\n`)
          } else {
            finish(undefined, result)
            return
          }
        } catch {
          finish(new IPCError('invalid_response', 'Worker IPC response is invalid'))
          return
        }
      }
    })
  })
}
