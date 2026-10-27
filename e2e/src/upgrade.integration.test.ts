import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, chmod, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { build } from 'esbuild'
import { Effect, Exit, Scope } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { expect, test, vi } from 'vite-plus/test'
import * as P from '@baton/protocol'
import * as Auth from '@baton/server/auth'
import * as Nodes from '@baton/server/nodes'
import { startServer } from '@baton/server/server'
import { openTestDatabase } from '@baton/server/testing/database'
import { registerNode } from '@baton/batond/daemon/identity'
import { runDaemon } from '@baton/batond/daemon/daemon'
import { connectWebSocket } from '@baton/batond/daemon/transport'
import { LocalWorkerHost } from '@baton/batond/daemon/host'
import { initializeBrowseRoots } from '@baton/batond/devices/roots'
import { runBatondCLI } from '@baton/batond/cli'
import { writeUpgradePackage } from '@baton/batond/testing/upgrade'

vi.mock('node:https', async () => (await import('@baton/batond/testing/upgrade')).upgradeHTTPSFixture())
vi.mock('node:child_process', async () => (await import('@baton/batond/testing/upgrade')).upgradeProcessFixture())

function sqlite(path: string, statement: string, ...parameters: SQLInputValue[]) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return db.prepare(statement).all(...parameters)
  } finally {
    db.close()
  }
}

