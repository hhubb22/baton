import { BUILD } from '@baton/protocol/release'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { Effect, Schema } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type WebSocket from 'ws'
import type { Envelope, Frame, ThreadReport, RuntimeAgent, WorkerRequest, WorkerIPCMessage } from '@baton/protocol'
import { IPCError } from './ipc.ts'
import { webSocketText } from './transport.ts'
import type { DaemonWorkerHost } from './host.ts'
import { setupDaemon } from '../testing/daemon.ts'
import type { ProjectManager } from '../project/types.ts'
import { makeNodeLedger } from './ledger.ts'
import { reportBatondError } from '../cli.ts'
import { acquireProcessLock } from '../platform/lock.ts'
import { DeploymentInvalid } from './deployment.ts'
import { NeedsReauthentication } from './daemon.ts'
import { startTelemetryRelay } from './telemetry-relay.ts'
import { requestUpgrade } from './upgrade.ts'

vi.mock('../project/index.ts', () => ({
  makeProjectManager: () => {
    const unused = async (): Promise<never> => {
      throw new Error('Project operations are outside the daemon reconnect fixture')
    }
    const probe = async () => ({ version: '0.1.0', providers: [] })
    return Effect.succeed<ProjectManager>({
      setTransport() {},
      onDisconnect() {},
      command: unused,
      probe,
      report: probe,
      login: unused,
      subscriptions: probe,
      startDeviceLogin: unused,
      async close() {},
    })
  },
}))

it('decodes WebSocket data with UTF-8 characters split across buffers', () => {
  const text = '{"text":"你好🙂"}'
  const bytes = Buffer.from(text)
  const split = bytes.indexOf(Buffer.from('你')) + 1
  for (const data of [bytes, [bytes.subarray(0, split), bytes.subarray(split)], Uint8Array.from(bytes).buffer]) {
    expect(webSocketText(data)).toBe(text)
  }
})

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
const setup = () => setupDaemon(cleanup)
function control(socket: WebSocket, body: unknown, correlation?: string, id: string = randomUUID()) {
  socket.send(
    JSON.stringify({
      kind: 'envelope',
      envelope: {
        version: 1,
        message_id: id,
        route: { to: 'node' },
        priority: 'control',
        source: { kind: 'control' },
        ...(correlation ? { correlation_id: correlation } : {}),
        body,
      },
    }),
  )
}
const bodyOf = (frame: Frame) => (frame.envelope as unknown as Envelope)?.body as Record<string, unknown> | undefined

it('forwards daemon telemetry only while synchronized and connected', async () => {
  const { path, wss, start } = await setup()
  const relay = await startTelemetryRelay()
  cleanup.push(relay.close)
  const signals = new Set<string>()
  const forwarded: unknown[] = []
  let socket: WebSocket | undefined
  let syncId = ''
  wss.on('connection', (current) => {
    socket = current
    current.on('message', (raw) => {
      const frame = JSON.parse(webSocketText(raw)) as Frame
      if (frame.kind === 'auth') current.send(JSON.stringify({ kind: 'auth_result', ok: true }))
      const body = bodyOf(frame)
      if (body?.type === 'node.sync') {
        syncId = (frame.envelope as unknown as Envelope).message_id
        control(current, { type: 'node.sync_result', ok: true, telemetry: { forward: true } }, syncId)
      }
      if (body?.type === 'telemetry.export' && typeof body.signal === 'string') {
        signals.add(body.signal)
        forwarded.push(body.payload)
      }
    })
  })
  const daemon = start({ telemetryRelay: relay })
  await vi.waitFor(() => expect(signals.has('traces')).toBe(true), { timeout: 5000 })
  await vi.waitFor(() => expect(signals.has('logs')).toBe(true), { timeout: 5000 })
  await vi.waitFor(() => expect(signals.has('metrics')).toBe(true), { timeout: 5000 })
  control(socket!, { type: 'node.sync_result', ok: true }, syncId)
  await vi.waitFor(() => expect(relay.send).toBeUndefined())
  const disabledMarker = randomUUID()
  const authorization = decodeURIComponent(relay.headers.slice('authorization='.length))
  const post = (value: string) =>
    fetch(`${relay.endpoint}/v1/traces`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ value }),
    })
  await post(disabledMarker)
  control(socket!, { type: 'node.sync_result', ok: true, telemetry: { forward: true } }, syncId)
  await vi.waitFor(() => expect(relay.send).toBeDefined())
  const afterReenabled = randomUUID()
  await post(afterReenabled)
  await vi.waitFor(() => expect(JSON.stringify(forwarded)).toContain(afterReenabled))
  expect(JSON.stringify(forwarded)).not.toContain(disabledMarker)
  socket?.terminate()
  await vi.waitFor(() => expect(relay.send).toBeUndefined())
  const marker = randomUUID()
  await post(marker)
  await vi.waitFor(() => expect(relay.send).toBeDefined(), { timeout: 5000 })
  const current = randomUUID()
  await post(current)
  await vi.waitFor(() => expect(JSON.stringify(forwarded)).toContain(current))
  expect(JSON.stringify(forwarded)).not.toContain(marker)
  for (const name of ['node.db', 'node.db-wal']) {
    const bytes = await readFile(join(path, name)).catch(() => Buffer.alloc(0))
    expect(bytes.includes(Buffer.from(authorization))).toBe(false)
    expect(bytes.includes(Buffer.from(authorization.slice('Bearer '.length)))).toBe(false)
  }
  await daemon.stop()
})

