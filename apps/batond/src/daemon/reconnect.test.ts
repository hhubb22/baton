import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type WebSocket from 'ws'
import type { Envelope, Frame, ThreadReport, RuntimeAgent, WorkerRequest, WorkerIPCMessage } from '@baton/protocol'
import { IPCError } from './ipc.ts'
import { webSocketText } from './transport.ts'
import type { DaemonWorkerHost } from './threads.ts'
import { setupDaemon } from '../testing/daemon.ts'

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
        return { type: 'result', ok: true, worker_ready: true, storage_generation: generation }
      }
      if (req.type === 'thread_pending')
        return {
          type: 'result',
          ok: true,
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
  let accepted = 0,
    completed = 0,
    output = ''
  let sessions = 0
  const command = {
    type: 'thread.command',
    action: 'open',
    thread_id: threadId,
    agent_type: 'cursor',
    working_directory: path,
  }
  wss.on('connection', (socket) => {
    sessions++
    const session = sessions
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
        if (report.agents[0]?.status === 'available') control(socket, command, undefined, commandId)
      } else if (body.type === 'thread.command_result') {
        expect(body.ok).toBe(true)
        accepted++
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
      } else if (body.type === 'session.result') output = String(body.text)
    })
  })
  const first = start({ host })
  await vi.waitFor(() => expect(accepted).toBeGreaterThan(0), { timeout: 4000 })
  expect(completed).toBe(0)
  expect(openCount).toBe(1)
  releaseReports = true
  await vi.waitFor(
    () => {
      expect(completed).toBeGreaterThan(0)
      expect(output).toBe('local output')
    },
    { timeout: 6000 },
  )
  expect(first.failure()).toBeUndefined()
  expect(new Set(incarnations)).toHaveLength(1)
  expect(reportDeliveries.filter((e) => e === reports[0]!.event_id).length).toBeGreaterThan(1)
  expect(workerAcks.size).toBe(2)
  expect(forwarded[0]?.session_request?.action).toBe('output')
  await first.stop()
  const before = accepted
  const second = start({ host })
  await vi.waitFor(() => expect(accepted).toBeGreaterThan(before), { timeout: 4000 })
  expect(openCount).toBe(1)
  expect(statusCount).toBeGreaterThan(0)
  expect(new Set(incarnations)).toHaveLength(2)
  expect(second.failure()).toBeUndefined()
}, 15_000)

