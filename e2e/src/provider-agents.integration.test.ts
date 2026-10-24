import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Effect, Exit, Schema, Scope } from 'effect'
import { expect, test } from 'vite-plus/test'
import * as P from '@baton/protocol'
import { startServer } from '@baton/server/server'
import { openTestDatabase } from '@baton/server/testing/database'
import * as Auth from '@baton/server/auth'
import * as Nodes from '@baton/server/nodes'
import { registerNode } from '@baton/batond/daemon/identity'
import { runDaemon } from '@baton/batond/daemon/daemon'
import { connectWebSocket } from '@baton/batond/daemon/transport'
import { initializeBrowseRoots } from '@baton/batond/daemon/roots'
import { LocalWorkerHost } from '@baton/batond/daemon/host'
import * as Pi from '@baton/batond/testing/pi/transcripts'
import * as Codex from '@baton/batond/testing/codex/transcripts'

const LoginResponse = Schema.Struct({ csrf_token: Schema.String })

const cases: ReadonlyArray<{ agentType: 'pi' | 'codex'; model: string; version: string }> = [
  { agentType: 'pi', model: 'openrouter/deepseek/deepseek-v4-flash', version: '1.0.0' },
  { agentType: 'codex', model: 'gpt-6-luna', version: '0.156.1' },
]

// The HTTP, registration, daemon and independent Worker path follows remote.integration.test.ts.
test.each(cases)(
  '$agentType: browser API receives a reply, stops and resumes the native thread',
  async ({ agentType, model, version }) => {
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
    try {
      const entries: ReadonlyArray<readonly [URL, string]> = [
        [new URL('./testing/provider-replay-worker.ts', import.meta.url), bundle],
        [new URL('../../apps/batond/src/testing/pi/replay-host.ts', import.meta.url), join(directory, 'pi-host.mjs')],
        [
          new URL('../../apps/batond/src/testing/codex/replay-host.ts', import.meta.url),
          join(directory, 'codex-host.mjs'),
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
      if (agentType === 'pi') {
        const transcript = await Pi.readPiTranscript(Pi.piFixturePath('provider_thread_resume'))
        await Pi.writePiTranscript(join(directory, 'pi-first.ndjson'), Pi.firstTurnOnly(transcript))
        await Pi.writePiTranscript(join(directory, 'pi-resumed.ndjson'), Pi.resumedOnly(transcript))
      } else {
        const transcript = await Codex.readCodexTranscript(Codex.codexFixturePath('provider_thread_resume'))
        await Codex.writeCodexTranscript(join(directory, 'codex-first.ndjson'), Codex.firstTurnOnly(transcript))
        await Codex.writeCodexTranscript(join(directory, 'codex-resumed.ndjson'), Codex.resumedOnly(transcript))
      }
      const origin = 'https://baton.local'
      const running = await database.run(
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
          headers: { Origin: origin, 'content-type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf },
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
      await writeFile(
        enrollmentFile,
        Schema.decodeUnknownSync(P.EnrollmentResponse)(enrollment.body).enrollment_token,
        { mode: 0o600 },
      )
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
        models: [{ id: model, name: model }],
        default_model: model,
        capabilities: { create: true, queue: true, steer: true, stop: true, resume: true, switch_model: false },
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
        ),
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
              node.runtime_report?.agents?.some(
                (agent) => agent.agent_type === agentType && agent.status === 'available',
              )
            )
          },
          { timeout: 10_000 },
        )
        .toBe(true)
      const created = await request('/threads', 'POST', {
        client_thread_id: randomUUID(),
        node_id: identity.node_id,
        agent_type: agentType,
        working_directory: directory,
        model,
        message: {
          client_message_id: randomUUID(),
          content: 'Respond with exactly: provider thread resume fixture first turn complete',
        },
      } satisfies P.CreateBrowserThreadInput)
      expect(created.status, JSON.stringify(created.body)).toBe(201)
      threadId = Schema.decodeUnknownSync(P.Thread)(created.body).id
      const threadPath = `/threads/${threadId}`
      const view = async () => Schema.decodeUnknownSync(P.ThreadView)((await request(threadPath)).body)
      const replies = async () => {
        const timeline = Schema.decodeUnknownSync(P.ThreadTimeline)(
          (await request(`${threadPath}/timeline?limit=100`)).body,
        )
        return timeline.events?.filter((event) => event.kind === 'reply') ?? []
      }
      await expect.poll(async () => (await replies()).length, { timeout: 15_000 }).toBe(1)
      await expect.poll(async () => (await view()).status, { timeout: 10_000 }).toBe('idle')
      const nativeSessionId = (await view()).native_session_id
      expect(nativeSessionId).toBeTruthy()
      expect(JSON.stringify(await replies())).toContain('provider thread resume fixture first turn complete')
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
      expect(JSON.stringify(await replies())).toContain('provider thread resume fixture second turn complete')
      await expect.poll(async () => (await view()).status, { timeout: 10_000 }).toBe('idle')
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
      await database.run(Scope.close(scope, Exit.void))
      await database.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
  45_000,
)
