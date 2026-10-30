import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createServer as createHTTPServer } from 'node:http'
import { once } from 'node:events'
import { request as httpsRequest } from 'node:https'
import { mkdtemp, realpath, readFile, writeFile, mkdir, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { Effect, Scope, Exit, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { expect, test } from 'vite-plus/test'
import * as P from '@baton/protocol'
import * as Auth from '@baton/server/auth'
import * as Nodes from '@baton/server/nodes'
import { startServer } from '@baton/server/server'
import { openTestDatabase } from '@baton/server/testing/database'
import { registerNode } from '@baton/batond/daemon/identity'
import { initializeBrowseRoots } from '@baton/batond/devices/roots'
import { LocalWorkerHost } from '@baton/batond/daemon/host'
import { runDaemon } from '@baton/batond/daemon/daemon'
import { runDaemonCLI } from '@baton/batond/daemon/cli'
import { assertStoredTurnTrace, readTurnTrace } from './testing/turn-trace.ts'

const origin = 'https://baton.local'
function browser(base: string, ca: string) {
  let cookie = '',
    csrf = ''
  return async <A = unknown>(path: string, method = 'GET', data?: unknown): Promise<{ status: number; body: A }> => {
    const content = data === undefined ? undefined : JSON.stringify(data)
    const response = await new Promise<{ status: number; body: unknown; cookie?: string }>((resolve, reject) => {
      const request = httpsRequest(
        `${base}/api/v1${path}`,
        {
          method,
          ca,
          signal: AbortSignal.timeout(12000),
          headers: {
            Origin: origin,
            'content-type': 'application/json',
            Cookie: cookie,
            'X-CSRF-Token': csrf,
            ...(content === undefined ? {} : { 'Content-Length': Buffer.byteLength(content) }),
          },
        },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => {
            chunks.push(chunk)
          })
          response.on('error', reject)
          response.on('end', () => {
            try {
              const body = Buffer.concat(chunks).toString('utf8')
              resolve({
                status: response.statusCode!,
                body: body ? JSON.parse(body) : null,
                ...(response.headers['set-cookie']?.[0]
                  ? { cookie: response.headers['set-cookie'][0].split(';')[0] }
                  : {}),
              })
            } catch (error) {
              reject(error)
            }
          })
        },
      )
      request.on('error', reject)
      request.end(content)
    })
    if (response.cookie) cookie = response.cookie
    const token = Schema.decodeUnknownOption(Schema.Struct({ csrf_token: Schema.String }))(response.body)
    if (token._tag === 'Some') csrf = token.value.csrf_token
    return { status: response.status, body: response.body as A }
  }
}
async function signIn(client: ReturnType<typeof browser>, username: string) {
  const initial = 'local-t3-initial-password-123',
    updated = 'local-t3-updated-password-456'
  expect((await client('/login', 'POST', { username, password: initial })).status).toBe(200)
  expect((await client('/me/password', 'POST', { current_password: initial, new_password: updated })).status).toBe(204)
  expect((await client('/login', 'POST', { username, password: updated })).status).toBe(200)
}
const Payload = Schema.Struct({
  message: Schema.Struct({
    role: Schema.String,
    content: Schema.Array(Schema.Json),
    toolName: Schema.optionalKey(Schema.String),
    isError: Schema.optionalKey(Schema.Boolean),
  }),
})
const ToolCall = Schema.Struct({ type: Schema.Literal('toolCall'), id: Schema.String, name: Schema.String })
const quote = (text: string) =>
  process.platform === 'win32' ? `'${text.replaceAll("'", "''")}'` : `'${text.replaceAll("'", "'\\''")}'`

