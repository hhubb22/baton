import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Effect, Exit, Schema, Scope } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { expect, test, vi } from 'vite-plus/test'
import { telemetryLayer } from '@baton/telemetry'
import { createDatabaseRuntime } from '@baton/server/database'
import type { TraceData } from 'effect/observability/OtlpTracer'
import * as P from '@baton/protocol'
import { startServer } from '@baton/server/server'
import { openTestDatabase } from '@baton/server/testing/database'
import * as Auth from '@baton/server/auth'
import * as Nodes from '@baton/server/nodes'
import { registerNode } from '@baton/batond/daemon/identity'
import { runDaemon } from '@baton/batond/daemon/daemon'
import { connectWebSocket } from '@baton/batond/daemon/transport'
import { initializeBrowseRoots } from '@baton/batond/devices/roots'
import { LocalWorkerHost } from '@baton/batond/daemon/host'
import * as Cursor from '@baton/batond/testing/cursor/transcripts'
import * as Pi from '@baton/batond/testing/pi/transcripts'
import * as Codex from '@baton/batond/testing/codex/transcripts'
import * as Kiro from '@baton/batond/testing/kiro/transcripts'
import { assertStoredTurnTrace, readTurnTrace } from './testing/turn-trace.ts'

const LoginResponse = Schema.Struct({ csrf_token: Schema.String })

interface ProviderThreadOptions {
  agentType: 'cursor' | 'pi' | 'codex' | 'kiro'
  model: string
  version: string
  prepareTranscripts?: (directory: string) => Promise<string | void>
  thinking?: P.ThinkingSelection
  trace?: string
}

interface ProviderThreadContext {
  database: Awaited<ReturnType<typeof openTestDatabase>>
  threadId: string
  firstMessageId: string
  threadPath: string
  request: (path: string, method?: string, data?: unknown) => Promise<{ status: number; body: unknown }>
  view: () => Promise<P.ThreadView>
  timeline: () => Promise<ReadonlyArray<P.ThreadEvent>>
  replies: () => Promise<ReadonlyArray<P.ThreadEvent>>
  disconnect: () => Promise<void>
}

const cases: ReadonlyArray<
  ProviderThreadOptions & {
    firstReply: string
    secondReply: string
  }
> = [
  {
    agentType: 'cursor',
    model: 'composer-2.5',
    version: '1.0.35',
    firstReply: 'provider thread resume fixture first turn complete',
    secondReply:
      'provider thread resume fixture first turn complete\nprovider thread resume fixture second turn complete',
  },
  {
    agentType: 'pi',
    model: 'openrouter/deepseek/deepseek-v4-flash',
    version: '1.0.0',
    firstReply: 'provider thread resume fixture first turn complete',
    secondReply: 'provider thread resume fixture second turn complete',
  },
  {
    agentType: 'codex',
    model: 'gpt-6-luna',
    version: '0.156.1',
    firstReply: 'provider thread resume fixture first turn complete',
    secondReply: 'provider thread resume fixture second turn complete',
  },
  {
    agentType: 'kiro',
    model: 'qwen3-coder-next',
    version: '2.32.0',
    firstReply: 'baton-kiro-ok',
    secondReply: 'kiwi-saved-history',
  },
]