it('drops local batches when the center does not enable forwarding', async () => {
  const { wss, start } = await setup()
  const relay = await startTelemetryRelay()
  cleanup.push(relay.close)
  let synced = false
  const forwarded: unknown[] = []
  wss.on('connection', (socket) =>
    socket.on('message', (raw) => {
      const frame = JSON.parse(webSocketText(raw)) as Frame
      if (frame.kind === 'auth') socket.send(JSON.stringify({ kind: 'auth_result', ok: true }))
      const body = bodyOf(frame)
      if (body?.type === 'node.sync') {
        control(socket, { type: 'node.sync_result', ok: true }, (frame.envelope as unknown as Envelope).message_id)
        synced = true
      }
      if (body?.type === 'telemetry.export') forwarded.push(body)
    }),
  )
  const daemon = start({ telemetryRelay: relay })
  await vi.waitFor(() => expect(synced).toBe(true))
  const authorization = decodeURIComponent(relay.headers.slice('authorization='.length))
  const response = await fetch(`${relay.endpoint}/v1/traces`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: '{}',
  })
  expect(response.status).toBe(200)
  expect(relay.send).toBeUndefined()
  expect(forwarded).toEqual([])
  await daemon.stop()
})

it('reconnects with the same incarnation, retains reports before Worker ACK, and redelivers without executing twice after restart', async () => {
  const { path, id, wss, start } = await setup()
  const threadId = randomUUID(),
    commandId = randomUUID()
  const reports: ThreadReport[] = []
  const workerAcks = new Set<string>()
  let openCount = 0,
    statusCount = 0,
    releaseReports = false,
    generation = ''
  const forwarded: WorkerRequest[] = []
  const host: DaemonWorkerHost = {
    async ensureWorker() {},
    async request(_threadId, req): Promise<WorkerIPCMessage> {
      if (req.type === 'thread_open') {
        openCount++
        generation = req.storage_generation
        reports.push(
          {
            type: 'thread.report',
            thread_id: threadId,
            storage_generation: generation,
            event_id: randomUUID(),
            worker_seq: 1,
            kind: 'thread.opened',
          },
          {
            type: 'thread.report',
            thread_id: threadId,
            storage_generation: generation,
            event_id: randomUUID(),
            worker_seq: 2,
            kind: 'command.completed',
            command_id: commandId,
            command_outcome: 'succeeded',
            reason: '',
          },
        )
        return {
          type: 'result',
          ok: true,
          receipt: { command_id: commandId, thread_id: threadId, storage_generation: generation, action: 'open' },
          command_status: { command_id: commandId, state: 'accepted' },
        }
      }
      if (req.type === 'status') {
        statusCount++
        return {
          type: 'result',
          ok: true,
          worker_ready: true,
          ...(generation
            ? { session_id: threadId, runtime_mode: 'full-access' as const, storage_generation: generation }
            : {}),
        }
      }
      if (req.type === 'thread_pending')
        return {
          type: 'result',
          ok: true,
          worker_ready: true,
          session_id: threadId,
          runtime_mode: 'full-access',
          storage_generation: generation,
          thread_reports: releaseReports ? reports.filter((r) => !workerAcks.has(r.event_id)) : [],
        }
      if (req.type === 'thread_ack') {
        const db = new DatabaseSync(join(path, 'node.db'), { readOnly: true })
        try {
          expect(db.prepare('SELECT event_id FROM node_outbox WHERE event_id=?').get(req.event_id)?.event_id).toBe(
            req.event_id,
          )
        } finally {
          db.close()
        }
        workerAcks.add(req.event_id)
        return { type: 'result', ok: true }
      }
      if (req.type === 'session_request') {
        forwarded.push(req)
        return {
          type: 'result',
          ok: true,
          session_result: {
            type: 'session.result',
            operation_id: req.session_request.operation_id,
            session_id: threadId,
            ok: true,
            text: 'local output',
            gap: false,
          },
        }
      }
      return { type: 'result', ok: false }
    },
  }
  const incarnations: string[] = [],
    reportDeliveries: string[] = []
  let received = Promise.withResolvers<void>()
  const outputRead = Promise.withResolvers<void>()
  let completed = 0,
    output = ''
  let sessions = 0
  const command = {
    type: 'thread.command',
    action: 'open',
    thread_id: threadId,
    agent_type: 'cursor',
    runtime_mode: 'full-access',
    working_directory: path,
  }
  wss.on('connection', (socket) => {
    sessions++
    const session = sessions
    let sent = false
    socket.on('message', (raw) => {
      const frame = JSON.parse(webSocketText(raw)) as Frame
      if (frame.kind === 'auth') {
        expect(frame.token).toBe(id.credential.token)
        incarnations.push(frame.incarnation!)
        socket.send(JSON.stringify({ kind: 'auth_result', ok: true }))
        return
      }
      const body = bodyOf(frame)
      if (!body) return
      const env = frame.envelope as unknown as Envelope
      if (body.type === 'node.sync') {
        control(socket, { type: 'node.sync_result', ok: true }, env.message_id)
      } else if (body.type === 'node.runtime_report') {
        control(socket, { type: 'node.runtime_report_result', ok: true, report_version: 1 }, env.message_id)
        const report = body.report as { agents: RuntimeAgent[] }
        if (!sent && report.agents[0]?.status === 'available') {
          sent = true
          control(socket, command, undefined, commandId)
        }
      } else if (body.type === 'thread.command_result') {
        expect(body.ok).toBe(true)
        received.resolve()
      } else if (body.type === 'thread.report') {
        reportDeliveries.push(String(body.event_id))
        if (session === 1) {
          socket.terminate()
          return
        }
        control(
          socket,
          {
            type: 'thread.report_result',
            thread_id: threadId,
            event_id: body.event_id,
            worker_seq: body.worker_seq,
            ok: true,
          },
          env.message_id,
        )
        if (body.kind === 'command.completed') completed++
        if (session === 2 && body.worker_seq === 2)
          control(socket, {
            type: 'session.request',
            operation_id: randomUUID(),
            session_id: threadId,
            action: 'output',
          })
      } else if (body.type === 'session.result') {
        output = String(body.text)
        outputRead.resolve()
      }
    })
  })
  const first = start({ host })
  await received.promise
  expect(completed).toBe(0)
  expect(openCount).toBe(1)
  releaseReports = true
  await outputRead.promise
  expect(completed).toBeGreaterThan(0)
  expect(output).toBe('local output')
  expect(first.failure()).toBeUndefined()
  expect(new Set(incarnations)).toHaveLength(1)
  expect(reportDeliveries.filter((e) => e === reports[0]!.event_id).length).toBeGreaterThan(1)
  expect(workerAcks.size).toBe(2)
  expect(forwarded[0]?.session_request?.action).toBe('output')
  await first.stop()
  received = Promise.withResolvers<void>()
  const second = start({ host })
  await received.promise
  expect(openCount).toBe(1)
  expect(statusCount).toBeGreaterThan(0)
  expect(new Set(incarnations)).toHaveLength(2)
  expect(second.failure()).toBeUndefined()
}, 15_000)