test('Project HTTP → PostgreSQL → WSS daemon → real Runtime coordinates replay Cursor, shell and memory', async () => {
  const database = await openTestDatabase()
  const directory = await realpath(await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'bt3-')))
  const nodeDirectory = join(directory, 'node'),
    workspace = join(directory, 'workspace'),
    extraRoot = join(directory, 'extra')
  const bundle = join(directory, 'replay-worker.cjs'),
    runtimeDirectory = join(directory, 'runtime-auth')
  const caFile = join(directory, 'server.crt'),
    keyFile = join(directory, 'server.key')
  const host = new LocalWorkerHost(nodeDirectory, { executable: process.execPath, args: [bundle] })
  const scope = Scope.makeUnsafe()
  const controller = new AbortController()
  let daemon: Promise<unknown> | undefined
  let projectId = ''
  try {
    await Promise.all([mkdir(workspace), mkdir(extraRoot), mkdir(runtimeDirectory, { mode: 0o700 })])
    await promisify(execFile)('openssl', [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost',
      '-keyout',
      keyFile,
      '-out',
      caFile,
    ])
    const ca = await readFile(caFile, 'utf8')
    await build({
      entryPoints: [fileURLToPath(new URL('./testing/replay-worker.ts', import.meta.url))],
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
    const server = await database.runtime.runPromise(
      startServer({
        port: 0,
        allowedOrigins: [origin],
        signer: Nodes.CredentialSigner.generate(),
        tls: { cert: ca, key: await readFile(keyFile) },
        dispatchMs: 20,
        projectDispatchMs: 25,
        heartbeatMs: 1000,
        offlineMs: 5000,
      }).pipe(Effect.provideService(Scope.Scope, scope)),
    )
    const base = `https://127.0.0.1:${server.port}`
    await database.run(Auth.createEmployee('t3alice', 'Alice', 'local-t3-initial-password-123'))
    await database.run(Auth.createEmployee('t3bob', 'Bob', 'local-t3-initial-password-123'))
    const alice = browser(base, ca),
      bob = browser(base, ca)
    await signIn(alice, 't3alice')
    await signIn(bob, 't3bob')
    const enrollment = await alice<P.EnrollmentResponse>('/node-enrollments', 'POST', {})
    expect(enrollment.status).toBe(201)
    const enrollmentFile = join(directory, 'enrollment')
    await writeFile(enrollmentFile, enrollment.body.enrollment_token, { mode: 0o600 })
    const identity = await registerNode({
      dataDirectory: nodeDirectory,
      coordinatorURL: base,
      caFile,
      enrollmentFile,
      displayName: 'T3 local workstation',
    })
    await writeFile(join(nodeDirectory, 'browse-roots.json'), '{"roots":[]}', { mode: 0o600 })
    await initializeBrowseRoots(nodeDirectory, workspace)
    await writeFile(join(workspace, 'artifact.log'), 'T3 local artifact preview\n')
    await writeFile(join(extraRoot, 'private.log'), 'outside-authorized-root\n')
    await symlink(join(extraRoot, 'private.log'), join(workspace, 'escape.log'))
    const script = join(workspace, 'shell-task.cjs')
    await writeFile(
      script,
      "require('node:fs').appendFileSync('shell-runs.txt', 'once\\n'); process.stdout.write('t3-shell-output\\n');\n",
    )
    const runtimeEntry = new URL(import.meta.resolve('@baton/project-agent-runtime/testing/project-worker'))
    const loader = createRequire(runtimeEntry).resolve('tsx')
    const capability: P.RuntimeAgent = {
      agent_type: 'cursor',
      version: '1.0.35',
      status: 'available',
      models: [{ id: 'default', name: 'Offline default' }],
      default_model: 'default',
      capabilities: { create: true, queue: true, steer: false, stop: true, resume: true, switch_model: false },
    }
    daemon = Effect.runPromiseExit(
      Effect.scoped(
        runDaemon({
          dataDirectory: nodeDirectory,
          identity,
          caFile,
          host,
          probe: async () => capability,
          heartbeatMs: 1000,
          pollIntervalMs: 20,
          probeIntervalMs: 60000,
          project: {
            runtimeCommand: {
              file: process.execPath,
              args: ['--import', loader, fileURLToPath(runtimeEntry)],
              env: {
                T3_FIXTURE_RUNTIME_DIRECTORY: runtimeDirectory,
                T3_FIXTURE_NODE_ID: identity.node_id,
                T3_FIXTURE_WORKSPACE: workspace,
                T3_FIXTURE_SHELL_COMMAND: `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(script)}`,
              },
            },
            watchdogCommand: { file: process.execPath, args: [bundle, 'watchdog'] },
          },
        }),
      ),
      { signal: controller.signal },
    )
    const device = () =>
      alice<P.NodeStatus>(`/nodes/${identity.node_id}`).then((r) => Schema.decodeUnknownSync(P.NodeStatus)(r.body))
    await expect
      .poll(
        async () => {
          const node = await device()
          return {
            synced: node.synced,
            cursor: node.runtime_report?.agents?.[0]?.status,
            subscription: node.runtime_report?.project_runtime?.providers?.[0]?.status,
          }
        },
        { timeout: 10000 },
      )
      .toEqual({ synced: true, cursor: 'available', subscription: 'login_required' })
    expect((await bob<P.NodesResponse>('/nodes')).body.nodes).toEqual([])
    expect((await bob(`/nodes/${identity.node_id}/project-exec`, 'PUT', { enabled: true })).status).toBe(403)
    expect(
      (await bob(`/nodes/${identity.node_id}/subscriptions/login`, 'POST', { provider: 'openai-codex' })).status,
    ).toBe(403)
    const added = await alice<P.NodeStatus>(`/nodes/${identity.node_id}/roots`, 'POST', { path: extraRoot })
    expect(added.status, JSON.stringify(added.body)).toBe(200)
    expect(added.body.runtime_report?.roots?.some((r) => r.path === extraRoot)).toBe(true)
    expect((await alice(`/nodes/${identity.node_id}/roots`, 'DELETE', { path: extraRoot })).status).toBe(200)
    await expect.poll(async () => (await device()).runtime_report?.roots?.some((r) => r.path === extraRoot)).toBe(false)
    expect((await device()).runtime_report?.roots?.map((r) => r.path)).toContain(workspace)
    const enabled = await alice<P.NodeStatus>(`/nodes/${identity.node_id}/project-exec`, 'PUT', { enabled: true })
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200)
    expect(enabled.body.runtime_report?.exec?.enabled).toBe(true)
    const created = await alice<P.Project>('/projects', 'POST', {
      client_project_id: randomUUID(),
      title: 'T3 local project',
      goal: '验证本地跨进程工具调用',
      provider: 'openai-codex',
      model: 't3-faux',
    })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const project = Schema.decodeUnknownSync(P.Project)(created.body)
    projectId = project.id
    const status = () => alice<P.ProjectStatus>(`/projects/${project.id}/status`).then((r) => r.body)
    const input = { client_message_id: randomUUID(), content: '保存记忆，提出确认事项，并运行 Cursor 和 shell 任务。' }
    expect((await alice(`/projects/${project.id}/messages`, 'POST', input)).status).toBe(202)
    expect((await alice(`/projects/${project.id}/messages`, 'POST', input)).status).toBe(202)
    expect((await alice(`/projects/${project.id}/messages`, 'POST', { ...input, content: 'conflict' })).status).toBe(
      409,
    )
    await expect.poll(async () => (await status()).waiting_reason).toBe('login_required')
    expect((await bob(`/projects/${project.id}`)).status).toBe(404)
    expect(
      (await bob(`/projects/${project.id}/messages`, 'POST', { ...input, client_message_id: randomUUID() })).status,
    ).toBe(404)
    const login = await alice<P.SubscriptionLoginResponse>(`/nodes/${identity.node_id}/subscriptions/login`, 'POST', {
      provider: 'ChatGPT',
    })
    expect(login.status, JSON.stringify(login.body)).toBe(200)
    expect(login.body).toEqual({
      provider: 'openai-codex',
      verification_uri: 'https://login.invalid/local-device',
      user_code: 'T3-LOCAL-CODE',
      expires_in_seconds: 600,
    })
    await expect
      .poll(async () => (await device()).runtime_report?.project_runtime?.providers?.[0]?.status, { timeout: 10000 })
      .toBe('available')
    const events = async () => {
      const page = await alice<P.ProjectEventPage>(`/projects/${project.id}/events?limit=100`)
      expect(page.status, JSON.stringify(page.body)).toBe(200)
      return Schema.decodeUnknownSync(P.ProjectEventPage)(page.body).events ?? []
    }
    // 同一回复里的 nodes.exec 登记前修改记忆会按 PM-15 要求刷新依据，先等它有结果。
    await expect
      .poll(
        async () =>
          (await events()).some(
            (event) => event.kind === 'tool_result' && JSON.stringify(event.payload).includes('t3-node-exec'),
          ),
        { timeout: 15000 },
      )
      .toBe(true)
    const memories = await alice<P.MemoriesResponse>(`/projects/${project.id}/memory`)
    expect(memories.status).toBe(200)
    const memory = memories.body.entries![0]!
    expect(memory).toMatchObject({
      title: 'T3 运行记录',
      revision: 1,
      author: 'agent',
      content: '通过真实 Runtime 保存的项目记忆',
    })
    expect((await bob(`/projects/${project.id}/memory/${memory.id}`)).status).toBe(404)
    const updated = await alice<P.ProjectMemory>(`/projects/${project.id}/memory/${memory.id}`, 'PUT', {
      operation_id: randomUUID(),
      expected_revision: 1,
      title: memory.title,
      content: memory.content + '；用户已核对',
    })
    expect(updated.status, JSON.stringify(updated.body)).toBe(200)
    expect(updated.body).toMatchObject({ revision: 2, author: 'user' })
    const followUp = await alice(`/projects/${project.id}/messages`, 'POST', {
      client_message_id: randomUUID(),
      content: '记忆已核对，请继续',
    })
    expect(followUp.status).toBe(202)
    await expect.poll(async () => (await status()).run?.stop_acked_at, { timeout: 10000 }).toBeTruthy()
    const starts = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ pid: P.PositiveInteger, run_id: P.UUID })))(
      (await readFile(join(runtimeDirectory, 'runtime-starts.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    )
    expect(starts).toHaveLength(1)
    expect(starts[0]!.pid).not.toBe(process.pid)
    expect(starts[0]!.run_id).toBe((await status()).run?.id)
    const saved = await events()
    const messages = saved
      .filter((event) => event.kind !== 'compaction')
      .map((event) => ({ event, message: Schema.decodeUnknownSync(Payload)(event.payload).message }))
    const toolResults = messages.filter((entry) => entry.message.role === 'toolResult')
    expect(toolResults.map((entry) => entry.message.toolName)).toEqual([
      'memory.read',
      'memory.remember',
      'threads.create',
      'nodes.exec',
    ])
    expect(toolResults.every((entry) => entry.message.isError === false)).toBe(true)
    const shellResult = toolResults.find((entry) => entry.message.toolName === 'nodes.exec')!
    const output = Schema.decodeUnknownSync(
      Schema.Array(Schema.Struct({ type: Schema.Literal('text'), text: Schema.String })),
    )(shellResult.message.content)
    const shellValue = Schema.decodeUnknownSync(
      Schema.Struct({
        thread_id: P.UUID,
        command_result: Schema.Struct({ exit_code: Schema.Literal(0), output: Schema.String }),
      }),
    )(JSON.parse(output[0]!.text))
    expect(shellValue.command_result.output).toBe('t3-shell-output\n')
    const calls = messages
      .filter((entry) => entry.message.role === 'assistant')
      .flatMap((entry) =>
        entry.message.content.flatMap((block) => {
          const call = Schema.decodeUnknownOption(ToolCall)(block)
          return call._tag === 'Some' ? [{ ...call.value, seq: entry.event.seq }] : []
        }),
      )
    expect(calls.map((call) => call.name)).toEqual(toolResults.map((entry) => entry.message.toolName))
    for (const result of toolResults)
      expect(calls.find((call) => call.id === result.event.tool_call_id)!.seq).toBeLessThan(result.event.seq)
    expect(JSON.stringify(saved)).toContain('已读取 Cursor 回复')
    expect(JSON.stringify(saved)).toContain('t3-shell-output')
    const threadPage = await alice<P.ThreadPage>(`/threads?project_id=${project.id}`)
    const executionPage = await alice<P.ThreadPage>(`/threads?project_id=${project.id}&kind=execution`)
    expect(threadPage.status).toBe(200)
    expect(executionPage.status).toBe(200)
    expect(threadPage.body.threads).toMatchObject([{ agent_type: 'cursor' }])
    expect(executionPage.body.threads).toMatchObject([{ id: shellValue.thread_id, agent_type: 'shell' }])
    const cursor = threadPage.body.threads![0]!
    const shell = executionPage.body.threads![0]!
    const timeline = await alice<P.ThreadTimeline>(`/threads/${cursor.id}/timeline?limit=100`)
    const reply = timeline.body.events!.find((event) => event.kind === 'reply')!
    const attachments = Schema.decodeUnknownSync(
      Schema.Struct({
        attachments: Schema.Array(
          Schema.Struct({
            kind: Schema.Literal('file'),
            node_id: P.UUID,
            root_id: P.RootID,
            path: Schema.String,
            access_status: Schema.Literal('available'),
          }),
        ),
      }),
    )(reply.payload).attachments
    const artifact = attachments.find((attachment) => attachment.path === 'artifact.log')!
    expect(artifact).toMatchObject({ node_id: identity.node_id, access_status: 'available' })
    const query = new URLSearchParams({ root_id: artifact.root_id, path: artifact.path }).toString()
    const preview = await alice<P.FileView>(`/nodes/${identity.node_id}/files?${query}`)
    expect(preview.status, JSON.stringify(preview.body)).toBe(200)
    expect(preview.body).toMatchObject({ kind: 'file', content: 'T3 local artifact preview\n', truncated: false })
    const escaped = await alice<{ code: string }>(
      `/nodes/${identity.node_id}/files?${new URLSearchParams({ root_id: artifact.root_id, path: 'escape.log' }).toString()}`,
    )
    expect(escaped.status).toBe(403)
    expect(escaped.body.code).toBe('path_escaped')
    expect((await bob(`/nodes/${identity.node_id}/files?${query}`)).status).toBe(403)
    for (const thread of [cursor, shell]) expect((await bob(`/threads/${thread.id}`)).status).toBe(404)
    expect(await readFile(join(workspace, 'shell-runs.txt'), 'utf8')).toBe('once\n')
    expect(
      (await readFile(join(workspace, 'submissions.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).text),
    ).toEqual(['t3 replay task `artifact.log`'])
    const revisions = await alice<P.MemoryRevisionsResponse>(`/projects/${project.id}/memory/${memory.id}/revisions`)
    expect(revisions.body.revisions?.map((r) => [r.revision, r.author])).toEqual([
      [1, 'agent'],
      [2, 'user'],
    ])
    const facts = await database.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{
          source_type: string
          source_key: string
          delivered_seq: string | null
          thread_id: string | null
        }>`SELECT source_type,source_key,delivered_seq,payload->>'thread_id' AS thread_id
          FROM project_agent_input_queue WHERE agent_id=${project.agent.id} ORDER BY id`
      }),
    )
    expect(facts.filter((f) => f.source_type === 'user_message')).toHaveLength(2)
    for (const source of ['thread_reply', 'turn_ended', 'memory_updated'])
      expect(facts.some((f) => f.source_type === source && f.delivered_seq !== null)).toBe(true)
    expect(new Set(facts.map((f) => f.source_key)).size).toBe(facts.length)
    expect(
      facts
        .filter((fact) => fact.thread_id === shell.id)
        .map(({ source_type, source_key }) => ({ source_type, source_key })),
    ).toEqual([{ source_type: 'turn_ended', source_key: `thread:${shell.id}:turn:1` }])
    const steps = await assertStoredTurnTrace({
      database,
      request: alice,
      threadId: shell.id,
      expectedItems: [{ type: 'command_execution', text: 't3-shell-output' }],
      beforeReply: true,
    })
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({
      item_id: 'shell:1',
      type: 'command_execution',
      data: { input: expect.stringContaining(script), output: 't3-shell-output\n', exitCode: 0 },
    })
    controller.abort()
    await daemon
    await expect.poll(async () => (await device()).online, { timeout: 10_000 }).toBe(false)
    expect(await readTurnTrace(alice, shell.id)).toEqual(steps)
    expect((await bob<P.ProjectsResponse>('/projects')).body.projects).toEqual([])
    expect(await readFile(join(runtimeDirectory, 'local-subscription'), 'utf8')).toBe('local-login-complete')
    expect(JSON.stringify((await device()).runtime_report)).not.toContain('local-login-complete')
  } catch (error) {
    if (projectId) {
      const diagnostic = await database
        .run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            return {
              runs: yield* sql`SELECT r.state,r.end_reason,r.stop_acked_at FROM agent_runs r JOIN project_agents a ON a.id=r.agent_id WHERE a.project_id=${projectId}`,
              events:
                yield* sql`SELECT e.seq::float8 AS seq,e.kind,e.tool_call_id,e.payload FROM conversation_events e JOIN conversations c ON c.id=e.conversation_id JOIN project_agents a ON a.id=c.agent_id WHERE a.project_id=${projectId} ORDER BY e.seq`,
              reports: yield* sql`SELECT report FROM node_runtime_reports`,
              threads: yield* sql`SELECT status,status_reason,agent_type FROM threads WHERE project_id=${projectId}`,
            }
          }),
        )
        .catch(() => undefined)
      console.error('T3 local integration state', JSON.stringify(diagnostic))
    }
    throw error
  } finally {
    controller.abort()
    await daemon
    for (const threadId of await readdir(join(nodeDirectory, 'threads')).catch(() => [])) {
      try {
        const worker = await host.request(threadId, { type: 'status', ok: false })
        if (worker.pid) process.kill(worker.pid, 'SIGTERM')
        await expect
          .poll(
            async () =>
              host.request(threadId, { type: 'status', ok: false }).then(
                () => false,
                () => true,
              ),
            { timeout: 5000 },
          )
          .toBe(true)
      } catch {
        /* 启动失败的 Worker 可能已退出。 */
      }
    }
    await database.runtime.runPromise(Scope.close(scope, Exit.void))
    await database.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 45000)

