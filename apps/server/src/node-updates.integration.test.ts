import { Effect, Exit, Scope } from 'effect'
import { expect, it } from 'vite-plus/test'
import * as SqlClient from 'effect/sql/SqlClient'
import * as Updates from './node-updates.ts'
import * as Nodes from './nodes.ts'
import { startServer } from './server.ts'
import { seedNode, withTestDatabase } from './testing/database.ts'

it('persists one offline request, isolates owners and resumes a failed operation without replacing its identity', () =>
  withTestDatabase(async ({ run, restart }) => {
    const node = await seedNode(run, { online: false, synced: false })
    const other = await seedNode(run, { online: false, synced: false })
    const signer = Nodes.CredentialSigner.generate()
    const token = signer.sign(node.source)
    const foreign = signer.sign(other.source)
    await expect(run(Updates.requestUpdate(node.employeeId, node.nodeId))).rejects.toMatchObject({
      code: 'update_bootstrap_required',
    })
    await run(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`INSERT INTO node_runtime_reports(node_id,employee_id,report,report_version,reported_at)
      VALUES (${node.nodeId}::uuid,${node.employeeId}::uuid,'{"update_protocol":1}'::jsonb,1,clock_timestamp())
      ON CONFLICT (node_id) DO UPDATE SET report=EXCLUDED.report`,
      ),
    )
    await expect(run(Updates.requestUpdate(other.employeeId, node.nodeId))).rejects.toMatchObject({
      code: 'node_not_found',
    })
    const requests = await Promise.all(
      Array.from({ length: 4 }, () => run(Updates.requestUpdate(node.employeeId, node.nodeId))),
    )
    expect(new Set(requests.map((r) => r.operation_id)).size).toBe(1)
    const operation_id = requests[0]!.operation_id
    const resumed = await restart()
    expect(await resumed(Updates.pendingUpdate(token, signer))).toEqual({ operation_id, attempt: 1 })
    await expect(
      resumed(Updates.reportUpdate(foreign, signer, { operation_id, attempt: 1, phase: 'completed' })),
    ).rejects.toMatchObject({ code: 'update_not_found' })
    await resumed(Updates.reportUpdate(token, signer, { operation_id, attempt: 1, phase: 'migrating' }))
    await resumed(Updates.reportUpdate(token, signer, { operation_id, attempt: 1, phase: 'draining' }))
    expect(await resumed(Nodes.getNode(node.employeeId, node.nodeId))).toMatchObject({
      update_request: { operation_id, phase: 'migrating' },
    })
    await resumed(
      Updates.reportUpdate(token, signer, { operation_id, attempt: 1, phase: 'failed', reason: 'migration_failed' }),
    )
    await resumed(Updates.reportUpdate(token, signer, { operation_id, attempt: 1, phase: 'syncing' }))
    expect(await resumed(Updates.pendingUpdate(token, signer))).toEqual({ operation_id: null, attempt: null })
    expect(await resumed(Updates.requestDeviceUpdate(token, signer))).toMatchObject({
      operation_id,
      attempt: 2,
      phase: 'requested',
    })
    await resumed(Updates.reportUpdate(token, signer, { operation_id, attempt: 1, phase: 'completed' }))
    expect(await resumed(Updates.pendingUpdate(token, signer))).toEqual({ operation_id, attempt: 2 })
    await resumed(Updates.reportUpdate(token, signer, { operation_id, attempt: 2, phase: 'completed' }))
    await resumed(Updates.reportUpdate(token, signer, { operation_id, attempt: 2, phase: 'completed' }))
    await expect(
      resumed(Updates.reportUpdate(token, signer, { operation_id, attempt: 2, phase: 'syncing' })),
    ).rejects.toMatchObject({ code: 'update_conflict' })
    expect((await resumed(Updates.requestUpdate(node.employeeId, node.nodeId))).operation_id).not.toBe(operation_id)
  }))

it('serves authenticated update management without a business connection and rejects revoked credentials', () =>
  withTestDatabase(async ({ run }) => {
    const node = await seedNode(run, { online: false, synced: false })
    const signer = Nodes.CredentialSigner.generate()
    const token = signer.sign(node.source)
    const scope = await Effect.runPromise(Scope.make())
    try {
      const server = await run(
        startServer({ port: 0, signer, allowedOrigins: [], dispatchMs: 60_000, projectDispatchMs: 60_000 }).pipe(
          Effect.provideService(Scope.Scope, scope),
        ),
      )
      const base = `http://${server.host}:${server.port}/api/v1/node-update`
      const call = (path: string, method = 'GET', body?: unknown, credential = token) =>
        fetch(`${base}/${path}`, {
          method,
          headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json', connection: 'close' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(5000),
        })
      expect((await call('pending', 'GET', undefined, 'invalid')).status).toBe(401)
      expect(await (await call('pending')).json()).toEqual({ operation_id: null, attempt: null })
      const requestedInBrowser = await run(Updates.requestUpdate(node.employeeId, node.nodeId))
      const response = await call('request', 'POST')
      expect(response.status).toBe(200)
      const request = (await response.json()) as { operation_id: string }
      expect(request.operation_id).toBe(requestedInBrowser.operation_id)
      expect(await (await call('pending')).json()).toEqual({ operation_id: request.operation_id, attempt: 1 })
      const report = await call('report', 'POST', {
        operation_id: request.operation_id,
        attempt: 1,
        phase: 'downloading',
      })
      expect(report.status).toBe(200)
      expect(
        (
          await call('availability', 'POST', {
            status: 'available',
            version: 'v0.1.6',
            checked_at: '2000-01-01T00:00:00.000Z',
          })
        ).status,
      ).toBe(200)
      const device = await run(Nodes.getNode(node.employeeId, node.nodeId))
      expect(device).toMatchObject({
        update_management_last_seen: expect.any(String),
        update_availability: { status: 'available', version: 'v0.1.6' },
      })
      expect((device.update_availability as { checked_at: string }).checked_at).not.toBe('2000-01-01T00:00:00.000Z')
      const rows = await run(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) => sql<{ synced: boolean }>`SELECT synced FROM node_presence WHERE node_id=${node.nodeId}`,
        ),
      )
      expect(rows[0]?.synced ?? false).toBe(false)
      await run(Nodes.revokeNode(node.employeeId, node.nodeId))
      expect((await call('pending')).status).toBe(401)
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  }))