it('keeps the default authentication budget and starts a separate synchronization budget after auth', async () => {
  const { wss, start } = await setup()
  let now = 0
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
  cleanup.push(async () => {
    clock.mockRestore()
  })
  const connected = Promise.withResolvers<WebSocket>()
  const authSent = Promise.withResolvers<void>()
  const syncSent = Promise.withResolvers<void>()
  const shape = Schema.Struct({
    kind: Schema.String,
    envelope: Schema.optionalKey(Schema.Struct({ body: Schema.Struct({ type: Schema.String }) })),
  })
  wss.on('connection', (socket) => {
    connected.resolve(socket)
    socket.on('message', (raw) => {
      const frame = Schema.decodeUnknownSync(shape)(JSON.parse(webSocketText(raw)))
      if (frame.kind === 'auth') authSent.resolve()
      if (frame.envelope?.body.type === 'node.sync') syncSent.resolve()
    })
  })
  const daemon = start()
  const socket = await connected.promise
  await authSent.promise
  now = 369_000
  await delay(60)
  expect(socket.readyState).toBe(socket.OPEN)
  socket.send(JSON.stringify({ kind: 'auth_result', ok: true }))
  await syncSent.promise
  now = 738_999
  await delay(60)
  expect(socket.readyState).toBe(socket.OPEN)
  const closed = once(socket, 'close')
  now = 739_000
  await closed
  expect(daemon.failure()).toBeUndefined()
})

