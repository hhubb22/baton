import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises'
import { connect, createServer, type AddressInfo, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Exit, Schema, Scope } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { expect, test } from 'vite-plus/test'
import { NodeIdentity, type CreateBrowserThreadInput, type RuntimeAgent, type RuntimeReport } from '@baton/protocol'
import { runDaemon } from '@baton/batond/daemon/daemon'
import { nodeSystem } from '@baton/batond/daemon/identity'
import { initializeBrowseRoots } from '@baton/batond/daemon/roots'
import { connectWebSocket } from '@baton/batond/daemon/transport'
import * as Auth from '@baton/server/auth'
import { createDatabaseRuntime } from '@baton/server/database'
import * as Nodes from '@baton/server/nodes'
import { startServer } from '@baton/server/server'
import { openTestDatabase } from '@baton/server/testing/database'

async function postgresProxy(databaseURL: string) {
  const target = new URL(databaseURL)
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(target.hostname))
    throw new Error('The outage test requires a local PostgreSQL database')
  const sockets = new Set<Socket>()
  let online = true
  const server = createServer((client) => {
    if (!online) {
      client.destroy()
      return
    }
    const upstream = connect({ host: target.hostname.replace(/^\[|\]$/g, ''), port: Number(target.port || 5432) })
    for (const socket of [client, upstream]) {
      sockets.add(socket)
      socket.on('error', () => {
        client.destroy()
        upstream.destroy()
      })
      socket.once('close', () => {
        sockets.delete(socket)
        client.destroy()
        upstream.destroy()
      })
    }
    client.pipe(upstream).pipe(client)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  const url = new URL(databaseURL)
  url.hostname = '127.0.0.1'
  url.port = String(address.port)
  const setOnline = (value: boolean) => {
    online = value
    if (!value) for (const socket of sockets) socket.destroy()
  }
  return {
    url: url.toString(),
    setOnline,
    close: async () => {
      setOnline(false)
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    },
  }
}

test('database outage rejects HTTP writes and retries daemon authentication until PostgreSQL recovers', async () => {
  const database = await openTestDatabase()
  const controller = new AbortController()
  let directory: string | undefined
  let proxy: Awaited<ReturnType<typeof postgresProxy>> | undefined
  let runtime: ReturnType<typeof createDatabaseRuntime> | undefined
  let serverScope: Scope.Closeable | undefined
  let daemon: Promise<unknown> | undefined
  let daemonExited = false
  try {
    directory = await realpath(await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'bto-')))
    await chmod(directory, 0o700)
    const dataDirectory = join(directory, 'node')
    await initializeBrowseRoots(dataDirectory, directory)
    const signer = Nodes.CredentialSigner.generate()
    const account = await database.run(Auth.initializeEmployee('outagealice', 'Alice'))
    const password = randomUUID()
    await database.run(Auth.changePassword(account.employee.id, account.password, password))
    const session = await database.run(Auth.login(account.employee.username, password))
    const enrollment = await database.run(Nodes.issueEnrollment(account.employee.id))
    const identity = Schema.decodeUnknownSync(NodeIdentity)(
      await database.run(
        Nodes.registerNode(
          {
            enrollment_token: String(enrollment.enrollment_token),
            display_name: 'Local outage fixture',
            system: nodeSystem(),
            capabilities: [],
          },
          signer,
        ),
      ),
    )
    const threadId = randomUUID()
    // A persisted idle Thread lets the message endpoint run without creating a Worker.
    await database.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO threads
        (id, employee_id, client_thread_id, request_hash, node_id, agent_type, working_directory,
         status, created_by, storage_generation, opened_at)
        VALUES (${threadId}::uuid, ${identity.employee_id}::uuid, ${randomUUID()}, ${Buffer.alloc(32)},
          ${identity.node_id}::uuid, 'cursor', ${directory!}, 'idle', 'employee', ${randomUUID()}, clock_timestamp())`
      }),
    )
    proxy = await postgresProxy(database.url)
    runtime = createDatabaseRuntime({ url: proxy.url, schema: database.schema, maxConnections: 4 })
    serverScope = await Effect.runPromise(Scope.make())
    const origin = 'https://baton.local'
    const center = await runtime.runPromise(
      startServer({
        host: '127.0.0.1',
        port: 0,
        allowedOrigins: [origin],
        signer,
        dispatchMs: 100,
        heartbeatMs: 200,
        offlineMs: 1000,
      }).pipe(Effect.provideService(Scope.Scope, serverScope)),
    )
    const base = `http://127.0.0.1:${center.port}/api/v1`
    const request = async (path: string, input?: unknown) => {
      const response = await fetch(base + path, {
        method: input === undefined ? 'GET' : 'POST',
        headers: {
          Origin: origin,
          'content-type': 'application/json',
          Cookie: `baton_session=${session.token}`,
          'X-CSRF-Token': session.csrf_token,
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        signal: AbortSignal.timeout(5000),
      })
      return {
        status: response.status,
        body: (await response.json()) as {
          code?: string
          online?: boolean
          synced?: boolean
          runtime_report?: RuntimeReport
        },
      }
    }
    const capability: RuntimeAgent = {
      agent_type: 'cursor',
      version: 'offline-before',
      status: 'available',
      models: [{ id: 'default', name: 'Default' }],
      default_model: 'default',
      capabilities: { create: true, queue: true, steer: false, stop: true, resume: true, switch_model: false },
    }
    let capabilityVersion = capability.version
    let authUnavailable = 0
    let authSucceeded = 0
    let identityChanged = false
    let workerRequests = 0
    const incarnations = new Set<string>()
    daemon = Effect.runPromiseExit(
      Effect.scoped(
        runDaemon({
          dataDirectory,
          identity,
          relayURL: `wss://127.0.0.1:${center.port}/v1/node`,
          heartbeatMs: 100,
          pollIntervalMs: 20,
          probeIntervalMs: 100,
          random: () => 0,
          probe: async () => ({ ...capability, version: capabilityVersion }),
          host: {
            ensureWorker: async () => {
              workerRequests++
              throw new Error('No Worker is needed for this test')
            },
            request: async () => {
              workerRequests++
              throw new Error('No Worker is needed for this test')
            },
          },
          transport: async (_url, options) => {
            const connection = await connectWebSocket(`ws://127.0.0.1:${center.port}/v1/node`, options)
            return {
              close: () => connection.close(),
              send: async (frame) => {
                if (frame.kind === 'auth') {
                  identityChanged ||= frame.token !== identity.credential.token
                  incarnations.add(frame.incarnation!)
                }
                await connection.send(frame)
              },
              frames: {
                async *[Symbol.asyncIterator]() {
                  for await (const frame of connection.frames) {
                    if (frame.kind === 'auth_result') {
                      if (frame.ok) authSucceeded++
                      else if (frame.code === 'unavailable') authUnavailable++
                    }
                    yield frame
                  }
                },
              },
            }
          },
        }),
      ),
      { signal: controller.signal },
    ).then(() => {
      daemonExited = true
    })
    const ready = async (version: string) => {
      await expect
        .poll(
          async () => {
            const node = await request(`/nodes/${identity.node_id}`)
            return (
              node.status === 200 &&
              node.body.online &&
              node.body.synced &&
              node.body.runtime_report?.agents?.some(
                (agent) => agent.version === version && agent.status === 'available',
              )
            )
          },
          { timeout: 10_000 },
        )
        .toBe(true)
    }
    await ready('offline-before')
    expect(authSucceeded).toBe(1)
    proxy.setOnline(false)
    const createInput: CreateBrowserThreadInput = {
      client_thread_id: randomUUID(),
      node_id: identity.node_id,
      agent_type: 'cursor',
      working_directory: directory,
      message: { client_message_id: randomUUID(), content: 'outage create' },
    }
    const messageInput = { client_message_id: randomUUID(), content: 'outage message', mode: 'queue' }
    const failures = await Promise.all([
      request('/threads', createInput),
      request(`/threads/${threadId}/messages`, messageInput),
    ])
    expect(failures.map((result) => ({ status: result.status, code: result.body.code }))).toEqual([
      { status: 503, code: 'unavailable' },
      { status: 503, code: 'unavailable' },
    ])
    // The direct connection stays healthy; only the center's proxy is disconnected.
    const counts = await database.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{ nodes: number; threads: number; messages: number; commands: number }>`SELECT
        (SELECT count(*)::integer FROM nodes) AS nodes,
        (SELECT count(*)::integer FROM threads) AS threads,
        (SELECT count(*)::integer FROM thread_messages) AS messages,
        (SELECT count(*)::integer FROM thread_outbox) AS commands`
      }),
    )
    expect(counts).toEqual([{ nodes: 1, threads: 1, messages: 0, commands: 0 }])
    await expect.poll(() => authUnavailable, { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
    expect(daemonExited).toBe(false)
    capabilityVersion = 'offline-recovered'
    proxy.setOnline(true)
    await ready('offline-recovered')
    expect(authSucceeded).toBeGreaterThanOrEqual(2)
    expect(daemonExited).toBe(false)
    expect(identityChanged).toBe(false)
    expect(incarnations.size).toBe(1)
    expect(workerRequests).toBe(0)
  } finally {
    proxy?.setOnline(true)
    controller.abort()
    try {
      await daemon
      if (serverScope && runtime) await runtime.runPromise(Scope.close(serverScope, Exit.void))
    } finally {
      try {
        await runtime?.dispose()
      } finally {
        try {
          await proxy?.close()
        } finally {
          try {
            await database.close()
          } finally {
            if (directory) await rm(directory, { recursive: true, force: true })
          }
        }
      }
    }
  }
}, 30_000)
