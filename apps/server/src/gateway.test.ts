import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { Option, Schema, Tracer } from 'effect'
import { traceParent } from '@baton/telemetry'
import { afterEach, expect, test, vi } from 'vite-plus/test'
import type { BrowserEvent, SessionResult } from '@baton/protocol'
import { WebSocket } from 'ws'
import { AppError, type NodeSource } from './errors.ts'
import { webSocketText, Gateway, type GatewayHandlers, type GatewayOptions } from './gateway.ts'

test('decodes WebSocket data with UTF-8 characters split across buffers', () => {
  const text = '{"text":"你好🙂"}'
  const bytes = Buffer.from(text)
  const split = bytes.indexOf(Buffer.from('你')) + 1
  for (const data of [bytes, [bytes.subarray(0, split), bytes.subarray(split)], Uint8Array.from(bytes).buffer]) {
    expect(webSocketText(data)).toBe(text)
  }
})

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  } finally {
    vi.useRealTimers()
  }
})
const envelope = (body: unknown, correlationId?: string) => ({
  kind: 'envelope',
  envelope: {
    version: 1,
    message_id: randomUUID(),
    route: { to: 'control' },
    priority: 'control',
    body,
    ...(correlationId ? { correlation_id: correlationId } : {}),
  },
})

async function fixture(
  overrides: Partial<GatewayHandlers> = {},
  tracer?: Tracer.Tracer,
  options: Partial<GatewayOptions> = {},
) {
  const employeeId = randomUUID(),
    nodeId = randomUUID()
  const seen: Array<Record<string, unknown>> = []
  let source: NodeSource | undefined
  const server = createServer()
  const gateway = new Gateway(
    server,
    {
      authenticate: async (token, incarnation, connectionId) => {
        if (token !== 'local-node') throw new AppError(401, 'invalid_node_credential')
        source = {
          employee_id: employeeId,
          node_id: nodeId,
          credential_id: randomUUID(),
          incarnation,
          conn_id: connectionId,
        }
        return source
      },
      validate: async () => undefined,
      heartbeat: async () => undefined,
      disconnected: async () => undefined,
      handle: async (_source, input) => {
        seen.push(input as unknown as Record<string, unknown>)
        return { type: 'node.sync_result', ok: true }
      },
      browser: async (cookie) => {
        if (cookie !== 'owner') throw new AppError(401, 'unauthenticated')
        return employeeId
      },
      thread: async (_employee, threadId) => {
        if (threadId !== nodeId) throw new AppError(404, 'not_found')
      },
      output: async (_employee, threadId) => ({
        type: 'session.result',
        operation_id: randomUUID(),
        session_id: threadId,
        ok: true,
        text: 'hello',
        cursor: 'epoch:5',
        gap: false,
      }),
      ...overrides,
    },
    { allowedOrigins: ['https://baton.local'], pollMs: 50, ...(tracer ? { tracer } : {}), ...options },
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as import('node:net').AddressInfo
  const base = `ws://127.0.0.1:${address.port}`
  cleanups.push(async () => {
    await gateway.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const connect = async () => {
    const ws = new WebSocket(`${base}/v1/node`)
    const frames: Array<Record<string, unknown>> = []
    ws.on('message', (data) => frames.push(JSON.parse(webSocketText(data)) as Record<string, unknown>))
    ws.on('error', () => undefined)
    await once(ws, 'open')
    ws.send(
      JSON.stringify({
        kind: 'auth',
        token: 'local-node',
        incarnation: randomUUID(),
        daemon_version: 'development',
        protocol_version: 1,
      }),
    )
    await expect.poll(() => frames.some((frame) => frame.kind === 'auth_result')).toBe(true)
    ws.send(JSON.stringify(envelope({ type: 'node.sync', display_name: 'Test', system: 'macos', capabilities: [] })))
    await expect.poll(() => frames.some((frame) => frame.kind === 'envelope')).toBe(true)
    return { ws, frames }
  }
  return { gateway, base, employeeId, nodeId, seen, connect, source: () => source! }
}

test('丢弃处理失败的遥测并继续处理心跳', async () => {
  const telemetry = vi.fn(() => {
    throw new Error('malformed telemetry')
  })
  const heartbeat = vi.fn(async () => undefined)
  const f = await fixture({ telemetry, heartbeat })
  const { ws } = await f.connect()
  ws.send(JSON.stringify(envelope({ type: 'telemetry.export', signal: 'logs', payload: { malformed: true } })))
  await expect.poll(() => telemetry.mock.calls.length).toBe(1)
  ws.send(JSON.stringify({ kind: 'heartbeat' }))
  await expect.poll(() => heartbeat.mock.calls.length).toBe(1)
  expect(ws.readyState).toBe(WebSocket.OPEN)
})

test.each([false, true])('telemetry admission during queued business work: override=%s', async (override) => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const telemetry = vi.fn()
  const f = await fixture(
    {
      telemetry,
      handle: async (_source, input) => {
        if ((input.body as { type: string }).type === 'thread.report') {
          entered.resolve()
          await release.promise
          return undefined
        }
        return { type: 'node.sync_result', ok: true }
      },
    },
    undefined,
    override ? { telemetryAdmission: () => true } : {},
  )
  cleanups.push(async () => release.resolve())
  const { ws } = await f.connect()
  ws.send(
    JSON.stringify(
      envelope({
        type: 'thread.report',
        thread_id: randomUUID(),
        event_id: randomUUID(),
        worker_seq: 1,
        kind: 'thread.opened',
      }),
    ),
  )
  await entered.promise
  ws.send(JSON.stringify(envelope({ type: 'telemetry.export', signal: 'logs', payload: {} })))
  const pong = once(ws, 'pong')
  ws.ping()
  await pong
  expect(telemetry).toHaveBeenCalledTimes(override ? 1 : 0)
  release.resolve()
})

test('propagates the actual WSS enqueue span independently of command content', async () => {
  const spans: Tracer.NativeSpan[] = []
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    },
  })
  const f = await fixture({}, tracer)
  const { frames } = await f.connect()
  const command = {
    type: 'thread.command',
    thread_id: randomUUID(),
    action: 'stop',
    trace_context: { traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01` },
  }
  const id = randomUUID()
  expect(f.gateway.send(f.nodeId, f.employeeId, id, command)).toBe(true)
  await expect
    .poll(() => frames.some((frame) => (frame.envelope as { message_id?: string } | undefined)?.message_id === id))
    .toBe(true)
  const frame = frames.find((frame) => (frame.envelope as { message_id?: string } | undefined)?.message_id === id)!
  const delivered = (frame.envelope as { body: typeof command }).body
  expect({ ...delivered, trace_context: command.trace_context }).toEqual(command)
  const send = spans.find((span) => span.name === 'baton.gateway.send')!
  expect(send.traceId).toBe('a'.repeat(32))
  expect(Option.getOrUndefined(send.parent)?.spanId).toBe('b'.repeat(16))
  expect(traceParent(delivered.trace_context)?.spanId).toBe(send.spanId)
  expect(send.attributes.get('baton.dispatch.accepted')).toBe(true)
})

test('authenticated source replaces supplied identity and node-to-node routes are rejected', async () => {
  const f = await fixture()
  const { ws } = await f.connect()
  expect(f.seen[0].source).toEqual({ kind: 'node', ...f.source() })
  const message = envelope({ type: 'node.sync', display_name: 'Other', system: 'macos', capabilities: [] })
  message.envelope.route.to = randomUUID()
  const closed = once(ws, 'close')
  ws.send(JSON.stringify(message))
  expect((await closed)[0]).toBe(1008)
})

test('disconnect retirement retries the same source after a transient failure', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  const attempts: NodeSource[] = []
  const firstAttempt = Promise.withResolvers<void>()
  const secondAttempt = Promise.withResolvers<void>()
  const completion = Promise.withResolvers<void>()
  const f = await fixture({
    disconnected: async (source) => {
      attempts.push(structuredClone(source))
      if (attempts.length === 1) {
        firstAttempt.resolve()
        throw new AppError(503, 'unavailable')
      }
      secondAttempt.resolve()
      await completion.promise
    },
  })
  cleanups.push(async () => {
    completion.resolve()
  })
  const { ws } = await f.connect()
  const source = structuredClone(f.source())
  const closed = once(ws, 'close')
  ws.close()
  await closed
  await firstAttempt.promise
  await vi.advanceTimersByTimeAsync(0)
  expect(attempts).toEqual([source])
  expect(f.gateway.diagnostics()).toMatchObject({ nodes: 0, pending_disconnects: 1 })
  await vi.advanceTimersByTimeAsync(900)
  expect(attempts).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(150)
  await secondAttempt.promise
  expect(attempts).toEqual([source, source])
  await vi.advanceTimersByTimeAsync(5000)
  expect(attempts).toHaveLength(2)
  expect(f.gateway.diagnostics().pending_disconnects).toBe(1)
  completion.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect(f.gateway.diagnostics().pending_disconnects).toBe(0)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(attempts).toHaveLength(2)
})

test('queued heartbeats keep a node connected during a slow handler and still validate when processed', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const heartbeat = vi.fn(async () => undefined)
  const f = await fixture({
    heartbeat,
    handle: async (_source, input) => {
      const body = Schema.decodeUnknownSync(Schema.Struct({ type: Schema.String }))(input.body)
      if (body.type === 'thread.report') {
        entered.resolve()
        await release.promise
        return undefined
      }
      return { type: 'node.sync_result', ok: true }
    },
  })
  cleanups.push(async () => {
    release.resolve()
  })
  const { ws } = await f.connect()
  ws.send(
    JSON.stringify(
      envelope({
        type: 'thread.report',
        thread_id: randomUUID(),
        event_id: randomUUID(),
        worker_seq: 1,
        kind: 'thread.opened',
      }),
    ),
  )
  await entered.promise
  for (let index = 0; index < 12; index++) {
    await vi.advanceTimersByTimeAsync(10_000)
    const bytes = f.gateway.diagnostics().received_bytes
    ws.send(JSON.stringify({ kind: 'heartbeat' }))
    await expect.poll(() => f.gateway.diagnostics().received_bytes).toBeGreaterThan(bytes)
    expect(ws.readyState).toBe(WebSocket.OPEN)
  }
  expect(heartbeat).not.toHaveBeenCalled()
  release.resolve()
  await expect.poll(() => heartbeat.mock.calls.length).toBe(12)
  const closed = once(ws, 'close')
  await vi.advanceTimersByTimeAsync(30_100)
  await closed
})

test('RPC checks current connection, operation and Thread before accepting a response', async () => {
  const f = await fixture()
  const { ws, frames } = await f.connect()
  const threadId = randomUUID(),
    operationId = randomUUID()
  let completed = false
  const pending = f.gateway
    .request(
      f.nodeId,
      f.employeeId,
      {
        type: 'session.request',
        session_id: threadId,
        operation_id: operationId,
        action: 'output',
      },
      1500,
    )
    .then((value) => {
      completed = true
      return value
    })
  await expect.poll(() => frames.filter((frame) => frame.kind === 'envelope').length).toBe(2)
  const request = frames.filter((frame) => frame.kind === 'envelope')[1].envelope as { message_id: string }
  ws.send(
    JSON.stringify(
      envelope(
        { type: 'session.result', session_id: randomUUID(), operation_id: operationId, ok: true, gap: false },
        request.message_id,
      ),
    ),
  )
  await expect.poll(() => f.gateway.diagnostics().pending_rpc).toBe(1)
  expect(completed).toBe(false)
  ws.send(
    JSON.stringify(
      envelope(
        {
          type: 'session.result',
          session_id: threadId,
          operation_id: operationId,
          ok: true,
          text: 'reply',
          gap: false,
        },
        request.message_id,
      ),
    ),
  )
  expect((await pending).text).toBe('reply')
  await expect(f.gateway.request(f.nodeId, randomUUID(), { operation_id: randomUUID() })).rejects.toMatchObject({
    code: 'node_offline',
  })
})

const rpcFrameSchema = Schema.Struct({
  message_id: Schema.String,
  body: Schema.Struct({
    type: Schema.String,
    operation_id: Schema.optionalKey(Schema.String),
    session_id: Schema.optionalKey(Schema.String),
  }),
})
const rpcFrames = (frames: Array<Record<string, unknown>>) =>
  frames
    .filter((frame) => frame.kind === 'envelope')
    .map((frame) => Schema.decodeUnknownSync(rpcFrameSchema)(frame.envelope))
    .filter((frame) => frame.body.operation_id !== undefined)

function replyRPC(ws: WebSocket, frame: typeof rpcFrameSchema.Type) {
  const type =
    frame.body.type === 'files.browse'
      ? 'files.browse_result'
      : frame.body.type === 'session.request'
        ? 'session.result'
        : 'node.project_exec_result'
  ws.send(
    JSON.stringify(
      envelope(
        {
          type,
          operation_id: frame.body.operation_id,
          ok: true,
          ...(type === 'session.result' ? { session_id: frame.body.session_id, gap: false } : {}),
        },
        frame.message_id,
      ),
    ),
  )
}

test('routes model connection save, read and delete acknowledgements over the node gateway', async () => {
  const f = await fixture()
  const { ws, frames } = await f.connect()
  const connection = {
    id: randomUUID(),
    name: 'Local',
    protocol: 'openai-responses',
    base_url: 'http://127.0.0.1:1234/v1',
    models: ['test'],
  }
  for (const action of ['save', 'get', 'delete'] as const) {
    const operation_id = randomUUID()
    const pending = f.gateway.request(f.nodeId, f.employeeId, {
      type: 'node.model_connection',
      operation_id,
      action,
      connection,
    })
    await expect.poll(() => rpcFrames(frames).some((frame) => frame.body.operation_id === operation_id)).toBe(true)
    const frame = rpcFrames(frames).find((item) => item.body.operation_id === operation_id)!
    ws.send(
      JSON.stringify(
        envelope(
          { type: 'node.model_connection_result', operation_id, ok: true, ...(action === 'get' ? { connection } : {}) },
          frame.message_id,
        ),
      ),
    )
    expect(await pending).toMatchObject({ type: 'node.model_connection_result', operation_id, ok: true })
  }
})

test('validates RPCs before sending, including queued requests crossing the idle deadline', async () => {
  let validations = 0
  const f = await fixture(
    {
      validate: async () => {
        if (++validations === 3) throw new AppError(401, 'node_idle_expired')
      },
    },
    undefined,
    { rpc: { readConcurrency: 1 } },
  )
  const { ws, frames } = await f.connect()
  const first = f.gateway.request(f.nodeId, f.employeeId, { type: 'files.browse', operation_id: randomUUID() })
  await expect.poll(() => rpcFrames(frames).length).toBe(1)
  const queued = f.gateway.request(f.nodeId, f.employeeId, { type: 'files.browse', operation_id: randomUUID() })
  const rejected = expect(queued).rejects.toMatchObject({ code: 'node_idle_expired' })
  // The first send and response are valid; the next queue validation observes expiry.
  ws.send(
    JSON.stringify(
      envelope(
        {
          type: 'files.browse_result',
          operation_id: rpcFrames(frames)[0].body.operation_id,
          ok: true,
          kind: 'roots',
          roots: [],
        },
        rpcFrames(frames)[0].message_id,
      ),
    ),
  )
  await first
  await rejected
  expect(validations).toBe(3)
  expect(rpcFrames(frames)).toHaveLength(1)
})

test('reserves RPC capacity during asynchronous validation and never sends from a replaced source', async () => {
  const checking = Promise.withResolvers<void>()
  const validated = Promise.withResolvers<void>()
  const f = await fixture(
    {
      validate: async () => {
        checking.resolve()
        await validated.promise
      },
    },
    undefined,
    { rpc: { readConcurrency: 1 } },
  )
  cleanups.push(async () => {
    validated.resolve()
  })
  const { frames } = await f.connect()
  const body = { type: 'files.browse', operation_id: randomUUID() }
  const pending = f.gateway.request(f.nodeId, f.employeeId, body)
  const rejected = expect(pending).rejects.toMatchObject({ code: 'node_offline' })
  await checking.promise
  expect(rpcFrames(frames)).toHaveLength(0)
  expect(f.gateway.diagnostics().pending_rpc).toBe(1)
  const replacement = await f.connect()
  validated.resolve()
  await rejected
  expect(rpcFrames(replacement.frames)).toHaveLength(0)
})

test('database idle expiry closes a quiet connection and rejects durable sends without a heartbeat', async () => {
  let expired = false
  const f = await fixture({
    validate: async () => {
      if (expired) throw new AppError(401, 'node_idle_expired')
    },
  })
  const { ws, frames } = await f.connect()
  expired = true
  expect(await f.gateway.sendValidated(f.nodeId, f.employeeId, randomUUID(), { type: 'project_run_start' })).toBe(false)
  expect(frames).toHaveLength(2)
  const closed = once(ws, 'close')
  await f.gateway.closeExpiredConnections()
  const [code, reason] = await closed
  expect(code).toBe(1008)
  expect(String(reason)).toBe('node_idle_expired')
})

test('reading at capacity leaves management slots available and queues reads in order', async () => {
  const f = await fixture({}, undefined, {
    rpc: { readConcurrency: 1, managementConcurrency: 1, maxQueued: 1, queueMs: 5000 },
  })
  const { ws, frames } = await f.connect()
  const read = () => ({ type: 'files.browse', operation_id: randomUUID() })
  const firstBody = read()
  const secondBody = {
    type: 'session.request',
    action: 'full_output',
    session_id: randomUUID(),
    output_id: randomUUID(),
    operation_id: randomUUID(),
  }
  const first = f.gateway.request(f.nodeId, f.employeeId, firstBody)
  const second = f.gateway.request(f.nodeId, f.employeeId, secondBody)
  await expect(f.gateway.request(f.nodeId, f.employeeId, read())).rejects.toMatchObject({ code: 'node_busy' })
  const manageBody = { type: 'node.project_exec_set', operation_id: randomUUID(), enabled: true }
  const management = f.gateway.request(f.nodeId, f.employeeId, manageBody)
  await expect.poll(() => rpcFrames(frames).length).toBe(2)
  expect(rpcFrames(frames).map((frame) => frame.body.operation_id)).toEqual([
    firstBody.operation_id,
    manageBody.operation_id,
  ])
  const [readFrame, managementFrame] = rpcFrames(frames)
  replyRPC(ws, readFrame)
  await first
  await expect.poll(() => rpcFrames(frames).length).toBe(3)
  expect(rpcFrames(frames)[2].body.operation_id).toBe(secondBody.operation_id)
  replyRPC(ws, managementFrame)
  replyRPC(ws, rpcFrames(frames)[2])
  await Promise.all([second, management])
})

test('RPC execution gets its full timeout after waiting for a slot', async () => {
  const f = await fixture({}, undefined, { rpc: { readConcurrency: 1, queueMs: 1000 } })
  const { ws, frames } = await f.connect()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const received = once(ws, 'message')
  const first = f.gateway.request(f.nodeId, f.employeeId, { type: 'files.browse', operation_id: randomUUID() }, 1000)
  await received
  const second = f.gateway.request(f.nodeId, f.employeeId, { type: 'files.browse', operation_id: randomUUID() }, 100)
  await vi.advanceTimersByTimeAsync(90)
  const secondReceived = once(ws, 'message')
  replyRPC(ws, rpcFrames(frames)[0])
  await first
  await secondReceived
  await vi.advanceTimersByTimeAsync(90)
  replyRPC(ws, rpcFrames(frames)[1])
  expect((await second).ok).toBe(true)
})

test('an expired queued management request is never sent when a slot becomes available', async () => {
  const f = await fixture({}, undefined, { rpc: { managementConcurrency: 1, maxQueued: 1, queueMs: 100 } })
  const { ws, frames } = await f.connect()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const received = once(ws, 'message')
  const first = f.gateway.request(f.nodeId, f.employeeId, {
    type: 'node.project_exec_set',
    operation_id: randomUUID(),
    enabled: true,
  })
  await received
  const body = { type: 'node.project_exec_set', operation_id: randomUUID(), enabled: false }
  const queued = f.gateway.request(f.nodeId, f.employeeId, body)
  const rejected = expect(queued).rejects.toMatchObject({ code: 'node_busy' })
  await vi.advanceTimersByTimeAsync(100)
  await rejected
  replyRPC(ws, rpcFrames(frames)[0])
  await first
  await vi.advanceTimersByTimeAsync(5000)
  expect(rpcFrames(frames).map((frame) => frame.body.operation_id)).not.toContain(body.operation_id)
})

test('a sent management timeout does not resend its side effect or accept its late response for another request', async () => {
  const f = await fixture({}, undefined, {
    rpc: { managementConcurrency: 1, timeouts: { 'node.project_exec_set': 100 } },
  })
  const { ws, frames } = await f.connect()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const body = { type: 'node.project_exec_set', operation_id: randomUUID(), enabled: true }
  const received = once(ws, 'message')
  const pending = f.gateway.request(f.nodeId, f.employeeId, body, 5000)
  const rejected = expect(pending).rejects.toMatchObject({ code: 'node_timeout' })
  await received
  const original = rpcFrames(frames)[0]
  await vi.advanceTimersByTimeAsync(100)
  await rejected
  const nextBody = { ...body, operation_id: randomUUID(), enabled: false }
  const nextReceived = once(ws, 'message')
  let completed = false
  const next = f.gateway.request(f.nodeId, f.employeeId, nextBody).then((result) => {
    completed = true
    return result
  })
  await nextReceived
  replyRPC(ws, original)
  replyRPC(ws, rpcFrames(frames)[1])
  expect((await next).operation_id).toBe(nextBody.operation_id)
  expect(completed).toBe(true)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(rpcFrames(frames).filter((frame) => frame.body.operation_id === body.operation_id)).toHaveLength(1)
  expect(f.gateway.diagnostics().pending_rpc).toBe(0)
})

test('disconnect rejects queued RPCs and a replacement connection does not send them', async () => {
  const f = await fixture({}, undefined, { rpc: { managementConcurrency: 1 } })
  const { ws } = await f.connect()
  const body = { type: 'node.project_exec_set', operation_id: randomUUID(), enabled: true }
  const first = f.gateway.request(f.nodeId, f.employeeId, body)
  const second = f.gateway.request(f.nodeId, f.employeeId, { ...body, operation_id: randomUUID() })
  const rejected = [first, second].map((pending) => expect(pending).rejects.toMatchObject({ code: 'node_offline' }))
  ws.close()
  await Promise.all(rejected)
  const replacement = await f.connect()
  expect(rpcFrames(replacement.frames)).toHaveLength(0)
})

test('a temporary report failure keeps the connection open and acknowledges the same report on retry', async () => {
  const attempted = Promise.withResolvers<void>()
  const attempts: unknown[] = []
  const f = await fixture({
    handle: async (_source, input) => {
      const body = Schema.decodeUnknownSync(Schema.Struct({ type: Schema.String }))(input.body)
      if (body.type !== 'thread.report') return { type: 'node.sync_result', ok: true }
      attempts.push(input.body)
      if (attempts.length === 1) {
        attempted.resolve()
        throw new AppError(503, 'unavailable')
      }
      return { type: 'thread.report_result', ok: true }
    },
  })
  const { ws, frames } = await f.connect()
  const report = {
    type: 'thread.report',
    thread_id: randomUUID(),
    event_id: randomUUID(),
    worker_seq: 1,
    kind: 'thread.opened',
  }
  ws.send(JSON.stringify(envelope(report)))
  await attempted.promise
  ws.send(JSON.stringify(envelope(report)))
  await expect.poll(() => frames.length).toBe(3)
  expect(ws.readyState).toBe(WebSocket.OPEN)
  expect(attempts).toEqual([report, report])
})

test('browser output uses the public event type and rejects another employee Thread', async () => {
  const f = await fixture()
  const browser = new WebSocket(`${f.base}/api/v1/events`, {
    headers: { Origin: 'https://baton.local', Cookie: 'owner' },
  })
  const frames: Array<Record<string, unknown>> = []
  browser.on('message', (data) => frames.push(JSON.parse(webSocketText(data)) as Record<string, unknown>))
  await once(browser, 'open')
  await expect.poll(() => frames[0]?.type).toBe('ready')
  browser.send(JSON.stringify({ thread_id: f.nodeId }))
  await expect.poll(() => frames.some((frame) => frame.type === 'thread.output')).toBe(true)
  expect(frames.find((frame) => frame.type === 'thread.output')).toMatchObject({ thread_id: f.nodeId, text: 'hello' })
  const closed = once(browser, 'close')
  browser.send(JSON.stringify({ thread_id: randomUUID() }))
  expect((await closed)[0]).toBe(1008)
})

test('queued notifications retain different entities and coalesce repeated changes to the same entity', async () => {
  const authorization = Promise.withResolvers<void>()
  let hold = false
  const f = await fixture({
    browser: async () => {
      if (hold) await authorization.promise
      return 'employee'
    },
  })
  cleanups.push(async () => authorization.resolve())
  const browser = new WebSocket(`${f.base}/api/v1/events`, {
    headers: { Origin: 'https://baton.local', Cookie: 'owner' },
  })
  const frames: Array<Record<string, unknown>> = []
  browser.on('message', (data) => frames.push(JSON.parse(webSocketText(data)) as Record<string, unknown>))
  await once(browser, 'open')
  await expect.poll(() => frames[0]?.type).toBe('ready')
  hold = true
  const threadId = randomUUID()
  const notification = {
    type: 'notification' as const,
    event_id: randomUUID(),
    cursor: '1',
    kind: 'question' as const,
    thread_id: threadId,
    title: 'Work',
    body: 'Which target?',
  }
  const changes: BrowserEvent[] = [
    notification,
    { ...notification, event_id: randomUUID(), cursor: '2', kind: 'turn_ended' },
    { type: 'thread.changed', thread_id: randomUUID(), change: 'detail' },
    { type: 'thread.changed', thread_id: randomUUID(), change: 'detail' },
    { type: 'project.changed', project_id: randomUUID(), change: 'detail' },
    { type: 'project.changed', project_id: randomUUID(), change: 'detail' },
    { type: 'devices.changed', node_id: randomUUID(), report_version: 2 },
    { type: 'devices.changed', node_id: randomUUID(), report_version: 3 },
    { type: 'nodes.changed', node_id: randomUUID() },
    { type: 'nodes.changed', node_id: randomUUID() },
  ]
  for (const change of [...changes, changes[0]]) f.gateway.notify('employee', change)
  f.gateway.notify('another-employee', { type: 'thread.changed', thread_id: randomUUID(), change: 'detail' })
  authorization.resolve()
  await expect.poll(() => frames.slice(1)).toEqual(changes)
})

test('an idle browser receives no events after its session is revoked', async () => {
  let revoked = false
  const f = await fixture({
    browser: async () => {
      if (revoked) throw new AppError(401, 'unauthenticated')
      return 'employee'
    },
  })
  const browser = new WebSocket(`${f.base}/api/v1/events`, {
    headers: { Origin: 'https://baton.local', Cookie: 'owner' },
  })
  const frames: Array<Record<string, unknown>> = []
  browser.on('message', (data) => frames.push(JSON.parse(webSocketText(data)) as Record<string, unknown>))
  await once(browser, 'open')
  await expect.poll(() => frames[0]?.type).toBe('ready')
  const closed = once(browser, 'close')
  revoked = true
  f.gateway.notify('employee', { type: 'devices.changed', node_id: randomUUID(), report_version: 2 })
  expect((await closed)[0]).toBe(1008)
  expect(frames).toEqual([{ type: 'ready' }])
})

test('switching subscriptions while output is pending replaces the old Thread', async () => {
  let resolveOutput: ((value: import('@baton/protocol').SessionResult) => void) | undefined
  const firstThread = randomUUID(),
    secondThread = randomUUID()
  let pending = false,
    secondAuthorized = false
  const f = await fixture({
    thread: async (_employee, threadId) => {
      if (threadId === secondThread) secondAuthorized = true
    },
    output: async (_employee, threadId) => {
      if (threadId === firstThread) {
        pending = true
        return new Promise((resolve) => {
          resolveOutput = resolve
        })
      }
      return {
        type: 'session.result',
        operation_id: randomUUID(),
        session_id: threadId,
        ok: true,
        text: 'new Thread',
        reply_id: 'native-reply',
        worker_turn_seq: 2,
        running_steps: [
          {
            item_id: 'tool',
            type: 'dynamic_tool',
            status: 'running',
            ordinal: 0,
            data: {},
            truncated: false,
            original_bytes: 2,
          },
        ],
        running_steps_truncated: false,
        gap: false,
      }
    },
  })
  const browser = new WebSocket(`${f.base}/api/v1/events`, {
    headers: { Origin: 'https://baton.local', Cookie: 'owner' },
  })
  const frames: Array<Record<string, unknown>> = []
  browser.on('message', (data) => frames.push(JSON.parse(webSocketText(data)) as Record<string, unknown>))
  await once(browser, 'open')
  await expect.poll(() => frames[0]?.type).toBe('ready')
  browser.send(JSON.stringify({ thread_id: firstThread }))
  await expect.poll(() => pending).toBe(true)
  browser.send(JSON.stringify({ thread_id: '' }))
  browser.send(JSON.stringify({ thread_id: secondThread }))
  await expect.poll(() => secondAuthorized).toBe(true)
  resolveOutput!({
    type: 'session.result',
    operation_id: randomUUID(),
    session_id: firstThread,
    ok: true,
    text: 'old Thread',
    gap: false,
  })
  await expect
    .poll(() => frames.some((frame) => frame.thread_id === secondThread && frame.text === 'new Thread'))
    .toBe(true)
  expect(browser.readyState).toBe(WebSocket.OPEN)
  expect(frames.find((frame) => frame.thread_id === secondThread && frame.text === 'new Thread')).toMatchObject({
    reply_id: 'native-reply',
    worker_turn_seq: 2,
    running_steps: [
      {
        item_id: 'tool',
        type: 'dynamic_tool',
        status: 'running',
        ordinal: 0,
        data: {},
        truncated: false,
        original_bytes: 2,
      },
    ],
    running_steps_truncated: false,
  })
  expect(frames.some((frame) => frame.text === 'old Thread')).toBe(false)
})

test('authorization across maintenance ticks cannot label old output as the new Thread', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const firstThread = randomUUID(),
    secondThread = randomUUID()
  const authorization = Promise.withResolvers<void>()
  const oldOutput = Promise.withResolvers<SessionResult>()
  let authorizing = false,
    authorized = false,
    oldReads = 0,
    readsAtAuthorizationStart = 0
  const result = (threadId: string, text: string): SessionResult => ({
    type: 'session.result',
    operation_id: randomUUID(),
    session_id: threadId,
    ok: true,
    text,
    cursor: 'epoch:5',
    gap: false,
  })
  const f = await fixture({
    thread: async (_employee, threadId) => {
      if (threadId === secondThread) {
        readsAtAuthorizationStart = oldReads
        authorizing = true
        await authorization.promise
        authorized = true
      }
    },
    output: async (_employee, threadId) => {
      if (threadId === firstThread) {
        oldReads++
        return authorizing && !authorized ? oldOutput.promise : result(firstThread, 'first reply')
      }
      return result(secondThread, 'new reply')
    },
  })
  cleanups.push(async () => {
    authorization.resolve()
    oldOutput.resolve(result(firstThread, 'late old reply'))
  })
  const browser = new WebSocket(`${f.base}/api/v1/events`, {
    headers: { Origin: 'https://baton.local', Cookie: 'owner' },
  })
  const frames: Array<Record<string, unknown>> = []
  browser.on('message', (data) => frames.push(JSON.parse(webSocketText(data)) as Record<string, unknown>))
  await once(browser, 'open')
  await expect.poll(() => frames[0]?.type).toBe('ready')
  browser.send(JSON.stringify({ thread_id: firstThread }))
  await expect.poll(() => frames.some((frame) => frame.text === 'first reply')).toBe(true)
  browser.send(JSON.stringify({ thread_id: secondThread, cursor: 'new:0' }))
  await expect.poll(() => authorizing).toBe(true)
  await vi.advanceTimersByTimeAsync(150)
  const readsDuringAuthorization = oldReads
  authorization.resolve()
  await expect.poll(() => authorized).toBe(true)
  oldOutput.resolve(result(firstThread, 'late old reply'))
  await vi.advanceTimersByTimeAsync(50)
  await expect
    .poll(() => frames.some((frame) => frame.thread_id === secondThread && frame.text === 'new reply'))
    .toBe(true)
  expect(readsDuringAuthorization).toBe(readsAtAuthorizationStart)
  expect(frames.some((frame) => frame.thread_id === secondThread && frame.text === 'late old reply')).toBe(false)
  for (const frame of frames.filter((value) => value.type === 'thread.output' && value.thread_id === secondThread)) {
    expect(frame).toMatchObject({ session_id: secondThread, ok: true, text: 'new reply', gap: false })
  }
  expect(browser.readyState).toBe(WebSocket.OPEN)
})

test('old output failure after switching cannot inject a gap into the new Thread', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const firstThread = randomUUID(),
    secondThread = randomUUID()
  const oldOutput = Promise.withResolvers<SessionResult>()
  let readingOld = false,
    authorizedNew = false
  const f = await fixture({
    thread: async (_employee, threadId) => {
      if (threadId === secondThread) authorizedNew = true
    },
    output: async (_employee, threadId) => {
      if (threadId === firstThread) {
        readingOld = true
        return oldOutput.promise
      }
      return {
        type: 'session.result',
        operation_id: randomUUID(),
        session_id: threadId,
        ok: true,
        text: 'new reply',
        cursor: 'new:9',
        gap: false,
      }
    },
  })
  cleanups.push(async () => {
    oldOutput.resolve({
      type: 'session.result',
      operation_id: randomUUID(),
      session_id: firstThread,
      ok: true,
      gap: false,
    })
  })
  const browser = new WebSocket(`${f.base}/api/v1/events`, {
    headers: { Origin: 'https://baton.local', Cookie: 'owner' },
  })
  const frames: Array<Record<string, unknown>> = []
  browser.on('message', (data) => frames.push(JSON.parse(webSocketText(data)) as Record<string, unknown>))
  await once(browser, 'open')
  await expect.poll(() => frames[0]?.type).toBe('ready')
  browser.send(JSON.stringify({ thread_id: firstThread }))
  await expect.poll(() => readingOld).toBe(true)
  browser.send(JSON.stringify({ thread_id: '' }))
  browser.send(JSON.stringify({ thread_id: secondThread, cursor: 'new:0' }))
  await expect.poll(() => authorizedNew).toBe(true)
  oldOutput.reject(new AppError(503, 'node_timeout'))
  await vi.advanceTimersByTimeAsync(50)
  await expect
    .poll(() => frames.some((frame) => frame.thread_id === secondThread && frame.text === 'new reply'))
    .toBe(true)
  expect(frames.some((frame) => frame.type === 'thread.output' && (frame.ok === false || frame.gap === true))).toBe(
    false,
  )
  expect(browser.readyState).toBe(WebSocket.OPEN)
})