it('expires authentication after the configured control budget', async () => {
  const { wss, start } = await setup()
  let now = 0
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
  cleanup.push(async () => {
    clock.mockRestore()
  })
  const connected = Promise.withResolvers<WebSocket>()
  const authSent = Promise.withResolvers<void>()
  wss.on('connection', (socket) => {
    connected.resolve(socket)
    socket.once('message', () => authSent.resolve())
  })
  start({ controlTimeoutSeconds: 1 })
  const socket = await connected.promise
  await authSent.promise
  now = 999
  await delay(60)
  expect(socket.readyState).toBe(socket.OPEN)
  const closed = once(socket, 'close')
  now = 1000
  await closed
})

it.each(['dropped_reply', 'worker_unavailable'])(
  'keeps an accepted command pending after %s and queries the same ID on reconnect',
  async (failure) => {
    const { path, wss, start } = await setup()
    const threadId = randomUUID(),
      commandId = randomUUID()
    let deliveries = 0,
      connections = 0,
      releaseReports = false
    const accepted = Promise.withResolvers<void>()
    const releaseHandoff = Promise.withResolvers<void>()
    const reportRetried = Promise.withResolvers<void>()
    const received = Promise.withResolvers<void>()
    const completed = Promise.withResolvers<void>()
    let receipt: WorkerIPCMessage['receipt']
    const queried: string[] = []
    const acks: boolean[] = []
    const reports: ThreadReport[] = []
    const workerAcks = new Set<string>()
    let completion = false
    const host: DaemonWorkerHost = {
      async ensureWorker() {},
      async request(_threadId, request) {
        if (request.type === 'thread_open') {
          deliveries++
          receipt = {
            command_id: request.command_id,
            thread_id: threadId,
            storage_generation: request.storage_generation,
            action: 'open',
          }
          reports.push({
            type: 'thread.report',
            thread_id: threadId,
            storage_generation: request.storage_generation,
            event_id: randomUUID(),
            worker_seq: 1,
            kind: 'command.completed',
            command_id: commandId,
            command_outcome: 'succeeded',
            reason: '',
          })
          accepted.resolve()
          await releaseHandoff.promise
          if (failure === 'dropped_reply') throw new IPCError('timeout', 'Reply was lost after durable acceptance')
          return { type: 'result', ok: false, code: 'worker_unavailable' }
        }
        if (request.type === 'thread_command_status') {
          queried.push(request.command_id)
          await reportRetried.promise
          return {
            type: 'result',
            ok: true,
            receipt: receipt!,
            command_status: { command_id: commandId, state: 'accepted' },
          }
        }
        if (request.type === 'thread_pending')
          return {
            type: 'result',
            ok: true,
            worker_ready: true,
            session_id: threadId,
            runtime_mode: 'full-access',
            ...(receipt ? { storage_generation: receipt.storage_generation } : {}),
            thread_reports: releaseReports ? reports.filter((r) => !workerAcks.has(r.event_id)) : [],
          }
        if (request.type === 'thread_ack') {
          workerAcks.add(request.event_id)
          return { type: 'result', ok: true }
        }
        return {
          type: 'result',
          ok: true,
          worker_ready: true,
          ...(receipt
            ? {
                storage_generation: receipt.storage_generation,
                session_id: threadId,
                runtime_mode: 'full-access' as const,
              }
            : {}),
        }
      },
    }
    wss.on('connection', (socket) => {
      const connection = ++connections
      let sent = false,
        reconnectReports = 0
      socket.on('message', (raw) => {
        const frame = JSON.parse(webSocketText(raw)) as Frame
        if (frame.kind === 'auth') {
          socket.send(JSON.stringify({ kind: 'auth_result', ok: true }))
          return
        }
        const body = bodyOf(frame),
          env = frame.envelope as unknown as Envelope
        if (body?.type === 'node.sync') control(socket, { type: 'node.sync_result', ok: true }, env.message_id)
        if (body?.type === 'node.runtime_report') {
          // Hold the receipt query until an unacknowledged capability report is redelivered.
          if (connection > 1 && ++reconnectReports > 1) reportRetried.resolve()
          if (connection === 1 || reconnectReports > 1)
            control(socket, { type: 'node.runtime_report_result', ok: true, report_version: 1 }, env.message_id)
          const report = body.report as { agents: RuntimeAgent[] }
          if (!sent && report.agents[0]?.status === 'available') {
            sent = true
            control(
              socket,
              {
                type: 'thread.command',
                thread_id: threadId,
                action: 'open',
                agent_type: 'cursor',
                runtime_mode: 'full-access',
                working_directory: path,
              },
              undefined,
              commandId,
            )
          }
        }
        if (body?.type === 'thread.command_result') {
          acks.push(Boolean(body.ok))
          received.resolve()
        }
        if (body?.type === 'thread.report') {
          completion = body.kind === 'command.completed'
          control(
            socket,
            {
              type: 'thread.report_result',
              thread_id: threadId,
              event_id: body.event_id,
              worker_seq: body.worker_seq,
              ok: true,
            },
            env.message_id,
          )
          if (completion) completed.resolve()
        }
      })
    })
    const daemon = start({ host })
    cleanup.push(async () => {
      releaseHandoff.resolve()
      reportRetried.resolve()
    })
    await accepted.promise
    expect(deliveries).toBe(1)
    const db = new DatabaseSync(join(path, 'node.db'), { readOnly: true })
    try {
      const row = db.prepare('SELECT payload FROM node_commands WHERE id=?').get(commandId)
      expect((JSON.parse(String(row?.payload)) as { result?: unknown }).result).toBeUndefined()
    } finally {
      db.close()
    }
    expect(acks).toEqual([])
    releaseHandoff.resolve()
    await received.promise
    expect(connections).toBe(2)
    expect(acks).toEqual([true])
    expect(queried).toEqual([commandId])
    expect(deliveries).toBe(1)
    expect(completion).toBe(false)
    releaseReports = true
    await completed.promise
    await daemon.stop()
    expect(acks).toEqual([true])
    expect(queried).toEqual([commandId])
    expect(workerAcks.size).toBe(1)
    expect(daemon.failure()).toBeUndefined()
    const recovered = new DatabaseSync(join(path, 'node.db'), { readOnly: true })
    try {
      const payload = JSON.parse(
        String(recovered.prepare('SELECT payload FROM node_commands WHERE id=?').get(commandId)?.payload),
      ) as { result: { ok: boolean }; receipt: unknown }
      expect(payload.result.ok).toBe(true)
      expect(payload.receipt).toEqual(receipt)
    } finally {
      recovered.close()
    }
  },
)