test('completed chat → background memory and HTTP embeddings → recall → retire and resume with refreshed context', async () => {
  const database = await openTestDatabase()
  const directory = await realpath(
    await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'baton-memory-')),
  )
  const nodeDirectory = join(directory, 'node')
  const caFile = join(directory, 'server.crt')
  const keyFile = join(directory, 'server.key')
  const scope = Scope.makeUnsafe()
  const controller = new AbortController()
  let daemon: Promise<unknown> | undefined
  const embeddingInputs: string[] = []
  const embeddings = createHTTPServer(async (request, response) => {
    let body = ''
    for await (const part of request) body += part
    const value = JSON.parse(body) as { input: string; model: string }
    embeddingInputs.push(value.input)
    response.setHeader('content-type', 'application/json')
    response.end(
      JSON.stringify({
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: [1, 0, 0] }],
        model: value.model,
        usage: { prompt_tokens: 3, total_tokens: 3 },
      }),
    )
  })
  try {
    embeddings.listen(0, '127.0.0.1')
    await once(embeddings, 'listening')
    await promisify(execFile)('openssl', [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost',
      '-keyout',
      keyFile,
      '-out',
      caFile,
    ])
    const ca = await readFile(caFile, 'utf8')
    const server = await database.runtime.runPromise(
      startServer({
        port: 0,
        allowedOrigins: [origin],
        signer: Nodes.CredentialSigner.generate(),
        tls: { cert: ca, key: await readFile(keyFile) },
        dispatchMs: 20,
        projectDispatchMs: 25,
        heartbeatMs: 1000,
        offlineMs: 5000,
      }).pipe(Effect.provideService(Scope.Scope, scope)),
    )
    const base = `https://127.0.0.1:${server.port}`
    await database.run(Auth.createEmployee('memoryalice', 'Alice', 'local-t3-initial-password-123'))
    const alice = browser(base, ca)
    await signIn(alice, 'memoryalice')
    const enrollment = await alice<P.EnrollmentResponse>('/node-enrollments', 'POST', {})
    const enrollmentFile = join(directory, 'enrollment')
    await writeFile(enrollmentFile, enrollment.body.enrollment_token, { mode: 0o600 })
    const identity = await registerNode({ dataDirectory: nodeDirectory, coordinatorURL: base, caFile, enrollmentFile })
    await writeFile(join(nodeDirectory, 'browse-roots.json'), '{"roots":[]}', { mode: 0o600 })
    const entry = new URL(import.meta.resolve('@baton/project-agent-runtime/testing/memory-worker'))
    const loader = createRequire(entry).resolve('tsx')
    daemon = Effect.runPromiseExit(
      Effect.scoped(
        runDaemon({
          dataDirectory: nodeDirectory,
          identity,
          caFile,
          host: new LocalWorkerHost(nodeDirectory, {
            executable: process.execPath,
            args: ['--import', loader, fileURLToPath(new URL('./testing/replay-worker.ts', import.meta.url))],
          }),
          probe: async () => [],
          heartbeatMs: 1000,
          pollIntervalMs: 20,
          project: { runtimeCommand: { file: process.execPath, args: ['--import', loader, fileURLToPath(entry)] } },
        }),
      ),
      { signal: controller.signal },
    )
    await expect
      .poll(async () => (await alice<P.NodeStatus>(`/nodes/${identity.node_id}`)).body.synced, { timeout: 10000 })
      .toBe(true)
    await expect
      .poll(
        async () => (await alice<P.NodeStatus>(`/nodes/${identity.node_id}`)).body.runtime_report?.project_runtime,
        {
          timeout: 30000,
        },
      )
      .toMatchObject({
        memory_protocol: 1,
        providers: expect.arrayContaining([expect.objectContaining({ provider: 'openai-codex', status: 'available' })]),
      })
    const created = await alice<P.Project>('/projects', 'POST', {
      title: 'Memory flow',
      goal: '继续验证测试约定',
      provider: 'openai-codex',
      model: 'memory-flow',
      memory_embedding: {
        base_url: `http://127.0.0.1:${(embeddings.address() as { port: number }).port}/v1`,
        model: 'local-embed',
      },
    })
    expect(created.status).toBe(201)
    const project = created.body
    const send = async (content: string) => {
      expect(
        (await alice(`/projects/${project.id}/messages`, 'POST', { client_message_id: randomUUID(), content })).status,
      ).toBe(202)
    }
    const memories = async () => (await alice<P.MemoriesResponse>(`/projects/${project.id}/memory`)).body.entries ?? []
    const events = async () =>
      (await alice<P.ProjectEventPage>(`/projects/${project.id}/events?limit=100`)).body.events ?? []
    await send('请记住：测试使用 pnpm test:unit。')
    // 前台回复保存后再计后台预算，后台还需等待前台回收及自己的源码子进程启动。
    await expect
      .poll(async () => (await events()).some((event) => event.kind === 'assistant'), { timeout: 30000 })
      .toBe(true)
    await expect.poll(async () => (await memories()).length, { timeout: 30000 }).toBe(1)
    const [memory] = await memories()
    expect(memory!.content).toBe('测试使用 pnpm test:unit。')
    await expect
      .poll(
        async () =>
          database.run(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              const [row] = yield* sql<{
                ready: boolean
              }>`SELECT EXISTS(SELECT 1 FROM project_memory_embeddings WHERE project_id=${project.id} AND state='ready') AS ready`
              return row!.ready
            }),
          ),
        { timeout: 30000 },
      )
      .toBe(true)
    await send('后续召回：测试入口是什么？' + 'current request '.repeat(1100))
    await expect
      .poll(async () => JSON.stringify(await events()).includes('后续前台已召回测试入口。'), { timeout: 30000 })
      .toBe(true)
    await expect
      .poll(async () => (await alice<P.ProjectStatus>(`/projects/${project.id}/status`)).body.run?.stop_acked_at, {
        timeout: 30000,
      })
      .toBeTruthy()
    const saved = await events()
    expect(saved.some((event) => event.kind === 'compaction')).toBe(true)
    expect(
      saved.some((event) => event.kind === 'tool_result' && JSON.stringify(event.payload).includes('pnpm test:unit')),
    ).toBe(true)
    expect(embeddingInputs.some((text) => text.includes('测试入口'))).toBe(true)
    const retired = await alice(`/projects/${project.id}/memory/${memory!.id}/changes`, 'POST', {
      operation_id: randomUUID(),
      expected_revision: memory!.revision,
      action: 'retire',
    })
    expect(retired.status).toBe(200)
    await send('检查停用：继续当前目标。')
    await expect
      .poll(async () => JSON.stringify(await events()).includes('停用后已刷新记忆工具结果。'), { timeout: 30000 })
      .toBe(true)
    expect(await memories()).toEqual([])
    const recovered = await events()
    for (const original of saved.filter((event) => event.kind === 'compaction' || event.kind === 'tool_result'))
      expect(recovered.find((event) => event.seq === original.seq)).toEqual(original)
  } finally {
    controller.abort()
    await daemon
    embeddings.closeAllConnections()
    await new Promise<void>((resolve, reject) => embeddings.close((error) => (error ? reject(error) : resolve())))
    await database.runtime.runPromise(Scope.close(scope, Exit.void))
    await database.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 120000)

