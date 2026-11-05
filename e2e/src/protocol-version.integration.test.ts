import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Exit, Scope } from 'effect'
import { expect, it, vi } from 'vite-plus/test'
import * as P from '@baton/protocol'
import { startServer } from '@baton/server/server'
import { openTestDatabase, seedNodeIdentity } from '@baton/server/testing/database'
import * as Nodes from '@baton/server/nodes'
import { runDaemon } from '@baton/batond/daemon/daemon'
import type { DaemonWorkerHost } from '@baton/batond/daemon/host'
import { connectWebSocket } from '@baton/batond/daemon/transport'

vi.mock('@baton/protocol', async (original) => {
  const actual = await original<typeof P>()
  return {
    ...actual,
    releaseMetadata: () => ({ ...actual.releaseMetadata(), protocol_version: actual.PROTOCOL_VERSION + 1 }),
  }
})

it(
  'rejects an incompatible batond before registering it and leaves the daemon stopped in rejected state',
  { timeout: 30_000 },
  async () => {
    const database = await openTestDatabase()
    const directory = await mkdtemp(join(tmpdir(), 'baton-version-'))
    await chmod(directory, 0o700)
    const signer = Nodes.CredentialSigner.generate()
    const seeded = await seedNodeIdentity(database.run, signer, { displayName: 'Old device' })
    const scope = await Effect.runPromise(Scope.make())
    const controller = new AbortController()
    const host: DaemonWorkerHost = {
      async ensureWorker() {
        throw new Error('Worker must not start for an incompatible protocol')
      },
      async request() {
        throw new Error('Worker must not start for an incompatible protocol')
      },
    }
    let daemon: Promise<unknown> | undefined
    try {
      const server = await database.runtime.runPromise(
        startServer({
          port: 0,
          signer,
          allowedOrigins: [],
          heartbeatMs: 60_000,
          offlineMs: 120_000,
          dispatchMs: 60_000,
          projectDispatchMs: 60_000,
        }).pipe(Effect.provideService(Scope.Scope, scope)),
      )
      daemon = Effect.runPromise(
        Effect.scoped(
          runDaemon({
            dataDirectory: directory,
            identity: {
              ...seeded.identity,
              system: 'linux',
              coordinator_url: 'https://center.test',
            },
            transport: (_url, options) => connectWebSocket(`ws://${server.host}:${server.port}/v1/node`, options),
            host,
            heartbeatMs: 100,
            pollIntervalMs: 20,
            probe: async () => [],
          }),
        ),
        { signal: controller.signal },
      ).catch(() => undefined)
      await vi.waitFor(
        async () => {
          const status = JSON.parse(await readFile(join(directory, 'daemon-status.json'), 'utf8')) as {
            state?: string
            code?: string
            message?: string
          }
          expect(status).toMatchObject({
            state: 'rejected',
            code: 'node_version_incompatible',
          })
          expect(status.message).toContain('协议')
          expect(status.message).toContain('安装包')
        },
        { timeout: 20_000 },
      )
      expect(daemon).toBeDefined()
    } finally {
      controller.abort()
      await daemon
      await database.run(Nodes.resetConnections())
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await database.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
)