it('reports lost Worker history while keeping control connected and withholding a fabricated command receipt', async () => {
  const { path, wss, start } = await setup()
  const threadId = randomUUID(),
    openId = randomUUID(),
    stopId = randomUUID()
  let alive = false,
    generation: string | undefined,
    launches = 0,
    connections = 0
  let historyLost = false
  const historyReported = Promise.withResolvers<void>()
  const delivered: string[] = [],
    receipts: string[] = []
  const host: DaemonWorkerHost = {
    async ensureWorker() {
      launches++
      alive = true
    },
    async request(_threadId, request) {
      if (!alive) throw new IPCError('closed', 'Worker is no longer reachable')
      if (request.type === 'status')
        return {
          type: 'result',
          ok: true,
          worker_ready: true,
          ...(generation
            ? { storage_generation: generation, session_id: threadId, runtime_mode: 'full-access' as const }
            : {}),
        }
      if (request.type === 'thread_open') {
        delivered.push(request.type)
        generation = request.storage_generation
        return {
          type: 'result',
          ok: true,
          receipt: {
            command_id: request.command_id,
            thread_id: threadId,
            storage_generation: generation,
            action: 'open',
          },
          command_status: { command_id: request.command_id, state: 'accepted' },
        }
      }
      if (request.type === 'thread_stop') delivered.push(request.type)
      return { type: 'result', ok: true, thread_reports: [] }
    },
  }
  let sent = false
  wss.on('connection', (socket) => {
    connections++
    socket.on('message', (raw) => {
      const frame = JSON.parse(webSocketText(raw)) as Frame
      if (frame.kind === 'auth') {
        socket.send(JSON.stringify({ kind: 'auth_result', ok: true }))
        return
      }
      const body = bodyOf(frame),
        env = frame.envelope as unknown as Envelope
      if (body?.type === 'node.sync') control(socket, { type: 'node.sync_result', ok: true }, env.message_id)
      if (body?.type === 'node.runtime_report') {
        control(socket, { type: 'node.runtime_report_result', ok: true, report_version: 1 }, env.message_id)
        const report = body.report as { agents: RuntimeAgent[] }
        if (!sent && report.agents[0]?.status === 'available') {
          sent = true
          control(
            socket,
            {
              type: 'thread.command',
              thread_id: threadId,
              action: 'open',
              agent_type: 'cursor',
              runtime_mode: 'full-access',
              working_directory: path,
            },
            undefined,
            openId,
          )
        }
      }
      if (body?.type === 'thread.command_result') {
        receipts.push(env.correlation_id!)
        if (env.correlation_id === openId) {
          alive = false
          control(
            socket,
            { type: 'thread.command', thread_id: threadId, action: 'stop', storage_generation: generation },
            undefined,
            stopId,
          )
        }
      }
      if (body?.type === 'thread.report') {
        historyLost = body.history_unavailable === true
        if (historyLost) historyReported.resolve()
        control(
          socket,
          {
            type: 'thread.report_result',
            thread_id: threadId,
            event_id: body.event_id,
            worker_seq: body.worker_seq,
            ok: true,
          },
          env.message_id,
        )
      }
    })
  })
  const daemon = start({ host })
  await historyReported.promise
  expect(historyLost).toBe(true)
  expect(delivered).toEqual(['thread_open'])
  expect(receipts).toEqual([openId])
  expect(launches).toBe(1)
  expect(connections).toBe(1)
  expect(daemon.failure()).toBeUndefined()
})

