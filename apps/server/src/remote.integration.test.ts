import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { telemetryLayer } from '@baton/telemetry'
import type { TraceData } from 'effect/observability/OtlpTracer'
import { createDatabaseRuntime } from './database.ts'
import { mkdtemp, readFile, realpath, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { Effect, Exit, Scope, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { expect, test, vi } from 'vite-plus/test'
import * as P from '@baton/protocol'
import { startServer } from './server.ts'
import { openTestDatabase } from './test-database.ts'
import * as Auth from './auth.ts'
import * as Nodes from './nodes.ts'
import { registerNode } from '../../batond/src/daemon/identity.ts'
import { runDaemon } from '../../batond/src/daemon/daemon.ts'
import { connectWebSocket } from '../../batond/src/daemon/transport.ts'
import { initializeBrowseRoots } from '../../batond/src/daemon/roots.ts'
import { LocalWorkerHost } from '../../batond/src/daemon/host.ts'

test('HTTP → TS center → batond → independent Worker survives reconnects without resending input', async () => {
  const database = await openTestDatabase()
  const captured: Array<{
    service: string
    name: string
    traceId: string
    spanId: string
    parentSpanId: string | undefined
    attributes: Array<{ key: string; value: unknown }>
  }> = []
  const rawExports: string[] = []
  const collector = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += String(chunk)
    })
    request.on('end', () => {
      rawExports.push(body)
      const data = JSON.parse(body) as TraceData
      for (const resource of data.resourceSpans) {
        const service =
          resource.resource.attributes.find((attribute) => attribute.key === 'service.name')?.value.stringValue ?? ''
        for (const scope of resource.scopeSpans) for (const span of scope.spans) captured.push({ ...span, service })
      }
      response.writeHead(200).end('{}')
    })
  })
  await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve))
  const collectorAddress = collector.address() as { port: number }
  vi.stubEnv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', `http://127.0.0.1:${collectorAddress.port}/v1/traces`)
  vi.stubEnv('OTEL_TRACES_EXPORTER', 'otlp')
  vi.stubEnv('OTEL_BSP_SCHEDULE_DELAY', '20')
  const tracedRuntime = createDatabaseRuntime(
    { url: database.url, schema: database.schema },
    telemetryLayer('baton-server'),
  )
  const directory = await realpath(await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'btr-')))
  await chmod(directory, 0o700)
  const nodeDirectory = join(directory, 'node')
  const bundle = join(directory, 'replay-worker.cjs')
  const workers: string[] = []
  const host = new LocalWorkerHost(nodeDirectory, { executable: process.execPath, args: [bundle] })
  let daemonController: AbortController | undefined
  let daemon: Promise<unknown> | undefined
  let serverScope: Scope.Closeable | undefined
  let base = ''
  let port = 0
  let running: Effect.Success<ReturnType<typeof startServer>> | undefined
  const origin = 'https://baton.local'
  const signer = Nodes.CredentialSigner.generate()
  const start = async () => {
    await database.run(Nodes.resetConnections())
    serverScope = await Effect.runPromise(Scope.make())
    running = await tracedRuntime.runPromise(
      startServer({
        port,
        allowedOrigins: [origin],
        signer,
        dispatchMs: 20,
        heartbeatMs: 1000,
        offlineMs: 5000,
        webDirectory: directory,
      }).pipe(Effect.provideService(Scope.Scope, serverScope)),
    )
    port = running.port
    base = `http://127.0.0.1:${port}`
  }
  const stopCenter = async () => {
    if (serverScope) {
      await tracedRuntime.runPromise(Scope.close(serverScope, Exit.void))
      serverScope = undefined
    }
  }
  const stopDaemon = async () => {
    daemonController?.abort()
    await daemon
    daemonController = undefined
  }
  try {
    await build({
      entryPoints: [new URL('./fixtures/replay-worker.ts', import.meta.url).pathname],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node26',
      external: ['@cursor/sdk', '@cursor/sdk/*'],
      define: { 'import.meta.url': '__baton_import_meta_url__' },
      banner: { js: 'const __baton_import_meta_url__ = require("node:url").pathToFileURL(__filename).href;' },
      logLevel: 'silent',
    })
    await writeFile(join(directory, 'index.html'), '<!doctype html><title>Baton test</title>')
    await start()
    expect(await fetch(base).then((response) => response.text())).toContain('<title>Baton test</title>')
    expect((await fetch(base, { method: 'HEAD' })).status).toBe(200)
    const initialPassword = 'offline-initial-72-alpha'
    await database.run(Auth.createEmployee('remotealice', 'Alice', initialPassword))
    await database.run(Auth.createEmployee('remotebob', 'Bob', initialPassword))
    const login = async (username: string) => {
      let token = '',
        csrf = ''
      const request = async <A>(path: string, method = 'GET', data?: unknown): Promise<{ status: number; body: A }> => {
        const response = await fetch(`${base}/api/v1${path}`, {
          method,
          headers: {
            Origin: origin,
            'content-type': 'application/json',
            Cookie: token,
            'X-CSRF-Token': csrf,
            traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
          },
          ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
        })
        const cookie = response.headers.get('set-cookie')
        if (cookie) token = cookie.split(';')[0]
        const body = response.status === 204 ? null : ((await response.json()) as A)
        if (body && typeof body === 'object' && 'csrf_token' in body) csrf = String(body.csrf_token)
        return { status: response.status, body: body as A }
      }
      expect((await request('/login', 'POST', { username, password: initialPassword })).status).toBe(200)
      expect(
        (
          await request('/me/password', 'POST', {
            current_password: initialPassword,
            new_password: 'offline-updated-48-bravo',
          })
        ).status,
      ).toBe(204)
      expect((await request('/login', 'POST', { username, password: 'offline-updated-48-bravo' })).status).toBe(200)
      return request
    }
    const alice = await login('remotealice'),
      bob = await login('remotebob')
    const enrollment = await alice<P.EnrollmentResponse>('/node-enrollments', 'POST', {})
    expect(enrollment.status).toBe(201)
    const enrollmentFile = join(directory, 'enrollment')
    await writeFile(enrollmentFile, enrollment.body.enrollment_token, { mode: 0o600 })
    const identity = await registerNode({
      dataDirectory: nodeDirectory,
      coordinatorURL: `https://127.0.0.1:${port}`,
      enrollmentFile,
      displayName: 'Replay workstation',
      transport: async (_url, input) => {
        const response = await fetch(`${base}/api/v1/nodes/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        })
        expect(response.status).toBe(200)
        return response.json()
      },
    })
    await initializeBrowseRoots(nodeDirectory, directory)
    const capability: P.RuntimeAgent = {
      agent_type: 'cursor',
      version: '1.0.35',
      status: 'available',
      models: [{ id: 'default', name: 'Default' }],
      default_model: 'default',
      capabilities: { create: true, queue: true, steer: false, stop: true, resume: true, switch_model: false },
    }
    let droppedReceipt = false,
      droppedReplyAck = false
    const replyEvents = new Set<string>()
    const startDaemon = () => {
      daemonController = new AbortController()
      daemon = Effect.runPromiseExit(
        Effect.scoped(
          runDaemon({
            dataDirectory: nodeDirectory,
            identity,
            host,
            probe: async () => capability,
            heartbeatMs: 1000,
            pollIntervalMs: 25,
            probeIntervalMs: 60_000,
            transport: async (_url, options) => {
              const connection = await connectWebSocket(`ws://127.0.0.1:${port}/v1/node`, options)
              return {
                close: () => connection.close(),
                send: async (frame) => {
                  if (frame.kind === 'envelope') {
                    const body = Schema.decodeUnknownSync(P.NodeToControlBody)(
                      Schema.decodeUnknownSync(P.Envelope)(frame.envelope).body,
                    )
                    if (body.type === 'thread.command_result' && !droppedReceipt) {
                      droppedReceipt = true
                      return
                    }
                    if (body.type === 'thread.report' && body.kind === 'reply') replyEvents.add(body.event_id)
                  }
                  await connection.send(frame)
                },
                frames: {
                  async *[Symbol.asyncIterator]() {
                    for await (const frame of connection.frames) {
                      if (frame.kind === 'envelope') {
                        const body = Schema.decodeUnknownSync(P.ControlToNodeBody)(
                          Schema.decodeUnknownSync(P.Envelope)(frame.envelope).body,
                        )
                        if (
                          body.type === 'thread.report_result' &&
                          replyEvents.has(body.event_id) &&
                          !droppedReplyAck
                        ) {
                          droppedReplyAck = true
                          continue
                        }
                      }
                      yield frame
                    }
                  },
                },
              }
            },
          }),
        ).pipe(Effect.provide(telemetryLayer('batond'))),
        { signal: daemonController.signal },
      )
    }
    const ready = async () => {
      await expect
        .poll(
          async () => {
            const result = await alice<{ nodes: Array<{ synced: boolean; runtime_report?: P.RuntimeReport }> }>(
              '/nodes',
            )
            return (
              result.body.nodes[0]?.synced && result.body.nodes[0]?.runtime_report?.agents?.[0]?.status === 'available'
            )
          },
          { timeout: 10_000 },
        )
        .toBe(true)
    }
    startDaemon()
    await ready()
    expect((await bob<{ nodes: unknown[] }>('/nodes')).body.nodes).toEqual([])
    expect((await bob('/diagnostics')).body).toMatchObject({ nodes: 0, thread_statuses: [] })
    expect((await alice('/diagnostics')).body).toMatchObject({ nodes: 1 })
    expect((await bob(`/nodes/${identity.node_id}`)).status).toBe(403)
    const input: P.CreateBrowserThreadInput = {
      client_thread_id: randomUUID(),
      node_id: identity.node_id,
      agent_type: 'cursor',
      working_directory: directory,
      message: { client_message_id: randomUUID(), content: 'first' },
    }
    const created = await alice<P.Thread>('/threads', 'POST', input)
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const threadId = created.body.id
    workers.push(threadId)
    expect((await alice<P.Thread>('/threads', 'POST', input)).body.id).toBe(threadId)
    expect(
      (await alice('/threads', 'POST', { ...input, message: { ...input.message, content: 'conflict' } })).status,
    ).toBe(409)
    expect((await bob(`/threads/${threadId}`)).status).toBe(404)
    const view = () =>
      alice<P.ThreadView>(`/threads/${threadId}`).then((result) => Schema.decodeUnknownSync(P.ThreadView)(result.body))
    await expect
      .poll(
        async () => {
          const current = await view()
          expect(current.status_reason).toBe('')
          return current.status
        },
        { timeout: 10_000 },
      )
      .toBe('idle')
    let timeline: { status: number; body: P.ThreadTimeline }
    await expect
      .poll(
        async () => {
          timeline = await alice<P.ThreadTimeline>(`/threads/${threadId}/timeline?limit=100`)
          return timeline.body.events?.filter((event) => event.kind === 'reply').length
        },
        { timeout: 10_000 },
      )
      .toBe(1)
    const messageId = randomUUID()
    expect(
      (
        await alice(`/threads/${threadId}/messages`, 'POST', {
          client_message_id: messageId,
          content: 'hold',
          mode: 'queue',
        })
      ).status,
    ).toBe(202)
    await expect.poll(async () => (await view()).current_turn?.worker_turn_seq).toBe(2)
    await expect
      .poll(async () => (await alice<P.SessionResult>(`/threads/${threadId}/output`)).body.text)
      .toBe('working:hold\n')
    // Both owners restart; the independently running Worker and its native input remain unchanged.
    await stopDaemon()
    const workerStatus = await host.request(threadId, { type: 'status', ok: false })
    expect(workerStatus.agent_ready).toBe(true)
    await stopCenter()
    await start()
    startDaemon()
    await ready()
    expect((await alice<P.SessionResult>(`/threads/${threadId}/output`)).body.text).toBe('working:hold\n')
    expect((await alice(`/threads/${threadId}/stop`, 'POST', {})).status).toBe(202)
    await expect.poll(async () => (await view()).stop_confirmed_at, { timeout: 10_000 }).toBeTruthy()
    const resumed = await alice<P.ThreadView>(`/threads/${threadId}/resume`, 'POST', {})
    expect(resumed.status).toBe(202)
    await expect.poll(async () => (await view()).resume_pending, { timeout: 10_000 }).toBe(false)
    const finalMessage = { client_message_id: randomUUID(), content: 'last', mode: 'queue' }
    expect((await alice(`/threads/${threadId}/messages`, 'POST', finalMessage)).status).toBe(202)
    expect((await alice(`/threads/${threadId}/messages`, 'POST', finalMessage)).status).toBe(202)
    await expect
      .poll(
        async () => {
          timeline = await alice<P.ThreadTimeline>(`/threads/${threadId}/timeline?limit=100`)
          return timeline.body.events?.filter((event) => event.kind === 'reply').length
        },
        { timeout: 10_000 },
      )
      .toBe(2)
    const submissions = (await readFile(join(directory, 'submissions.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { text: string })
    expect(submissions.map((entry) => entry.text)).toEqual(['first', 'hold', 'last'])
    await expect
      .poll(() => captured.some((span) => span.service === 'baton-worker' && span.name === 'baton.worker.send'))
      .toBe(true)
    const sent = captured.find((span) => span.service === 'baton-worker' && span.name === 'baton.worker.send')!
    expect(sent.traceId).toBe('a'.repeat(32))
    const chain: string[] = []
    let parent: typeof sent | undefined = sent
    while (parent) {
      chain.push(`${parent.service}:${parent.name}`)
      parent = captured.find((span) => span.spanId === parent!.parentSpanId)
    }
    expect(chain).toEqual(
      expect.arrayContaining([
        'baton-server:baton.http.request',
        'baton-server:baton.command.enqueue',
        'baton-server:baton.command.dispatch',
        'baton-server:baton.gateway.send',
        'batond:baton.command.receive',
        'batond:baton.worker.dispatch',
        'baton-worker:baton.worker.receive',
      ]),
    )
    expect(captured.some((span) => span.attributes.some((attribute) => attribute.key === 'db.system.name'))).toBe(true)
    const exports = rawExports.join('')
    expect(exports).not.toContain('db.query.text')
    expect(exports).not.toContain('db.statement')
    expect(exports).not.toContain('INSERT INTO')
    expect(
      captured.some((span) =>
        span.attributes.some((attribute) => attribute.key === 'db.client.connection.wait_time_ms'),
      ),
    ).toBe(true)
    expect(exports).not.toContain(initialPassword)
    expect(exports).not.toContain('working:hold')
    expect(droppedReceipt).toBe(true)
    expect(droppedReplyAck).toBe(true)
    expect((await alice(`/threads/${threadId}/archive`, 'POST', {})).status).toBe(202)
    await expect.poll(async () => (await view()).status).toBe('archived')
    const result = await alice<P.RevokeNodeResponse>(`/nodes/${identity.node_id}/revoke`, 'POST', {})
    expect(result.body.status).toBe('effective')
    expect(
      (
        await database.run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            return yield* sql<{ count: number }>`SELECT count(*)::integer AS count FROM thread_replies`
          }),
        )
      )[0].count,
    ).toBe(2)
  } finally {
    await stopDaemon()
    for (const threadId of workers) {
      try {
        const status = await host.request(threadId, { type: 'status', ok: false })
        if (status.pid) process.kill(status.pid, 'SIGTERM')
        await expect
          .poll(async () => {
            try {
              await host.request(threadId, { type: 'status', ok: false })
              return false
            } catch {
              return true
            }
          })
          .toBe(true)
      } catch {
        /* A failed startup may already have released the Worker. */
      }
    }
    await stopCenter()
    await tracedRuntime.dispose()
    await database.close()
    vi.unstubAllEnvs()
    collector.closeAllConnections()
    await new Promise<void>((resolve) => collector.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}, 40_000)
