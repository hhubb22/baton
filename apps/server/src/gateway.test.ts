import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { Option, Tracer } from 'effect'
import { traceParent } from '@baton/telemetry'
import { afterEach, expect, test, vi } from 'vite-plus/test'
import type { SessionResult } from '@baton/protocol'
import { WebSocket } from 'ws'
import { AppError, type NodeSource } from './errors.ts'
import { webSocketText, Gateway, type GatewayHandlers } from './gateway.ts'

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

async function fixture(overrides: Partial<GatewayHandlers> = {}, tracer?: Tracer.Tracer) {
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
    { allowedOrigins: ['https://baton.local'], pollMs: 50, ...(tracer ? { tracer } : {}) },
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
    ws.send(JSON.stringify({ kind: 'auth', token: 'local-node', incarnation: randomUUID() }))
    await expect.poll(() => frames.some((frame) => frame.kind === 'auth_result')).toBe(true)
    ws.send(JSON.stringify(envelope({ type: 'node.sync', display_name: 'Test', system: 'macos', capabilities: [] })))
    await expect.poll(() => frames.some((frame) => frame.kind === 'envelope')).toBe(true)
    return { ws, frames }
  }
  return { gateway, base, employeeId, nodeId, seen, connect, source: () => source! }
}

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