it.each(['dropped_reply', 'worker_unavailable'])(
  'keeps an accepted command pending after %s and queries the same ID on reconnect',
  async (failure) => {
    const { path, wss, start } = await setup()
    const threadId = randomUUID(),
      commandId = randomUUID()
    let deliveries = 0,
      connections = 0,
      allowQuery = false,
      releaseReports = false
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
          if (failure === 'dropped_reply') throw new IPCError('timeout', 'Reply was lost after durable acceptance')
          return { type: 'result', ok: false, code: 'worker_unavailable' }
        }
        if (request.type === 'thread_command_status') {
          queried.push(request.command_id)
          if (!allowQuery) throw new IPCError('closed', 'Receipt query is temporarily unreachable')
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
          ...(receipt ? { storage_generation: receipt.storage_generation } : {}),
        }
      },
    }
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
          control(
            socket,
            {
              type: 'thread.command',
              thread_id: threadId,
              action: 'open',
              agent_type: 'cursor',
              working_directory: path,
            },
            undefined,
            commandId,
          )
        }
        if (body?.type === 'thread.command_result') acks.push(Boolean(body.ok))
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
        }
      })
    })
    const daemon = start({ host })
    await vi.waitFor(() => expect(deliveries).toBe(1), { timeout: 2000 })
    const db = new DatabaseSync(join(path, 'node.db'), { readOnly: true })
    try {
      const row = db.prepare('SELECT payload FROM node_commands WHERE id=?').get(commandId)
      expect((JSON.parse(String(row?.payload)) as { result?: unknown }).result).toBeUndefined()
    } finally {
      db.close()
    }
    expect(acks).toEqual([])
    allowQuery = true
    await vi.waitFor(
      () => {
        expect(connections).toBeGreaterThan(1)
        expect(acks).toEqual([true])
      },
      { timeout: 4000 },
    )
    expect(queried).toEqual([commandId])
    expect(deliveries).toBe(1)
    expect(completion).toBe(false)
    releaseReports = true
    await vi.waitFor(() => expect(completion).toBe(true), { timeout: 2000 })
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
          ...(generation ? { storage_generation: generation } : {}),
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
        if (!sent) {
          sent = true
          control(
            socket,
            {
              type: 'thread.command',
              thread_id: threadId,
              action: 'open',
              agent_type: 'cursor',
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
  await vi.waitFor(() => expect(historyLost).toBe(true), { timeout: 3000 })
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
    let response: Record<string, unknown> | undefined
    let sentAt = 0
    let elapsed = 0
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
        if (body?.type === 'node.runtime_report' && !sentAt) {
          sentAt = performance.now()
          control(
            socket,
            {
              type: 'thread.command',
              thread_id: randomUUID(),
              action: 'open',
              agent_type: 'cursor',
              working_directory: path,
            },
            undefined,
            commandId,
          )
        }
        if (body?.type === 'thread.command_result') {
          response = body
          elapsed = performance.now() - sentAt
        }
      }),
    )
    const first = start({
      host: { ensureWorker: worker, request: worker },
      probe: (signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => {
              probeFinished = true
              reject(new Error('cancelled'))
            },
            { once: true },
          ),
        ),
    })
    await vi.waitFor(() => expect(response?.code).toBe('agent_unavailable'), { timeout: 2000 })
    expect(elapsed).toBeLessThan(1000)
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
    await vi.waitFor(() => expect(duplicate.failure()).toBeDefined(), { timeout: 2000 })
    expect(String(duplicate.failure())).toContain('Process lock')
    expect(first.failure()).toBeUndefined()
  })

  it('keeps the process lock until an interrupted Worker handoff has finished', async () => {
    const { path, wss, start } = await setup()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let starting = false
    const host: DaemonWorkerHost = {
      async ensureWorker() {
        starting = true
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
        if (body?.type === 'node.runtime_report')
          control(socket, {
            type: 'thread.command',
            thread_id: randomUUID(),
            action: 'open',
            agent_type: 'cursor',
            working_directory: path,
          })
      }),
    )
    const first = start({ host })
    try {
      await vi.waitFor(() => expect(starting).toBe(true), { timeout: 2000 })
      let stopped = false
      const stopping = first.stop().then(() => {
        stopped = true
      })
      const duplicate = start({ host })
      await vi.waitFor(() => expect(duplicate.failure()).toBeDefined(), { timeout: 2000 })
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
    let connections = 0,
      synced = false
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
          synced = true
          control(socket, { type: 'node.sync_result', ok: true }, env.message_id)
        }
      })
    })
    const daemon = start()
    await vi.waitFor(() => expect(synced).toBe(true), { timeout: 4000 })
    expect(connections).toBe(2)
    expect(new Set(incarnations).size).toBe(1)
    expect(tokens).toEqual([id.credential.token, id.credential.token])
    expect(daemon.failure()).toBeUndefined()
  },
)

it.each(['invalid_node_credential', 'node_source_rejected', 'credential_revoked'])(
  'stops reconnecting for terminal auth_result %s',
  async (code) => {
    const { wss, start } = await setup()
    let connections = 0
    wss.on('connection', (socket) => {
      connections++
      socket.on('message', (raw) => {
        if ((JSON.parse(webSocketText(raw)) as Frame).kind === 'auth')
          socket.send(JSON.stringify({ kind: 'auth_result', ok: false, code }))
      })
    })
    const daemon = start()
    await vi.waitFor(() => expect(daemon.failure()).toBeDefined(), { timeout: 2000 })
    expect(String(daemon.failure())).toContain('需要重新认证')
    expect(connections).toBe(1)
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
    await vi.waitFor(() => expect(daemon.failure()).toBeDefined(), { timeout: 2000 })
    expect(String(daemon.failure())).toContain('需要重新认证')
    expect(connections).toBe(1)
  },
)