async function withProviderThread(
  { agentType, model, version, prepareTranscripts, thinking, trace }: ProviderThreadOptions,
  run: (context: ProviderThreadContext) => Promise<void>,
) {
  const database = await openTestDatabase()
  const directory = await realpath(await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'bpa-')))
  await chmod(directory, 0o700)
  const nodeDirectory = join(directory, 'node')
  const bundle = join(directory, 'provider-worker.mjs')
  const host = new LocalWorkerHost(nodeDirectory, { executable: process.execPath, args: [bundle] })
  const controller = new AbortController()
  const scope = await Effect.runPromise(Scope.make())
  let daemon: Promise<unknown> | undefined
  let threadId: string | undefined
  const tracedRuntime = trace
    ? createDatabaseRuntime({ url: database.url, schema: database.schema }, telemetryLayer('baton-server'))
    : undefined
  try {
    if (agentType === 'cursor') {
      // Cursor host 从 bundle 旁加载已安装的 SDK 及其原生资源。
      await symlink(
        await realpath(fileURLToPath(new URL('../../apps/batond/node_modules', import.meta.url))),
        join(directory, 'node_modules'),
        'junction',
      )
    }
    const entries: ReadonlyArray<readonly [URL, string]> = [
      [new URL('./testing/provider-replay-worker.ts', import.meta.url), bundle],
      [
        new URL(`../../apps/batond/src/testing/${agentType}/replay-host.ts`, import.meta.url),
        join(directory, `${agentType}-host.mjs`),
      ],
    ]
    for (const [source, outfile] of entries) {
      await build({
        entryPoints: [fileURLToPath(source)],
        outfile,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node26',
        external: ['@cursor/sdk', '@cursor/sdk/*', '@napi-rs/keyring'],
        banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
        logLevel: 'silent',
      })
    }
    if (agentType === 'kiro') {
      await build({
        entryPoints: [
          fileURLToPath(
            new URL(
              '../../upstream/t3code/packages/provider-acp-registry/src/testing/acp-replay-agent.ts',
              import.meta.url,
            ),
          ),
        ],
        outfile: join(directory, 'kiro-replay-agent.mjs'),
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node26',
        logLevel: 'silent',
      })
    }
    let firstContent = 'Respond with exactly: provider thread resume fixture first turn complete'
    if (prepareTranscripts) {
      firstContent = (await prepareTranscripts(directory)) ?? firstContent
    } else if (agentType === 'cursor') {
      const transcript = Cursor.withRuntimeInstructions(
        Cursor.sandboxed(
          await Cursor.readTranscript(
            fileURLToPath(
              new URL(
                '../../upstream/t3code/packages/provider-cursor/src/testing/fixtures/provider_thread_resume.ndjson',
                import.meta.url,
              ),
            ),
          ),
        ),
        model,
      )
      // 上游转录跨两个 host，拆分后保留原生会话 ID 和录制消息。
      for (const [name, part] of [
        ['first', Cursor.firstTurnOnly(transcript)],
        ['resumed', Cursor.resumedOnly(transcript)],
      ] as const) {
        const { entries, ...header } = part
        await writeFile(
          join(directory, `cursor-${name}.ndjson`),
          [
            JSON.stringify({
              type: 'transcript_start',
              ...header,
              metadata: {
                ...header.metadata,
                derivedFrom: 'provider-cursor/src/testing/fixtures/provider_thread_resume.ndjson',
              },
            }),
            ...entries.map((entry) => JSON.stringify(entry)),
            '',
          ].join('\n'),
        )
      }
    } else if (agentType === 'pi') {
      const transcript = await Pi.readPiTranscript(Pi.piFixturePath('provider_thread_resume'))
      await Pi.writePiTranscript(join(directory, 'pi-first.ndjson'), Pi.firstTurnOnly(transcript))
      await Pi.writePiTranscript(join(directory, 'pi-resumed.ndjson'), Pi.resumedOnly(transcript))
    } else if (agentType === 'kiro') {
      const transcript = await Kiro.readKiroTranscript(Kiro.kiroFixturePath('restore_recall'))
      await Kiro.writeKiroTranscript(join(directory, 'kiro-first.ndjson'), Kiro.firstTurnOnly(transcript))
      await Kiro.writeKiroTranscript(join(directory, 'kiro-resumed.ndjson'), Kiro.resumedOnly(transcript))
    } else {
      const transcript = await Codex.readCodexTranscript(Codex.codexFixturePath('provider_thread_resume'))
      await Codex.writeCodexTranscript(join(directory, 'codex-first.ndjson'), Codex.firstTurnOnly(transcript))
      await Codex.writeCodexTranscript(join(directory, 'codex-resumed.ndjson'), Codex.resumedOnly(transcript))
    }
    const origin = 'https://baton.local'
    const running = await (tracedRuntime ?? database.runtime).runPromise(
      startServer({
        port: 0,
        allowedOrigins: [origin],
        signer: Nodes.CredentialSigner.generate(),
        dispatchMs: 20,
        heartbeatMs: 1000,
        offlineMs: 5000,
        webDirectory: directory,
      }).pipe(Effect.provideService(Scope.Scope, scope)),
    )
    const base = `http://127.0.0.1:${running.port}`
    let cookie = ''
    let csrf = ''
    const request = async (path: string, method = 'GET', data?: unknown) => {
      const response = await fetch(`${base}/api/v1${path}`, {
        method,
        headers: {
          Origin: origin,
          'content-type': 'application/json',
          Cookie: cookie,
          'X-CSRF-Token': csrf,
          ...(trace && path === '/threads' && method === 'POST'
            ? { traceparent: `00-${trace}-${'b'.repeat(16)}-01` }
            : {}),
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      })
      const nextCookie = response.headers.get('set-cookie')
      if (nextCookie) cookie = nextCookie.split(';')[0] ?? ''
      const body: unknown = response.status === 204 ? null : await response.json()
      if (Schema.is(LoginResponse)(body)) csrf = body.csrf_token
      return { status: response.status, body }
    }
    const initialPassword = 'offline-initial-72-alpha'
    const password = 'offline-updated-48-bravo'
    await database.run(Auth.createEmployee(`replay${agentType}`, 'Replay employee', initialPassword))
    expect(
      (await request('/login', 'POST', { username: `replay${agentType}`, password: initialPassword })).status,
    ).toBe(200)
    expect(
      (await request('/me/password', 'POST', { current_password: initialPassword, new_password: password })).status,
    ).toBe(204)
    expect((await request('/login', 'POST', { username: `replay${agentType}`, password })).status).toBe(200)
    const enrollment = await request('/node-enrollments', 'POST', {})
    expect(enrollment.status).toBe(201)
    const enrollmentFile = join(directory, 'enrollment')
    await writeFile(enrollmentFile, Schema.decodeUnknownSync(P.EnrollmentResponse)(enrollment.body).enrollment_token, {
      mode: 0o600,
    })
    const identity = await registerNode({
      dataDirectory: nodeDirectory,
      coordinatorURL: `https://127.0.0.1:${running.port}`,
      enrollmentFile,
      displayName: `${agentType} replay workstation`,
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
      agent_type: agentType,
      version,
      status: 'available',
      models: [
        {
          id: model,
          name: model,
          ...(thinking
            ? {
                thinking: {
                  id: thinking.id,
                  options: [{ id: thinking.value, label: thinking.value }],
                },
              }
            : {}),
        },
      ],
      default_model: model,
      capabilities: {
        create: true,
        queue: true,
        steer: agentType === 'pi' || agentType === 'codex',
        stop: true,
        resume: true,
        switch_model: false,
      },
    }
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
          transport: (_url, options) => connectWebSocket(`ws://127.0.0.1:${running.port}/v1/node`, options),
        }),
      ).pipe(Effect.provide(telemetryLayer('batond', { ...process.env, BATON_TELEMETRY_NODE_ID: identity.node_id }))),
      { signal: controller.signal },
    )
    await expect
      .poll(
        async () => {
          const result = await request('/nodes')
          const nodes = Schema.decodeUnknownSync(P.NodesResponse)(result.body).nodes
          const node = nodes?.find((candidate) => candidate.id === identity.node_id)
          return (
            node?.synced &&
            node.runtime_report?.agents?.some((agent) => agent.agent_type === agentType && agent.status === 'available')
          )
        },
        { timeout: 10_000 },
      )
      .toBe(true)
    const firstMessageId = randomUUID()
    const created = await request('/threads', 'POST', {
      client_thread_id: randomUUID(),
      node_id: identity.node_id,
      agent_type: agentType,
      working_directory: directory,
      model,
      message: {
        client_message_id: firstMessageId,
        content: firstContent,
        ...(thinking ? { thinking } : {}),
      },
    } satisfies P.CreateBrowserThreadInput)
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    threadId = Schema.decodeUnknownSync(P.Thread)(created.body).id
    const threadPath = `/threads/${threadId}`
    const view = async () => Schema.decodeUnknownSync(P.ThreadView)((await request(threadPath)).body)
    const timeline = async () =>
      Schema.decodeUnknownSync(P.ThreadTimeline)((await request(`${threadPath}/timeline?limit=100`)).body).events ?? []
    const replies = async () => (await timeline()).filter((event) => event.kind === 'reply')
    const disconnect = async () => {
      controller.abort()
      await daemon
      await expect
        .poll(
          async () => {
            const response = await request(`/nodes/${identity.node_id}`)
            expect(response.status).toBe(200)
            return Schema.decodeUnknownSync(P.NodeStatus)(response.body).online
          },
          { timeout: 10_000 },
        )
        .toBe(false)
    }
    await run({ database, threadId, firstMessageId, threadPath, request, view, timeline, replies, disconnect })
  } finally {
    controller.abort()
    await daemon
    if (threadId) {
      const ownedThreadId = threadId
      const status = await host.request(ownedThreadId, { type: 'status', ok: false }).catch(() => undefined)
      if (status?.pid) {
        process.kill(status.pid, 'SIGTERM')
        await expect
          .poll(
            async () =>
              host.request(ownedThreadId, { type: 'status', ok: false }).then(
                () => false,
                () => true,
              ),
            { timeout: 10_000 },
          )
          .toBe(true)
      }
    }
    await (tracedRuntime ?? database.runtime).runPromise(Scope.close(scope, Exit.void))
    await tracedRuntime?.dispose()
    await database.close()
    await rm(directory, { recursive: true, force: true })
  }
}

