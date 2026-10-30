import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { Effect, Exit, Scope } from 'effect'
import type { TraceData } from 'effect/observability/OtlpTracer'
import { expect, test } from 'vite-plus/test'
import * as P from '@baton/protocol'
import { telemetryEnvironment, telemetryLayer } from '@baton/telemetry'
import { createDatabaseRuntime } from '@baton/server/database'
import { startServer } from '@baton/server/server'
import { openTestDatabase } from '@baton/server/testing/database'
import * as Auth from '@baton/server/auth'
import * as Nodes from '@baton/server/nodes'
import { registerNode } from '@baton/batond/daemon/identity'
import { runDaemon } from '@baton/batond/daemon/daemon'
import { connectWebSocket } from '@baton/batond/daemon/transport'
import { startTelemetryRelay } from '@baton/batond/daemon/telemetry-relay'

test('exports the center placement and real Project Runtime model call in one trace', async () => {
  const spans: Array<TraceData['resourceSpans'][number]['scopeSpans'][number]['spans'][number] & { service: string }> =
    []
  const authorization: Array<string | undefined> = []
  const relayDiagnostics = { runtimeBatches: 0, runBatches: 0, chatBatches: 0, sendFailures: 0 }
  const resources: Array<{
    service: string
    attributes: TraceData['resourceSpans'][number]['resource']['attributes']
  }> = []
  const collector = createServer((request, response) => {
    authorization.push(request.headers.authorization)
    let body = ''
    request.on('data', (chunk) => {
      body += String(chunk)
    })
    request.on('end', () => {
      const data = JSON.parse(body) as TraceData
      for (const resource of data.resourceSpans) {
        const service =
          resource.resource.attributes.find((entry) => entry.key === 'service.name')?.value.stringValue ?? ''
        resources.push({ service, attributes: resource.resource.attributes })
        for (const scope of resource.scopeSpans) for (const span of scope.spans) spans.push({ ...span, service })
      }
      response.writeHead(200).end('{}')
    })
  })
  await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve))
  const address = collector.address() as { port: number }
  const telemetryEnv = {
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${address.port}/v1/traces`,
    OTEL_EXPORTER_OTLP_HEADERS: 'authorization=local-test-key',
    OTEL_LOGS_EXPORTER: 'none',
    OTEL_METRICS_EXPORTER: 'none',
    OTEL_BSP_SCHEDULE_DELAY: '30',
  }
  const relay = await startTelemetryRelay()
  const database = await openTestDatabase()
  const runtime = createDatabaseRuntime(
    { url: database.url, schema: database.schema },
    telemetryLayer('baton-server', telemetryEnv),
  )
  const directory = await realpath(await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'bpt-')))
  const nodeDirectory = join(directory, 'node')
  const scope = Scope.makeUnsafe()
  const controller = new AbortController()
  let daemon: Promise<unknown> | undefined
  const trace = 'c'.repeat(32)
  try {
    const running = await runtime.runPromise(
      startServer({
        port: 0,
        allowedOrigins: ['https://baton.local'],
        signer: Nodes.CredentialSigner.generate(),
        telemetryEnv,
        dispatchMs: 20,
        projectDispatchMs: 20,
        telemetryAdmission: () => true,
        heartbeatMs: 1000,
        offlineMs: 5000,
      }).pipe(Effect.provideService(Scope.Scope, scope)),
    )
    const base = `http://127.0.0.1:${running.port}`
    await database.run(Auth.createEmployee('tracing', 'Tracing', 'local-initial-password-123'))
    let cookie = '',
      csrf = ''
    const request = async <A>(path: string, method = 'GET', data?: unknown, traced = false) => {
      const response = await fetch(`${base}/api/v1${path}`, {
        method,
        headers: {
          Origin: 'https://baton.local',
          'content-type': 'application/json',
          Cookie: cookie,
          'X-CSRF-Token': csrf,
          ...(traced ? { traceparent: `00-${trace}-${'d'.repeat(16)}-01` } : {}),
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      })
      const next = response.headers.get('set-cookie')
      if (next) cookie = next.split(';')[0]!
      const body = response.status === 204 ? null : ((await response.json()) as A)
      if (body && typeof body === 'object' && 'csrf_token' in body) csrf = String(body.csrf_token)
      return { status: response.status, body: body as A }
    }
    await request('/login', 'POST', { username: 'tracing', password: 'local-initial-password-123' })
    await request('/me/password', 'POST', {
      current_password: 'local-initial-password-123',
      new_password: 'local-updated-password-456',
    })
    await request('/login', 'POST', { username: 'tracing', password: 'local-updated-password-456' })
    const enrollment = await request<P.EnrollmentResponse>('/node-enrollments', 'POST', {})
    const enrollmentFile = join(directory, 'enrollment')
    await writeFile(enrollmentFile, enrollment.body.enrollment_token, { mode: 0o600 })
    const identity = await registerNode({
      dataDirectory: nodeDirectory,
      coordinatorURL: `https://127.0.0.1:${running.port}`,
      enrollmentFile,
      transport: async (_url, input) =>
        (
          await fetch(`${base}/api/v1/nodes/register`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(input),
          })
        ).json(),
    })
    await writeFile(join(nodeDirectory, 'project-runtime.json'), JSON.stringify({ maxModelCalls: 1 }), { mode: 0o600 })
    const entry = new URL(import.meta.resolve('@baton/project-agent-runtime/testing/tracing-worker'))
    const loader = createRequire(entry).resolve('tsx')
    daemon = Effect.runPromiseExit(
      Effect.scoped(
        runDaemon({
          dataDirectory: nodeDirectory,
          identity,
          telemetryRelay: relay,
          probe: async () => [],
          heartbeatMs: 1000,
          pollIntervalMs: 20,
          transport: async (_url, options) => {
            const connection = await connectWebSocket(`ws://127.0.0.1:${running.port}/v1/node`, options)
            return {
              ...connection,
              // 追踪集成测试验证传播链路；传输拥塞丢弃由 transport 单测覆盖。
              tryTelemetry: (frame) => {
                const encoded = JSON.stringify(frame)
                if (encoded.includes('baton-project-runtime')) relayDiagnostics.runtimeBatches++
                if (encoded.includes('"name":"baton.project.run"')) relayDiagnostics.runBatches++
                if (encoded.includes('"name":"chat trace-model"')) relayDiagnostics.chatBatches++
                void connection.send(frame).catch(() => {
                  relayDiagnostics.sendFailures++
                })
              },
            }
          },
          project: {
            runtimeCommand: {
              file: process.execPath,
              args: ['--import', loader, fileURLToPath(entry)],
              env: {
                OTEL_BSP_SCHEDULE_DELAY: telemetryEnv.OTEL_BSP_SCHEDULE_DELAY,
                OTEL_LOGS_EXPORTER: telemetryEnv.OTEL_LOGS_EXPORTER,
                OTEL_METRICS_EXPORTER: telemetryEnv.OTEL_METRICS_EXPORTER,
              },
            },
          },
        }),
      ).pipe(
        Effect.provide(
          telemetryLayer('batond', {
            ...process.env,
            ...telemetryEnvironment(relay),
            BATON_TELEMETRY_NODE_ID: identity.node_id,
            OTEL_BSP_SCHEDULE_DELAY: '30',
            OTEL_LOGS_EXPORTER: 'none',
            OTEL_METRICS_EXPORTER: 'none',
          }),
        ),
      ),
      { signal: controller.signal },
    )
    await expect
      .poll(
        async () =>
          (await request<P.NodeStatus>(`/nodes/${identity.node_id}`)).body.runtime_report?.project_runtime?.providers,
        { timeout: 30000 },
      )
      .toEqual(expect.arrayContaining([expect.objectContaining({ provider: 'openai-codex', status: 'available' })]))
    const created = await request<P.Project>('/projects', 'POST', {
      title: 'Trace',
      goal: 'Local test',
      provider: 'openai-codex',
      model: 'trace-model',
    })
    expect(created.status).toBe(201)
    expect(
      (
        await request(
          `/projects/${created.body.id}/messages`,
          'POST',
          { client_message_id: randomUUID(), content: 'Local model test' },
          true,
        )
      ).status,
    ).toBe(202)
    try {
      await expect
        .poll(() => spans.filter((span) => span.traceId === trace).map(({ service, name }) => ({ service, name })), {
          timeout: 30000,
        })
        .toContainEqual({ service: 'baton-project-runtime', name: 'baton.project.run' })
    } catch (error) {
      throw new Error(`Runtime relay diagnostics: ${JSON.stringify(relayDiagnostics)}`, { cause: error })
    }
    const run = spans.find(
      (span) => span.service === 'baton-project-runtime' && span.name === 'baton.project.run' && span.traceId === trace,
    )!
    expect(
      spans.filter(
        (span) =>
          span.service === 'baton-project-runtime' && span.name === 'baton.project.run' && span.traceId === trace,
      ),
    ).toHaveLength(1)
    expect(run.attributes).toContainEqual({ key: 'baton.project.id', value: { stringValue: created.body.id } })
    expect(run.attributes).toContainEqual({ key: 'baton.turn.result', value: { stringValue: 'failed' } })
    expect(run.attributes).toContainEqual({
      key: 'baton.error.code',
      value: { stringValue: 'model_output_truncated_tools' },
    })
    try {
      await expect
        .poll(
          () =>
            spans.some(
              (span) =>
                span.service === 'baton-project-runtime' && span.name === 'chat trace-model' && span.traceId === trace,
            ),
          { timeout: 30000 },
        )
        .toBe(true)
    } catch (error) {
      throw new Error(`Runtime relay diagnostics: ${JSON.stringify(relayDiagnostics)}`, { cause: error })
    }
    const chat = spans.find(
      (span) => span.service === 'baton-project-runtime' && span.name === 'chat trace-model' && span.traceId === trace,
    )!
    expect(chat).toBeDefined()
    expect(chat.attributes).toContainEqual({ key: 'gen_ai.provider.name', value: { stringValue: 'openai-codex' } })
    expect(chat.attributes).toContainEqual({ key: 'gen_ai.request.model', value: { stringValue: 'trace-model' } })
    expect(chat.attributes).toContainEqual({ key: 'baton.usage.reported', value: { boolValue: false } })
    expect(
      chat.attributes.some(({ key }) => key === 'gen_ai.usage.input_tokens' || key === 'gen_ai.usage.output_tokens'),
    ).toBe(false)
    expect(
      spans.some(
        (span) => span.service === 'baton-server' && span.name === 'baton.http.request' && span.traceId === trace,
      ),
    ).toBe(true)
    expect(authorization.every((value) => value === 'local-test-key')).toBe(true)
    for (const resource of resources.filter((entry) => ['batond', 'baton-project-runtime'].includes(entry.service))) {
      expect(resource.attributes).toContainEqual({ key: 'baton.node.id', value: { stringValue: identity.node_id } })
      expect(resource.attributes).toContainEqual({
        key: 'baton.employee.id',
        value: { stringValue: identity.employee_id },
      })
    }
  } finally {
    controller.abort()
    await daemon
    await runtime.runPromise(Scope.close(scope, Exit.void))
    await runtime.dispose()
    await relay.close()
    await database.close()
    collector.closeAllConnections()
    await new Promise<void>((resolve) => collector.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}, 60000)