test('candidate upgrade preserves Project, memory, Thread identity and queued input across apps', async () => {
  const database = await openTestDatabase()
  const directory = await realpath(await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'btu-')))
  await chmod(directory, 0o700)
  const dataDirectory = join(directory, 'node')
  const bundle = join(directory, 'replay-worker.cjs')
  const host = new LocalWorkerHost(dataDirectory, { executable: process.execPath, args: [bundle] })
  const scope = await Effect.runPromise(Scope.make())
  let controller: AbortController | undefined
  let daemon: Promise<unknown> | undefined
  let threadId: string | undefined
  const stopDaemon = async () => {
    controller?.abort()
    await daemon
    controller = undefined
  }
  try {
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
    const origin = 'https://baton.local'
    const server = await database.run(
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
    const base = `http://127.0.0.1:${server.port}`
    let cookie = '',
      csrf = ''
    const browser = async <A = unknown>(path: string, method = 'GET', data?: unknown) => {
      const response = await fetch(`${base}/api/v1${path}`, {
        method,
        headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf, 'content-type': 'application/json' },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      })
      const setCookie = response.headers.get('set-cookie')
      if (setCookie) cookie = setCookie.split(';')[0]!
      const body = response.status === 204 ? null : ((await response.json()) as A)
      if (body && typeof body === 'object' && 'csrf_token' in body) csrf = String(body.csrf_token)
      expect(response.status, JSON.stringify(body)).toBeLessThan(300)
      return body as A
    }
    const password = 'local-upgrade-initial-password-123'
    await database.run(Auth.createEmployee('upgradealice', 'Alice', password))
    await browser('/login', 'POST', { username: 'upgradealice', password })
    await browser('/me/password', 'POST', {
      current_password: password,
      new_password: 'local-upgrade-updated-password-456',
    })
    await browser('/login', 'POST', { username: 'upgradealice', password: 'local-upgrade-updated-password-456' })
    const enrollment = await browser<P.EnrollmentResponse>('/node-enrollments', 'POST', {})
    const enrollmentFile = join(directory, 'enrollment')
    await writeFile(enrollmentFile, enrollment.enrollment_token, { mode: 0o600 })
    const identity = await registerNode({
      dataDirectory,
      coordinatorURL: `https://127.0.0.1:${server.port}`,
      enrollmentFile,
      displayName: 'Upgrade replay',
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
    await initializeBrowseRoots(dataDirectory, directory)
    const runtime = new URL(import.meta.resolve('@baton/project-agent-runtime/testing/memory-worker'))
    const loader = createRequire(runtime).resolve('tsx')
    const startDaemon = () => {
      controller = new AbortController()
      daemon = Effect.runPromiseExit(
        Effect.scoped(
          runDaemon({
            dataDirectory,
            identity,
            host,
            heartbeatMs: 100,
            pollIntervalMs: 20,
            probeIntervalMs: 60000,
            project: { runtimeCommand: { file: process.execPath, args: ['--import', loader, fileURLToPath(runtime)] } },
            probe: async () => ({
              agent_type: 'cursor',
              version: '1.0.35',
              status: 'available',
              models: [{ id: 'default', name: 'Default' }],
              default_model: 'default',
              capabilities: { create: true, queue: true, steer: false, stop: true, resume: true, switch_model: false },
            }),
            transport: (_url, options) => connectWebSocket(`ws://127.0.0.1:${server.port}/v1/node`, options),
          }),
        ),
        { signal: controller.signal },
      )
    }
    const upgrade = async () =>
      JSON.parse(await readFile(join(dataDirectory, 'upgrade.json'), 'utf8')) as {
        phase: string
        operation_id: string
        backup_path: string
      }
    const centerPhase = () =>
      database.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const rows = yield* sql<{
            phase: string
          }>`SELECT phase FROM node_upgrades WHERE node_id=${identity.node_id} ORDER BY id DESC LIMIT 1`
          return rows[0]?.phase
        }),
      )
    const submissions = async () =>
      (await readFile(join(directory, 'submissions.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { id: string; text: string })
    startDaemon()
    await expect
      .poll(
        async () => (await browser<P.NodeStatus>(`/nodes/${identity.node_id}`)).runtime_report?.agents?.[0]?.status,
        { timeout: 10000 },
      )
      .toBe('available')
    const project = await browser<P.Project>('/projects', 'POST', {
      client_project_id: randomUUID(),
      title: '升级保留项目',
      goal: '验证原身份和排队输入',
      provider: 'openai-codex',
      model: 'memory-flow',
    })
    const memoryId = randomUUID()
    const memory = await browser<P.ProjectMemory>(`/projects/${project.id}/memory/${memoryId}`, 'PUT', {
      operation_id: randomUUID(),
      expected_revision: 0,
      title: '升级保留记忆',
      content: '原数据目录中的队列继续执行。',
    })
    const first = randomUUID(),
      queued = randomUUID()
    const thread = await browser<P.Thread>('/threads', 'POST', {
      client_thread_id: randomUUID(),
      node_id: identity.node_id,
      agent_type: 'cursor',
      working_directory: directory,
      message: { client_message_id: first, content: 'hold' },
    })
    threadId = thread.id
    const view = () => browser<P.ThreadView>(`/threads/${thread.id}`)
    await expect.poll(async () => (await view()).current_turn?.worker_turn_seq, { timeout: 10000 }).toBe(1)
    await browser(`/threads/${thread.id}/messages`, 'POST', {
      client_message_id: queued,
      content: 'queued',
      mode: 'queue',
    })
    const ledger = join(dataDirectory, 'threads', thread.id, 'thread.db')
    await expect
      .poll(
        () =>
          sqlite(ledger, "SELECT json_extract(payload,'$.state') AS state FROM thread_messages WHERE id=?", queued)[0]
            ?.state,
      )
      .toBe('queued')
    const before = await view()
    const target = join(directory, 'package')
    await writeUpgradePackage(target)
    await runBatondCLI(['upgrade', 'prepare', '--package', target, '--data-dir', dataDirectory])
    await expect.poll(centerPhase).toBe('draining')
    await writeFile(join(directory, `${thread.id}.release`), '')
    await expect.poll(async () => (await upgrade()).phase, { timeout: 10000 }).toBe('ready')
    await expect.poll(centerPhase).toBe('ready')
    expect((await submissions()).map((entry) => entry.id)).toEqual([first])
    const operationId = (await upgrade()).operation_id
    await stopDaemon()
    await runBatondCLI(['upgrade', 'migrate', '--data-dir', dataDirectory])
    expect((await upgrade()).phase).toBe('syncing')
    startDaemon()
    await expect.poll(async () => (await upgrade()).phase, { timeout: 10000 }).toBe('completed')
    await expect
      .poll(
        async () =>
          (await browser<P.ThreadTimeline>(`/threads/${thread.id}/timeline?limit=100`)).events?.filter(
            (event) => event.kind === 'reply',
          ).length,
        { timeout: 10000 },
      )
      .toBe(2)
    expect(await submissions()).toEqual([
      { id: first, text: 'hold' },
      { id: queued, text: 'queued' },
    ])
    expect(await browser<P.Project>(`/projects/${project.id}`)).toMatchObject({
      id: project.id,
      title: project.title,
      goal: project.goal,
    })
    expect(await browser<P.ProjectMemory>(`/projects/${project.id}/memory/${memoryId}`)).toEqual(memory)
    expect(await view()).toMatchObject({
      id: before.id,
      node_id: before.node_id,
      storage_generation: before.storage_generation,
      native_session_id: before.native_session_id,
    })
    const facts = await database.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return {
          upgrades: yield* sql<{
            operation_id: string
            phase: string
          }>`SELECT operation_id,phase FROM node_upgrades WHERE node_id=${identity.node_id}`,
          messages: yield* sql<{
            client_message_id: string
            status: string
          }>`SELECT client_message_id,status FROM thread_messages WHERE thread_id=${thread.id} ORDER BY created_at,id`,
        }
      }),
    )
    expect(facts.upgrades).toEqual([{ operation_id: operationId, phase: 'completed' }])
    expect(facts.messages).toEqual([first, queued].map((id) => ({ client_message_id: id, status: 'sent' })))
  } finally {
    await stopDaemon()
    if (threadId) {
      try {
        const status = await host.request(threadId, { type: 'status', ok: false })
        if (status.pid) process.kill(status.pid, 'SIGTERM')
        await expect
          .poll(
            async () => {
              try {
                await host.request(threadId!, { type: 'status', ok: false })
                return false
              } catch {
                return true
              }
            },
            { timeout: 10000 },
          )
          .toBe(true)
      } catch {
        /* Worker 可能已在 ready 或失败清理时退出。 */
      }
    }
    await database.run(Scope.close(scope, Exit.void))
    await database.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 40000)