test('exports one trace from HTTP through Worker and Pi agent-host', async () => {
  const trace = 'a'.repeat(32)
  const spans: Array<TraceData['resourceSpans'][number]['scopeSpans'][number]['spans'][number] & { service: string }> =
    []
  const collector = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += String(chunk)
    })
    request.on('end', () => {
      const data = JSON.parse(body) as TraceData
      for (const resource of data.resourceSpans) {
        const service =
          resource.resource.attributes.find((item) => item.key === 'service.name')?.value.stringValue ?? ''
        for (const scope of resource.scopeSpans) for (const span of scope.spans) spans.push({ ...span, service })
      }
      response.writeHead(200).end('{}')
    })
  })
  await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve))
  const address = collector.address() as { port: number }
  vi.stubEnv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', `http://127.0.0.1:${address.port}/v1/traces`)
  vi.stubEnv('OTEL_LOGS_EXPORTER', 'none')
  vi.stubEnv('OTEL_METRICS_EXPORTER', 'none')
  vi.stubEnv('OTEL_BSP_SCHEDULE_DELAY', '30')
  try {
    await withProviderThread({ ...cases[1]!, trace }, async ({ replies, threadId }) => {
      await expect.poll(async () => (await replies()).length, { timeout: 15000 }).toBe(1)
      await expect
        .poll(
          () =>
            spans.some(
              (span) =>
                span.service === 'baton-agent-host' && span.name === 'baton.agent.turn' && span.traceId === trace,
            ),
          { timeout: 10000 },
        )
        .toBe(true)
      await expect
        .poll(
          () =>
            spans.some(
              (span) => span.service === 'baton-worker' && span.name === 'baton.turn' && span.traceId === trace,
            ),
          { timeout: 10000 },
        )
        .toBe(true)
      const turn = spans.find(
        (span) => span.service === 'baton-worker' && span.name === 'baton.turn' && span.traceId === trace,
      )!
      expect(
        spans.filter((span) => span.service === 'baton-worker' && span.name === 'baton.turn' && span.traceId === trace),
      ).toHaveLength(1)
      const attributes = Object.fromEntries(turn.attributes.map(({ key, value }) => [key, value]))
      expect(attributes['baton.thread.id']).toEqual({ stringValue: threadId })
      expect(attributes['baton.node.id']?.stringValue).toMatch(/^[0-9a-f-]{36}$/)
      expect(attributes['baton.command.id']?.stringValue).toMatch(/^[0-9a-f-]{36}$/)
      expect(Number(attributes['baton.turn.seq']?.intValue)).toBeGreaterThan(0)
      expect(attributes['baton.agent']).toEqual({ stringValue: 'pi' })
      expect(attributes['gen_ai.request.model']).toEqual({ stringValue: cases[1]!.model })
      expect(attributes['baton.turn.result']).toEqual({ stringValue: 'completed' })
      expect(
        Number(
          attributes['baton.turn.first_output_ms']?.intValue ?? attributes['baton.turn.first_output_ms']?.doubleValue,
        ),
      ).toBeGreaterThanOrEqual(0)
      expect(attributes['baton.usage.reported']).toBeDefined()
      if (attributes['baton.usage.reported']?.boolValue === false) {
        expect(attributes['gen_ai.usage.input_tokens']).toBeUndefined()
        expect(attributes['gen_ai.usage.output_tokens']).toBeUndefined()
      }
      await expect
        .poll(
          () =>
            spans.some(
              (span) =>
                span.service === 'baton-server' && span.name === 'baton.report.receive' && span.traceId === trace,
            ),
          { timeout: 10000 },
        )
        .toBe(true)
      expect(
        spans.some((span) => span.service === 'batond' && span.name === 'baton.report' && span.traceId === trace),
      ).toBe(true)
      const http = spans.find(
        (span) => span.service === 'baton-server' && span.name === 'baton.http.request' && span.traceId === trace,
      )!
      expect(http.attributes.find((attribute) => attribute.key === 'baton.employee.id')?.value.stringValue).toMatch(
        /^[0-9a-f-]{36}$/,
      )
    })
  } finally {
    vi.unstubAllEnvs()
    collector.closeAllConnections()
    await new Promise<void>((resolve) => collector.close(() => resolve()))
  }
}, 45000)