describe('daemon admission and ownership', () => {
  it('serves commands from the completed capability snapshot while a probe is slow', async () => {
    const { path, wss, start } = await setup()
    const commandId = randomUUID()
    const worker = vi.fn(async () => {
      throw new Error('Worker must not start before capability admission')
    })
    const received = Promise.withResolvers<Record<string, unknown>>()
    const connected = Promise.withResolvers<WebSocket>()
    const probing = Promise.withResolvers<void>()
    let probeFinished = false
    wss.on('connection', (socket) =>
      socket.on('message', (raw) => {
        const frame = JSON.parse(webSocketText(raw)) as Frame
        if (frame.kind === 'auth') {
          socket.send(JSON.stringify({ kind: 'auth_result', ok: true }))
          return
        }
        const body = bodyOf(frame)
        const env = frame.envelope as unknown as Envelope
        if (body?.type === 'node.sync') control(socket, { type: 'node.sync_result', ok: true }, env.message_id)
        if (body?.type === 'node.runtime_report') {
          control(socket, { type: 'node.runtime_report_result', ok: true, report_version: 1 }, env.message_id)
          connected.resolve(socket)
        }
        if (body?.type === 'thread.command_result') received.resolve(body)
      }),
    )
    const first = start({
      host: { ensureWorker: worker, request: worker },
      probe: (signal) =>
        new Promise((_resolve, reject) => {
          probing.resolve()
          signal.addEventListener(
            'abort',
            () => {
              probeFinished = true
              reject(new Error('cancelled'))
            },
            { once: true },
          )
        }),
    })
    await probing.promise
    control(
      await connected.promise,
      {
        type: 'thread.command',
        thread_id: randomUUID(),
        action: 'open',
        agent_type: 'cursor',
        runtime_mode: 'full-access',
        working_directory: path,
      },
      undefined,
      commandId,
    )
    expect((await received.promise).code).toBe('agent_unavailable')
    expect(probeFinished).toBe(false)
    expect(worker).not.toHaveBeenCalled()
    expect(first.failure()).toBeUndefined()
  })

  it('rejects a second daemon while the data directory is owned', async () => {
    const { wss, start } = await setup()
    const connected = once(wss, 'connection')
    const first = start()
    await connected
    const duplicate = start()
    await duplicate.running
    expect(duplicate.failure()).toBeDefined()
    expect(String(duplicate.failure())).toContain('Process lock')
    expect(first.failure()).toBeUndefined()
  })

  it('keeps the process lock until an interrupted Worker handoff has finished', async () => {
    const { path, wss, start } = await setup()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const starting = Promise.withResolvers<void>()
    const host: DaemonWorkerHost = {
      async ensureWorker() {
        starting.resolve()
        await gate
      },
      async request(_threadId, request) {
        if (request.type === 'thread_open')
          return {
            type: 'result',
            ok: true,
            receipt: {
              command_id: request.command_id,
              thread_id: request.thread_id,
              storage_generation: request.storage_generation,
              action: 'open',
            },
            command_status: { command_id: request.command_id, state: 'accepted' },
          }
        return { type: 'result', ok: true, thread_reports: [] }
      },
    }
    let sent = false
    wss.on('connection', (socket) =>
      socket.on('message', (raw) => {
        const frame = JSON.parse(webSocketText(raw)) as Frame
        if (frame.kind === 'auth') {
          socket.send(JSON.stringify({ kind: 'auth_result', ok: true }))
          return
        }
        const body = bodyOf(frame),
          env = frame.envelope as unknown as Envelope
        if (body?.type === 'node.sync') control(socket, { type: 'node.sync_result', ok: true }, env.message_id)
        if (body?.type === 'node.runtime_report') {
          control(socket, { type: 'node.runtime_report_result', ok: true, report_version: 1 }, env.message_id)
          const report = body.report as { agents: RuntimeAgent[] }
          if (sent || report.agents[0]?.status !== 'available') return
          sent = true
          control(socket, {
            type: 'thread.command',
            thread_id: randomUUID(),
            action: 'open',
            agent_type: 'cursor',
            runtime_mode: 'full-access',
            working_directory: path,
          })
        }
      }),
    )
    const first = start({ host })
    cleanup.push(async () => release())
    try {
      await starting.promise
      let stopped = false
      const stopping = first.stop().then(() => {
        stopped = true
      })
      const duplicate = start({ host })
      await duplicate.running
      expect(duplicate.failure()).toBeDefined()
      expect(String(duplicate.failure())).toContain('Process lock')
      expect(stopped).toBe(false)
      release()
      await stopping
      expect(stopped).toBe(true)
    } finally {
      release()
    }
  })
})

