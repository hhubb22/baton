import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ outcome: 'completed' as 'completed' | 'failed' }))
vi.mock('../src/auth.js', () => ({
  runtimeModels: async () => ({}),
  registeredProvider: () => ({}),
  credentials: () => ({}),
}))
vi.mock('../src/stdio.js', () => ({
  StdioClient: class {
    async call(request: { operation: string }) {
      if (request.operation === 'bootstrap')
        return {
          type: 'project_runtime.result',
          ok: true,
          data: {
            trace: { traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01` },
            project_id: 'project-id',
            project: {
              title: '',
              goal: '',
              memory_embedding: null,
              agent: { provider: 'openai-codex', model: 'test-model' },
              conversation: { id: 'conversation-id' },
            },
            prompt_version: '1',
            input_seq: 0,
            memory_settings: { core_tokens: 0, related_tokens: 0, max_bytes: 0 },
            after_seq: 0,
            last_seq: 0,
          },
        }
      return { type: 'project_runtime.result', ok: true, data: {} }
    }
  },
  frames: async function* () {},
  writeFrame: async () => {},
}))
vi.mock('../src/runtime.js', () => ({
  ProjectRuntime: class {
    constructor(private rpc: { call(request: unknown): Promise<unknown> }) {}
    async start() {
      await this.rpc.call(
        fixture.outcome === 'failed'
          ? { operation: 'report_failure', reason: 'model_request_failed' }
          : { operation: 'finish' },
      )
    }
  },
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it.each(['completed', 'failed'] as const)('exports the Project Run result %s', async (outcome) => {
  fixture.outcome = outcome
  const payloads: string[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += String(chunk)
    })
    request.on('end', () => {
      payloads.push(body)
      response.writeHead(200).end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  vi.stubEnv('BATON_PROJECT_RUNTIME_TRANSPORT', 'stdio')
  vi.stubEnv('BATON_PROJECT_RUN_ID', 'run-id')
  vi.stubEnv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', `http://127.0.0.1:${address.port}/v1/traces`)
  vi.spyOn(process.stdin, 'destroy').mockReturnValue(process.stdin)
  try {
    const { runProjectRuntimeCLI } = await import('../src/command.js')
    await runProjectRuntimeCLI(['run'])
    const payload = payloads.map((body) => JSON.parse(body)).find((value) => value.resourceSpans)
    const span = payload.resourceSpans[0].scopeSpans[0].spans.find(
      (value: { name: string }) => value.name === 'baton.project.run',
    )
    expect(span.traceId).toBe('a'.repeat(32))
    expect(span.attributes).toContainEqual({ key: 'baton.project.id', value: { stringValue: 'project-id' } })
    expect(span.attributes).toContainEqual({ key: 'baton.turn.result', value: { stringValue: outcome } })
    if (outcome === 'failed') {
      expect(span.status.code).toBe(2)
      expect(span.attributes).toContainEqual({
        key: 'baton.error.code',
        value: { stringValue: 'model_request_failed' },
      })
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