test('Codex thinking selection travels from HTTP through the Worker to the native turn', async () => {
  const thinking = { id: 'reasoningEffort' as const, value: 'high' }
  await withProviderThread(
    {
      agentType: 'codex',
      model: 'gpt-6-luna',
      version: '0.156.1',
      thinking,
      prepareTranscripts: async (directory) => {
        const original = await Codex.readCodexTranscript(Codex.codexFixturePath('provider_thread_resume'))
        const first = Codex.firstTurnOnly(original)
        const transcript = {
          ...first,
          metadata: { ...first.metadata, derivedFrom: original.scenario, purpose: 'HTTP thinking selection' },
          entries: first.entries.map((entry) => {
            if (entry.type !== 'expect_outbound' || entry.label !== 'turn/start') return entry
            const frame = Schema.decodeUnknownSync(
              Schema.Struct({ params: Schema.Record(Schema.String, Schema.Unknown) }),
            )(entry.frame)
            return {
              ...entry,
              frame: {
                ...Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(entry.frame),
                params: { ...frame.params, effort: 'high' },
              },
            }
          }),
        }
        await Codex.writeCodexTranscript(join(directory, 'codex-first.ndjson'), transcript)
        await Codex.writeCodexTranscript(join(directory, 'codex-resumed.ndjson'), Codex.resumedOnly(original))
      },
    },
    async ({ view, replies }) => {
      await expect.poll(async () => (await replies()).length, { timeout: 15_000 }).toBe(1)
      expect((await view()).next_thinking).toEqual(thinking)
    },
  )
}, 45_000)

