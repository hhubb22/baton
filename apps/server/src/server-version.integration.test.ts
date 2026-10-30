import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { Effect, Exit, Scope } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { expect, it, vi } from 'vite-plus/test'
import { WebSocket } from 'ws'
import * as P from '@baton/protocol'
import { CredentialSigner } from './nodes.ts'
import { startServer } from './server.ts'
import { checkNodeVersion, webSocketText } from './gateway.ts'
import { seedNode, withTestDatabase } from './testing/database.ts'

vi.mock('@baton/protocol', async (original) => {
  const actual = await original<typeof P>()
  return {
    ...actual,
    releaseMetadata: () => ({ ...actual.releaseMetadata(), version: 'v1.0.0', supported_daemon_versions: ['v1.0.0'] }),
  }
})

it('admits different releases with the same protocol and rejects incompatible business connections without writes', async () =>
  withTestDatabase(async ({ run }) => {
    const node = await seedNode(run, { online: false, synced: false })
    const threadId = randomUUID()
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO threads(id,employee_id,node_id,client_thread_id,request_hash,agent_type,runtime_mode,working_directory,created_by)
        VALUES(${threadId},${node.employeeId},${node.nodeId},${threadId},${Buffer.alloc(32)},'cursor','full-access','/work','employee')`
        yield* sql`INSERT INTO thread_outbox(employee_id,thread_id,node_id,message_id,action,next_attempt_at)
        VALUES(${node.employeeId},${threadId},${node.nodeId},${randomUUID()},'stop',clock_timestamp()+interval '1 hour')`
      }),
    )
    const snapshot = () =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql`SELECT jsonb_build_object(
        'node',(SELECT to_jsonb(n) FROM nodes n WHERE id=${node.nodeId}),
        'credential',(SELECT to_jsonb(c) FROM node_credentials c WHERE id=${node.credentialId}),
        'presence',(SELECT to_jsonb(p) FROM node_presence p WHERE node_id=${node.nodeId}),
        'outbox',(SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM thread_outbox o WHERE node_id=${node.nodeId})
      ) AS value`
        }),
      )
    const signer = CredentialSigner.generate()
    const scope = await Effect.runPromise(Scope.make())
    const token = signer.sign({ node_id: node.nodeId, employee_id: node.employeeId, credential_id: node.credentialId })
    try {
      const server = await run(
        startServer({
          port: 0,
          signer,
          allowedOrigins: [],
          heartbeatMs: 60000,
          offlineMs: 120000,
          dispatchMs: 60000,
          projectDispatchMs: 60000,
        }).pipe(Effect.provideService(Scope.Scope, scope)),
      )
      const connect = async (version: string, protocol: number, credential = token) => {
        const ws = new WebSocket(`ws://${server.host}:${server.port}/v1/node`)
        const frames: P.Frame[] = []
        ws.on('message', (data) => frames.push(JSON.parse(webSocketText(data))))
        const closed = once(ws, 'close')
        await once(ws, 'open')
        ws.send(
          JSON.stringify({
            kind: 'auth',
            token: credential,
            incarnation: randomUUID(),
            daemon_version: version,
            protocol_version: protocol,
          }),
        )
        await expect.poll(() => frames.some((f) => f.kind === 'auth_result')).toBe(true)
        return { ws, frames, closed }
      }
      const before = await snapshot()
      const invalid = await connect('v0.9.0', 1, 'invalid')
      await invalid.closed
      expect(invalid.frames[0].code).not.toBe('node_version_incompatible')
      for (const [version, protocol, reason] of [['development', 2, 'protocol_version_unsupported']] as const) {
        const { frames, closed } = await connect(version, protocol)
        expect((await closed)[0]).toBe(1008)
        expect(frames).toHaveLength(1)
        expect(frames[0]).toMatchObject({
          kind: 'auth_result',
          ok: false,
          code: 'node_version_incompatible',
          version_incompatibility: {
            center_version: 'v1.0.0',
            daemon_version: version,
            center_protocol_version: 1,
            daemon_protocol_version: protocol,
            supported_daemon_versions: ['v1.0.0'],
            reason,
            guidance: expect.any(String),
          },
        })
        expect(await snapshot()).toEqual(before)
      }
      for (const version of ['v0.9.0', 'v1.0.0', 'v1.1.0', 'development']) {
        const { ws, frames, closed } = await connect(version, 1)
        expect(frames[0]).toMatchObject({ ok: true })
        ws.send(
          JSON.stringify({
            kind: 'envelope',
            envelope: {
              version: 1,
              message_id: randomUUID(),
              route: { to: 'control' },
              priority: 'control',
              body: { type: 'node.sync', display_name: 'Versioned device', system: 'linux', capabilities: [] },
            },
          }),
        )
        await expect.poll(() => frames.some((f) => f.kind === 'envelope')).toBe(true)
        expect(frames.find((f) => f.kind === 'envelope')?.envelope).toMatchObject({
          body: { type: 'node.sync_result', ok: true },
        })
        ws.close()
        await closed
        await expect
          .poll(async () => {
            const rows = await run(
              Effect.flatMap(
                SqlClient.SqlClient,
                (sql) => sql<{ online: boolean }>`SELECT online FROM node_presence WHERE node_id=${node.nodeId}`,
              ),
            )
            return rows[0].online
          })
          .toBe(false)
      }
      expect(() =>
        checkNodeVersion(
          { daemon_version: 'v2.0.0', protocol_version: 1 },
          {
            version: 'development',
            protocol_version: 1,
            supported_daemon_versions: ['development'],
          },
        ),
      ).not.toThrow()
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  }))