it.each(['unavailable', undefined, 'incarnation_conflict'])(
  'retries a transient or unclassified auth_result %s using the same identity',
  async (code) => {
    const { id, wss, start } = await setup()
    const incarnations: string[] = [],
      tokens: string[] = []
    let connections = 0
    const synced = Promise.withResolvers<void>()
    wss.on('connection', (socket) => {
      const connection = ++connections
      socket.on('message', (raw) => {
        const frame = JSON.parse(webSocketText(raw)) as Frame
        if (frame.kind === 'auth') {
          incarnations.push(frame.incarnation!)
          tokens.push(frame.token!)
          socket.send(
            JSON.stringify(
              connection === 1
                ? { kind: 'auth_result', ok: false, ...(code ? { code } : {}) }
                : { kind: 'auth_result', ok: true },
            ),
          )
          return
        }
        const body = bodyOf(frame),
          env = frame.envelope as unknown as Envelope
        if (body?.type === 'node.sync') {
          synced.resolve()
          control(socket, { type: 'node.sync_result', ok: true }, env.message_id)
        }
      })
    })
    const daemon = start()
    await synced.promise
    expect(connections).toBe(2)
    expect(new Set(incarnations).size).toBe(1)
    expect(tokens).toEqual([id.credential.token, id.credential.token])
    expect(daemon.failure()).toBeUndefined()
  },
)

it('retains upgrade management, local commands and unsent reports after protocol rejection', async () => {
  const { path, wss, start } = await setup()
  const threadId = randomUUID(),
    commandId = randomUUID(),
    generation = randomUUID()
  const report: ThreadReport = {
    type: 'thread.report',
    thread_id: threadId,
    storage_generation: generation,
    event_id: randomUUID(),
    worker_seq: 1,
    kind: 'thread.unknown',
    reason: 'Retained local result',
  }
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const ledger = yield* makeNodeLedger(join(path, 'node.db'))
        yield* ledger.prepare({
          id: commandId,
          hash: 'local-command',
          request: {
            type: 'thread_stop',
            ok: false,
            command_id: commandId,
            thread_id: threadId,
            storage_generation: generation,
          },
        })
        yield* ledger.ingest(report)
      }),
    ),
  )
  const snapshot = () => {
    const db = new DatabaseSync(join(path, 'node.db'), { readOnly: true })
    try {
      return {
        commands: db.prepare('SELECT * FROM node_commands ORDER BY id').all(),
        reports: db.prepare('SELECT * FROM node_outbox ORDER BY seq').all(),
      }
    } finally {
      db.close()
    }
  }
  const before = snapshot()
  let connections = 0
  const sent: Frame[] = []
  wss.on('connection', (socket) => {
    connections++
    socket.on('message', (raw) => {
      const frame = JSON.parse(webSocketText(raw)) as Frame
      sent.push(frame)
      if (frame.kind === 'auth')
        socket.send(
          JSON.stringify({
            kind: 'auth_result',
            ok: false,
            code: 'node_version_incompatible',
            message: '中心 v1.0.0 协议 2 与节点 development 协议 1 不兼容，请升级后重新运行 batond。',
            version_incompatibility: {
              center_version: 'v1.0.0',
              daemon_version: frame.daemon_version,
              center_protocol_version: 2,
              daemon_protocol_version: frame.protocol_version,
              supported_daemon_versions: ['v1.0.0'],
              reason: 'protocol_version_unsupported',
              guidance: '请升级后重新运行 batond。',
            },
          }),
        )
    })
  })
  const daemon = start()
  await vi.waitFor(async () => {
    expect(JSON.parse(await readFile(join(path, 'daemon-status.json'), 'utf8'))).toMatchObject({
      pid: process.pid,
      state: 'rejected',
      batond_version: BUILD.version,
      code: 'node_version_incompatible',
    })
  })
  expect(connections).toBeGreaterThanOrEqual(1)
  for (const frame of sent)
    expect(frame).toMatchObject({ kind: 'auth', daemon_version: 'development', protocol_version: 1 })
  expect(snapshot()).toEqual(before)
  expect(daemon.failure()).toBeUndefined()
  expect(await requestUpgrade(path, 'upgrade_status')).toMatchObject({ state: null })
  await daemon.stop()
})