test.each(cases)(
  '$agentType: browser API receives a reply, stops and resumes the native thread',
  async (provider) => {
    await withProviderThread(provider, async ({ threadPath, request, view, replies }) => {
      await expect.poll(async () => (await replies()).length, { timeout: 15_000 }).toBe(1)
      await expect.poll(async () => (await view()).status, { timeout: 10_000 }).toBe('idle')
      const nativeSessionId = (await view()).native_session_id
      expect(nativeSessionId).toBeTruthy()
      expect(JSON.stringify(await replies())).toContain(provider.firstReply)
      expect((await request(`${threadPath}/stop`, 'POST', {})).status).toBe(202)
      await expect.poll(async () => (await view()).stop_confirmed_at, { timeout: 10_000 }).toBeTruthy()
      expect((await view()).status).toBe('stopped')
      expect((await request(`${threadPath}/resume`, 'POST', {})).status).toBe(202)
      await expect
        .poll(
          async () => {
            const current = await view()
            return !current.resume_pending && current.status === 'idle'
          },
          { timeout: 10_000 },
        )
        .toBe(true)
      expect((await view()).native_session_id).toBe(nativeSessionId)
      expect(
        (
          await request(`${threadPath}/messages`, 'POST', {
            client_message_id: randomUUID(),
            content:
              'Using the conversation history available in this resumed thread, first repeat the exact final answer you gave in the previous turn. Then on a new line write exactly: provider thread resume fixture second turn complete',
            mode: 'queue',
          })
        ).status,
      ).toBe(202)
      await expect.poll(async () => (await replies()).length, { timeout: 15_000 }).toBe(2)
      expect((await replies()).at(-1)?.payload).toMatchObject({
        content: expect.stringContaining(provider.secondReply),
      })
      await expect.poll(async () => (await view()).status, { timeout: 10_000 }).toBe('idle')
    })
  },
  45_000,
)

