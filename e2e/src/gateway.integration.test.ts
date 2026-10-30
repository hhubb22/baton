import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Effect } from 'effect'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import type { Envelope, Frame, ThreadReport } from '@baton/protocol'
import { Gateway } from '@baton/server/gateway'
import { connectWebSocket } from '@baton/batond/daemon/transport'
import { makeNodeLedger } from '@baton/batond/daemon/ledger'
import type { DaemonWorkerHost } from '@baton/batond/daemon/host'
import { setupDaemon } from '@baton/batond/testing/daemon'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const setup = () => setupDaemon(cleanup)
const bodyOf = (frame: Frame) => (frame.envelope as unknown as Envelope)?.body as Record<string, unknown> | undefined

it('drains more than 128 durable reports through Gateway limits while accepting stop', async () => {
  const { path, id, start } = await setup()
  const threadId = randomUUID(),
    generation = randomUUID(),
    stopId = randomUUID(),
    openId = randomUUID()
  const reports: ThreadReport[] = Array.from({ length: 160 }, (_, index) => ({
    type: 'thread.report',
    thread_id: threadId,
    storage_generation: generation,
    event_id: randomUUID(),
    worker_seq: index + 1,
    kind: 'reply',
    content: `reply ${index + 1}`,
  }))
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const ledger = yield* makeNodeLedger(join(path, 'node.db'))
        yield* ledger.prepare({
          id: openId,
          hash: 'offline-open',
          request: {
            type: 'thread_open',
            ok: false,
            command_id: openId,
            thread_id: threadId,
            storage_generation: generation,
            open_config: {
              thread_id: threadId,
              node_id: id.node_id,
              storage_generation: generation,
              agent_type: 'cursor',
              runtime_mode: 'full-access',
              working_directory: path,
              execution_timeout_seconds: 60,
              adapter_config: {},
            },
          },
        })
        yield* ledger.received(openId, {
          type: 'thread.command_result',
          thread_id: threadId,
          ok: true,
          storage_generation: generation,
        })
        for (const report of reports) yield* ledger.ingest(report)
      }),
    ),
  )
  await chmod(join(path, 'node.db'), 0o600)
  const center = new DatabaseSync(join(path, 'center.db'))
  center.exec('CREATE TABLE reports (event_id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE)')
  cleanup.push(async () => center.close())
  const committed = () => Number(center.prepare('SELECT count(*) AS count FROM reports').get()!.count)
  const http = createServer()
  let connections = 0,
    disconnected = 0,
    stopSent = false,
    stopAcked = false,
    stopSentAt = 0,
    stopAckMs = 0,
    stopAckCount = 0,
    heartbeatReplies = 0
  const gateway = new Gateway(
    http,
    {
      authenticate: async (token, incarnation, connId) => {
        expect(token).toBe(id.credential.token)
        connections++
        return {
          node_id: id.node_id,
          employee_id: id.employee_id,
          credential_id: id.credential.id,
          incarnation,
          conn_id: connId,
        }
      },
      validate: async () => {},
      heartbeat: async () => {
        heartbeatReplies++
      },
      disconnected: async () => {
        disconnected++
      },
      browser: async () => id.employee_id,
      thread: async () => {},
      output: async () => ({
        type: 'session.result',
        operation_id: randomUUID(),
        session_id: threadId,
        ok: true,
        gap: false,
      }),
      handle: async (_source, env) => {
        const body = env.body as Record<string, unknown>
        if (body.type === 'node.sync') return { type: 'node.sync_result', ok: true }
        if (body.type === 'node.runtime_report')
          return { type: 'node.runtime_report_result', ok: true, report_version: 1 }
        if (body.type === 'thread.command_result') {
          expect(env.correlation_id).toBe(stopId)
          expect(body.ok).toBe(true)
          stopAcked = true
          stopAckMs = performance.now() - stopSentAt
          stopAckCount = committed()
          return undefined
        }
        const report = body as unknown as ThreadReport
        expect(report.type).toBe('thread.report')
        await delay(25)
        const previous = center.prepare('SELECT seq FROM reports WHERE event_id=?').get(report.event_id)
        if (!previous) {
          expect(report.worker_seq).toBe(committed() + 1)
          center.prepare('INSERT INTO reports VALUES(?,?)').run(report.event_id, report.worker_seq)
        } else expect(previous.seq).toBe(report.worker_seq)
        if (!stopSent && committed() >= 8) {
          stopSent = true
          stopSentAt = performance.now()
          expect(
            gateway.send(id.node_id, id.employee_id, stopId, {
              type: 'thread.command',
              thread_id: threadId,
              storage_generation: generation,
              action: 'stop',
            }),
          ).toBe(true)
        }
        return {
          type: 'thread.report_result',
          thread_id: threadId,
          event_id: report.event_id,
          worker_seq: report.worker_seq,
          ok: true,
        }
      },
    },
    { allowedOrigins: [], heartbeatMs: 100, offlineMs: 500, pollMs: 50 },
  )
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const address = http.address() as import('node:net').AddressInfo
  cleanup.push(async () => {
    await gateway.close()
    await new Promise<void>((resolve) => http.close(() => resolve()))
  })
  const outstanding = new Set<string>(),
    sends: number[] = []
  let maxOutstanding = 0
  const host: DaemonWorkerHost = {
    async ensureWorker() {
      throw new Error('Surviving Worker must not be relaunched')
    },
    async request(_threadId, request) {
      if (request.type === 'status')
        return {
          type: 'result',
          ok: true,
          worker_ready: true,
          storage_generation: generation,
          runtime_mode: 'full-access',
        }
      if (request.type === 'thread_stop')
        return {
          type: 'result',
          ok: true,
          receipt: {
            command_id: request.command_id,
            thread_id: threadId,
            storage_generation: generation,
            action: 'stop',
          },
          command_status: { command_id: request.command_id, state: 'accepted' },
        }
      return { type: 'result', ok: true, thread_reports: [] }
    },
  }
  const daemon = start({
    host,
    heartbeatMs: 15_000,
    transport: async (_url, options) => {
      const connection = await connectWebSocket(`ws://127.0.0.1:${address.port}/v1/node`, options)
      return {
        close: () => connection.close(),
        send: async (frame) => {
          const body = bodyOf(frame)
          if (body?.type === 'thread.report') {
            outstanding.add(String(body.event_id))
            maxOutstanding = Math.max(maxOutstanding, outstanding.size)
            sends.push(performance.now())
          }
          await connection.send(frame)
        },
        frames: {
          async *[Symbol.asyncIterator]() {
            for await (const frame of connection.frames) {
              const body = bodyOf(frame)
              if (body?.type === 'thread.report_result' && body.ok) outstanding.delete(String(body.event_id))
              yield frame
            }
          },
        },
      }
    },
  })
  await vi.waitFor(
    () => {
      expect(daemon.failure()).toBeUndefined()
      expect(committed()).toBe(160)
      expect(outstanding.size).toBe(0)
    },
    { timeout: 12_000 },
  )
  expect(
    center
      .prepare('SELECT event_id FROM reports ORDER BY seq')
      .all()
      .map((row) => row.event_id),
  ).toEqual(reports.map((report) => report.event_id))
  expect(maxOutstanding).toBeLessThanOrEqual(8)
  expect(stopAcked).toBe(true)
  expect(stopAckCount).toBeLessThan(160)
  expect(stopAckMs).toBeLessThan(1000)
  expect(heartbeatReplies).toBeGreaterThan(3)
  expect(connections).toBe(1)
  expect(disconnected).toBe(0)
  expect(daemon.failure()).toBeUndefined()
  for (const sentAt of sends)
    expect(sends.filter((stamp) => stamp > sentAt - 1000 && stamp <= sentAt).length).toBeLessThanOrEqual(32)
}, 15_000)