test('deployment outside the data directory registers without coordinator or CA arguments and connects using saved CA', async () => {
  const database = await openTestDatabase()
  const directory = await realpath(await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'bds-')))
  const installationDirectory = join(directory, 'installation')
  const dataDirectory = join(directory, 'node')
  const scope = Scope.makeUnsafe()
  const controller = new AbortController()
  let daemon: Promise<unknown> | undefined
  try {
    await mkdir(installationDirectory)
    const keyFile = join(directory, 'server.key')
    const caFile = join(directory, 'server.crt')
    await promisify(execFile)('openssl', [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost',
      '-keyout',
      keyFile,
      '-out',
      caFile,
    ])
    const ca = await readFile(caFile, 'utf8')
    const server = await database.run(
      startServer({
        port: 0,
        allowedOrigins: [origin],
        signer: Nodes.CredentialSigner.generate(),
        tls: { cert: ca, key: await readFile(keyFile) },
        heartbeatMs: 1000,
        offlineMs: 5000,
      }).pipe(Effect.provideService(Scope.Scope, scope)),
    )
    const base = `https://127.0.0.1:${server.port}`
    await writeFile(
      join(installationDirectory, 'deployment.json'),
      JSON.stringify({
        format: 1,
        coordinator_url: base,
        ca_pem: ca,
      }),
    )
    await database.run(Auth.createEmployee('deploymentalice', 'Alice', 'local-t3-initial-password-123'))
    const alice = browser(base, ca)
    await signIn(alice, 'deploymentalice')
    const enrollment = await alice<P.EnrollmentResponse>('/node-enrollments', 'POST', {})
    expect(enrollment.status).toBe(201)
    const enrollmentFile = join(directory, 'enrollment')
    await writeFile(enrollmentFile, enrollment.body.enrollment_token, { mode: 0o600 })
    await runDaemonCLI(
      'register',
      ['--data-dir', dataDirectory, '--enrollment-file', enrollmentFile, '--display-name', 'Deployment workstation'],
      { installationDirectory },
    )
    expect(await readFile(join(dataDirectory, 'coordinator-ca.pem'), 'utf8')).toBe(ca)
    await writeFile(join(installationDirectory, 'deployment.json'), '{invalid deployment must be ignored')
    daemon = Effect.runPromiseExit(Effect.scoped(runDaemon({ dataDirectory, probe: async () => [] })), {
      signal: controller.signal,
    })
    const status = async () =>
      JSON.parse(await readFile(join(dataDirectory, 'daemon-status.json'), 'utf8')) as {
        state: string
      }
    await expect.poll(status, { timeout: 15000 }).toMatchObject({ state: 'online' })
    controller.abort()
    await daemon
    expect(await status()).toMatchObject({ state: 'stopping' })
    expect(await readFile(join(dataDirectory, 'coordinator-ca.pem'), 'utf8')).toBe(ca)
  } finally {
    controller.abort()
    await daemon
    await database.runtime.runPromise(Scope.close(scope, Exit.void))
    await database.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 60000)