const traceCases = cases.map((provider) => ({
  ...provider,
  expectedItems:
    provider.agentType === 'cursor'
      ? [
          { type: 'reasoning', text: 'Reading package.json' },
          { type: 'dynamic_tool', text: 'package.json' },
          { type: 'dynamic_tool', text: 'tsconfig.json' },
        ]
      : provider.agentType === 'codex'
        ? [{ type: 'command_execution', text: '.codex-probe-write-action.txt' }]
        : provider.agentType === 'pi'
          ? [{ type: 'reasoning', text: 'provider thread resume fixture first turn complete' }]
          : [
              { type: 'command_execution', text: 'count.txt' },
              { type: 'dynamic_tool', text: 'upToDate' },
              // ACP adapter 的批准项最后状态仍为 waiting，host 在 Turn 结束前原样补发。
              { type: 'approval_request', text: 'count.txt', status: 'waiting' },
            ],
  // Cursor adapter 的 providerTurnPayload 未映射录制的 SDK usage；Kiro 转录只有 context/credit 信息。
  tokenUsage:
    provider.agentType === 'codex'
      ? { inputTokens: 21891, outputTokens: 24 }
      : provider.agentType === 'pi'
        ? { inputTokens: 1792, outputTokens: 85 }
        : undefined,
}))

test.each(traceCases)(
  '$agentType: recorded turn items persist in order and trace remains readable with the device offline',
  async (provider) => {
    await withProviderThread(
      {
        ...provider,
        ...(provider.agentType === 'cursor'
          ? {
              prepareTranscripts: async (directory: string) => {
                const original = await Cursor.readTranscript(
                  fileURLToPath(
                    new URL(
                      '../../upstream/t3code/packages/provider-cursor/src/testing/fixtures/tool_call_read_only.ndjson',
                      import.meta.url,
                    ),
                  ),
                )
                const start = original.entries.find(
                  (entry) => entry.type === 'expect_outbound' && entry.label === 'run.start:1',
                )
                if (start?.type !== 'expect_outbound') throw new Error('Cursor recording has no run.start')
                const prompt = Schema.decodeUnknownSync(Schema.Struct({ message: Schema.String }))(start.frame).message
                const { entries, ...header } = Cursor.withRuntimeInstructions(
                  Cursor.sandboxed(original),
                  provider.model,
                )
                await writeFile(
                  join(directory, 'cursor-first.ndjson'),
                  [
                    JSON.stringify({
                      type: 'transcript_start',
                      ...header,
                      metadata: {
                        ...header.metadata,
                        derivedFrom: 'provider-cursor/src/testing/fixtures/tool_call_read_only.ndjson',
                      },
                    }),
                    ...entries.map((entry) => JSON.stringify(entry)),
                    '',
                  ].join('\n'),
                )
                return prompt
              },
            }
          : provider.agentType === 'codex'
            ? {
                prepareTranscripts: async (directory: string) => {
                  const transcript = await Codex.readCodexTranscript(
                    Codex.codexFixturePath('tool_call_workspace_never'),
                  )
                  await Codex.writeCodexTranscript(join(directory, 'codex-first.ndjson'), transcript)
                  const start = transcript.entries.find(
                    (entry) => entry.type === 'expect_outbound' && entry.label === 'turn/start',
                  )
                  if (start?.type !== 'expect_outbound') throw new Error('Codex recording has no turn/start')
                  const { params } = Schema.decodeUnknownSync(
                    Schema.Struct({
                      params: Schema.Struct({ input: Schema.Array(Schema.Struct({ text: Schema.String })) }),
                    }),
                  )(start.frame)
                  return params.input.map((part) => part.text).join('\n')
                },
              }
            : {}),
      },
      async ({ database, threadId, request, view, timeline, disconnect }) => {
        await expect
          .poll(async () => (await timeline()).filter((event) => event.kind === 'turn.ended').length, {
            timeout: 15_000,
          })
          .toBe(1)
        await expect.poll(async () => (await view()).status, { timeout: 10_000 }).toBe('idle')
        const steps = await assertStoredTurnTrace({
          database,
          threadId,
          request,
          expectedItems: provider.expectedItems,
          ...(provider.tokenUsage ? { tokenUsage: provider.tokenUsage } : {}),
        })
        await disconnect()
        expect(await readTurnTrace(request, threadId)).toEqual(steps)
      },
    )
  },
  45_000,
)