it.each(['invalid_node_credential', 'node_source_rejected', 'credential_revoked'])(
  'stops reconnecting for terminal auth_result %s',
  async (code) => {
    const { path, id, wss, start } = await setup()
    let connections = 0
    wss.on('connection', (socket) => {
      connections++
      socket.on('message', (raw) => {
        if ((JSON.parse(webSocketText(raw)) as Frame).kind === 'auth')
          socket.send(JSON.stringify({ kind: 'auth_result', ok: false, code }))
      })
    })
    const daemon = start()
    await daemon.running
    expect(daemon.failure()).toBeDefined()
    expect(String(daemon.failure())).toContain('需要重新认证')
    expect(connections).toBe(1)
    const status = await readFile(join(path, 'daemon-status.json'), 'utf8')
    expect(JSON.parse(status)).toMatchObject({ pid: process.pid, state: 'rejected', code: 'needs_reauth' })
    expect(status).not.toContain(id.credential.token)
  },
)

it.each(['invalid_node_credential', 'node_source_rejected', 'credential_revoked'])(
  'stops reconnecting for terminal error %s',
  async (code) => {
    const { wss, start } = await setup()
    let connections = 0
    wss.on('connection', (socket) => {
      connections++
      socket.on('message', (raw) => {
        if ((JSON.parse(webSocketText(raw)) as Frame).kind === 'auth')
          socket.send(JSON.stringify({ kind: 'error', code }))
      })
    })
    const daemon = start()
    await daemon.running
    expect(daemon.failure()).toBeDefined()
    expect(String(daemon.failure())).toContain('需要重新认证')
    expect(connections).toBe(1)
  },
)

it('reports connecting, online, reconnecting and stopping while retaining the daemon lock until shutdown', async () => {
  const { path, id, wss, start } = await setup()
  const status = async () =>
    JSON.parse(await readFile(join(path, 'daemon-status.json'), 'utf8')) as {
      pid: number
      state: string
      updated_at: string
    }
  const sockets: WebSocket[] = []
  wss.on('connection', (socket) => {
    sockets.push(socket)
  })
  const daemon = start()
  await vi.waitFor(() => expect(sockets).toHaveLength(1))
  expect(await status()).toMatchObject({ pid: process.pid, state: 'connecting' })
  sockets[0]!.send(JSON.stringify({ kind: 'auth_result', ok: true }))
  await vi.waitFor(async () => expect((await status()).state).toBe('online'))
  expect(Number.isNaN(Date.parse((await status()).updated_at))).toBe(false)
  const second = start()
  await second.running
  const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const previousExit = process.exitCode
  try {
    reportBatondError(second.failure(), 'run')
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({ code: 'daemon_running' })
    expect(process.exitCode).toBe(1)
    expect((await status()).state).toBe('online')
  } finally {
    output.mockRestore()
    process.exitCode = previousExit
  }
  sockets[0]!.terminate()
  await vi.waitFor(async () => expect((await status()).state).toBe('connecting'))
  await daemon.stop()
  expect(await status()).toMatchObject({ pid: process.pid, state: 'stopping' })
  expect(await readFile(join(path, 'daemon-status.json'), 'utf8')).not.toContain(id.credential.token)
})

it('maps daemon lock contention and deployment/authentication failures to public codes and exit statuses', async () => {
  const { path, start } = await setup()
  const release = await acquireProcessLock(join(path, 'daemon.lock'))
  cleanup.push(release)
  const daemon = start()
  await daemon.running
  const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const previousExit = process.exitCode
  try {
    for (const [error, code, exit] of [
      [daemon.failure(), 'daemon_running', 1],
      [new NeedsReauthentication(), 'needs_reauth', 78],
      [new DeploymentInvalid(), 'deployment_invalid', 1],
    ] as const) {
      reportBatondError(error, 'run')
      expect(JSON.parse(String(output.mock.lastCall?.[0]))).toMatchObject({ code })
      expect(process.exitCode).toBe(exit)
    }
  } finally {
    output.mockRestore()
    process.exitCode = previousExit
  }
})