test('kiro: provider_error ends the turn with a safe reason and the native thread remains usable', async () => {
  await withProviderThread(
    {
      agentType: 'kiro',
      model: 'baton-nonexistent-model',
      version: '2.32.0',
      prepareTranscripts: async (directory) => {
        const failure = await Kiro.readKiroTranscript(Kiro.kiroFixturePath('provider_error'))
        const success = await Kiro.readKiroTranscript(Kiro.kiroFixturePath('simple'))
        await Kiro.writeKiroTranscript(join(directory, 'kiro-first.ndjson'), Kiro.failedThenCompleted(failure, success))
      },
    },
    async ({ database, threadId, firstMessageId, threadPath, request, view, timeline, replies }) => {
      const safeReason = 'Check Kiro CLI on this device and try again.'
      await expect
        .poll(async () => (await timeline()).filter((event) => event.kind === 'turn.ended'), { timeout: 15_000 })
        .toEqual([
          expect.objectContaining({ payload: expect.objectContaining({ reason: 'failed', content: safeReason }) }),
        ])
      await expect.poll(async () => (await view()).status, { timeout: 10_000 }).toBe('idle')
      const nativeSessionId = (await view()).native_session_id
      expect(nativeSessionId).toBeTruthy()
      const firstMessageStatus = () =>
        database.run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            return yield* sql<{
              status: string
            }>`SELECT status FROM thread_messages WHERE thread_id=${threadId} AND client_message_id=${firstMessageId}`
          }),
        )
      expect(await firstMessageStatus()).toEqual([{ status: 'sent' }])
      expect(JSON.stringify(await timeline())).not.toContain('16fa91f2-65f8-4fbe-b71f-487adff6da05')
      expect(
        (
          await request(`${threadPath}/messages`, 'POST', {
            client_message_id: randomUUID(),
            content: 'Respond with exactly: baton-kiro-ok',
            mode: 'queue',
          } satisfies P.ThreadMessageInput)
        ).status,
      ).toBe(202)
      await expect.poll(async () => JSON.stringify(await replies()), { timeout: 15_000 }).toContain('baton-kiro-ok')
      await expect
        .poll(async () => (await timeline()).filter((event) => event.kind === 'turn.ended'), { timeout: 10_000 })
        .toEqual([
          expect.objectContaining({ payload: expect.objectContaining({ reason: 'failed', content: safeReason }) }),
          expect.objectContaining({ payload: expect.objectContaining({ reason: 'completed' }) }),
        ])
      await expect.poll(async () => (await view()).status, { timeout: 10_000 }).toBe('idle')
      expect((await view()).native_session_id).toBe(nativeSessionId)
      expect(await firstMessageStatus()).toEqual([{ status: 'sent' }])
    },
  )
}, 45_000)
