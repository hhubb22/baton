import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'
import { RuntimeReport } from '@baton/protocol'
import { Effect, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as Auth from './auth.ts'
import * as Nodes from './nodes.ts'
import * as Devices from './device-management.ts'
import { AppError, type NodeSource } from './errors.ts'
import { openTestDatabase, type TestDatabase } from './testing/database.ts'

let database: TestDatabase
let alice: Auth.Employee, bob: Auth.Employee
const signer = Nodes.CredentialSigner.generate()
const sources = new Map<string, NodeSource>()
const run: TestDatabase['run'] = (effect) => database.run(effect)
beforeAll(async () => {
  database = await openTestDatabase()
  alice = await run(Auth.createEmployee('device-alice', 'Alice', 'local-test-password-123'))
  bob = await run(Auth.createEmployee('device-bob', 'Bob', 'local-test-password-123'))
}, 30000)
afterAll(async () => {
  await database?.close()
})
async function node() {
  const enrollment = await run(Nodes.issueEnrollment(alice.id))
  const identity = await run(
    Nodes.registerNode(
      {
        enrollment_token: enrollment.enrollment_token as string,
        display_name: 'Local device',
        system: 'linux',
        capabilities: [],
      },
      signer,
    ),
  )
  const source: NodeSource = {
    employee_id: alice.id,
    node_id: identity.node_id,
    credential_id: identity.credential.id,
    incarnation: randomUUID(),
    conn_id: randomUUID(),
  }
  await run(Nodes.claimConnection(source))
  await run(Nodes.syncNode(source, { display_name: 'Local device', system: 'linux', capabilities: [] }))
  const report: RuntimeReport = {
    exec: { enabled: false, shell: '/bin/sh' },
    roots: [{ root_id: 'workspace', path: '/workspace' }],
    repos: [],
  }
  await run(Nodes.saveRuntimeReport(source, report))
  sources.set(source.node_id, source)
  return { identity, source }
}
const gateway = (
  handler: (body: Parameters<Devices.DeviceGateway['request']>[2]) => Promise<Record<string, unknown>>,
): Devices.DeviceGateway => ({
  request: async (nodeId, _employee, body, _timeoutMs, onResponse) => {
    const result = await handler(body)
    onResponse?.(sources.get(nodeId)!)
    return result
  },
})

describe('authenticated device management confirmation', () => {
  it('authorizes model connection metadata operations before sending them to the device', async () => {
    const { identity } = await node()
    const connection = {
      id: randomUUID(),
      name: 'Gateway',
      protocol: 'openai-responses' as const,
      base_url: 'http://localhost:8080/v1',
      models: ['model'],
    }
    let sent = 0
    const transport = gateway(async (body) => {
      sent++
      return { type: 'node.model_connection_result', operation_id: body.operation_id, ok: true, connection }
    })
    await expect(
      run(Devices.configureModelConnection(bob.id, identity.node_id, { action: 'get', connection }, transport)),
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(sent).toBe(0)
    expect(
      await run(Devices.configureModelConnection(alice.id, identity.node_id, { action: 'get', connection }, transport)),
    ).toEqual({ connection })
  })
  it.each(['files', 'roots-read', 'roots-set', 'login', 'exec'] as const)(
    'renews the original credential only after a confirmed %s response',
    async (kind) => {
      const { identity, source } = await node()
      const sqlRun = <A, E>(query: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
        run(Effect.flatMap(SqlClient.SqlClient, query))
      await sqlRun(
        (sql) =>
          sql`UPDATE node_credentials SET last_business_at=clock_timestamp()-interval '1 day',expires_at=clock_timestamp()+interval '1 day' WHERE id=${source.credential_id}`,
      )
      const transport = gateway(async (body) => ({
        type:
          kind === 'files'
            ? 'files.browse_result'
            : kind === 'roots-read'
              ? 'node.browse_roots_get_result'
              : kind === 'roots-set'
                ? 'node.browse_roots_result'
                : kind === 'login'
                  ? 'node.subscription_login_result'
                  : 'node.project_exec_result',
        operation_id: body.operation_id,
        ok: true,
        ...(kind === 'files'
          ? { kind: 'roots', roots: [] }
          : kind === 'roots-read'
            ? { page: { roots: [] } }
            : kind === 'roots-set'
              ? { roots: [{ root_id: 'workspace', path: '/workspace' }], repos: [] }
              : kind === 'login'
                ? {
                    provider: 'openai-codex',
                    verification_uri: 'https://auth.example/device',
                    user_code: 'ABCD',
                    expires_in_seconds: 600,
                  }
                : { exec: { enabled: true, shell: '/bin/sh' } }),
      }))
      if (kind === 'files') await run(Devices.browse(alice.id, identity.node_id, {}, transport))
      else if (kind === 'roots-read') await run(Devices.getBrowseRoots(alice.id, identity.node_id, {}, transport))
      else if (kind === 'roots-set')
        await run(Devices.updateBrowseRoots(alice.id, identity.node_id, 'add', '/workspace', transport))
      else if (kind === 'login')
        await run(Devices.startSubscriptionLogin(alice.id, identity.node_id, 'chatgpt', transport))
      else await run(Devices.setProjectExec(alice.id, identity.node_id, true, transport))
      const [state] = await sqlRun(
        (sql) =>
          sql<{
            renewed: boolean
          }>`SELECT last_business_at>clock_timestamp()-interval '1 minute' AND expires_at>clock_timestamp()+interval '29 days' AS renewed FROM node_credentials WHERE id=${source.credential_id}`,
      )
      expect(state.renewed).toBe(true)
    },
  )

  it('does not renew failed or malformed responses, expired replies, or replies from a replaced connection', async () => {
    const { identity, source } = await node()
    const sqlRun = <A, E>(query: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
      run(Effect.flatMap(SqlClient.SqlClient, query))
    await sqlRun(
      (sql) =>
        sql`UPDATE node_credentials SET created_at=clock_timestamp()-interval '31 days',last_business_at=clock_timestamp()-interval '31 days' WHERE id=${source.credential_id}`,
    )
    const [before] = await sqlRun(
      (sql) =>
        sql<{ value: string }>`SELECT expires_at::text AS value FROM node_credentials WHERE id=${source.credential_id}`,
    )
    for (const result of [
      { ok: false, code: 'denied' },
      { ok: true, exec: { enabled: false, shell: '/bin/sh' } },
    ]) {
      await expect(
        run(
          Devices.setProjectExec(
            alice.id,
            identity.node_id,
            true,
            gateway(async (body) => ({ type: 'node.project_exec_result', operation_id: body.operation_id, ...result })),
          ),
        ),
      ).rejects.toBeInstanceOf(AppError)
    }
    const replaced = gateway(async (body) => {
      const next = { ...source, conn_id: randomUUID() }
      await run(Nodes.claimConnection(next))
      await run(Nodes.syncNode(next, { display_name: 'Local device', system: 'linux', capabilities: [] }))
      return {
        type: 'node.project_exec_result',
        operation_id: body.operation_id,
        ok: true,
        exec: { enabled: true, shell: '/bin/sh' },
      }
    })
    await expect(run(Devices.setProjectExec(alice.id, identity.node_id, true, replaced))).rejects.toMatchObject({
      code: 'node_source_rejected',
    })
    const [after] = await sqlRun(
      (sql) =>
        sql<{ value: string }>`SELECT expires_at::text AS value FROM node_credentials WHERE id=${source.credential_id}`,
    )
    expect(after.value).toBe(before.value)
    const expired = gateway(async (body) => {
      await sqlRun(
        (sql) =>
          sql`UPDATE node_credentials SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${source.credential_id}`,
      )
      return {
        type: 'node.project_exec_result',
        operation_id: body.operation_id,
        ok: true,
        exec: { enabled: true, shell: '/bin/sh' },
      }
    })
    await expect(run(Devices.setProjectExec(alice.id, identity.node_id, true, expired))).rejects.toMatchObject({
      code: 'node_idle_expired',
    })
    const [state] = await sqlRun(
      (sql) =>
        sql<{
          expired: boolean
        }>`SELECT expires_at<=clock_timestamp() AS expired FROM node_credentials WHERE id=${source.credential_id}`,
    )
    expect(state.expired).toBe(true)
  })
  it('rejects employee isolation violations and offline nodes before dispatch', async () => {
    const { identity, source } = await node()
    let requests = 0
    const transport = gateway(async () => {
      requests++
      return {}
    })
    await expect(run(Devices.setProjectExec(bob.id, identity.node_id, true, transport))).rejects.toMatchObject({
      code: 'forbidden',
    })
    await run(Nodes.disconnectNode(source))
    await expect(run(Devices.setProjectExec(alice.id, identity.node_id, true, transport))).rejects.toMatchObject({
      code: 'node_offline',
    })
    expect(requests).toBe(0)
  })
  it('returns the confirmed exec value and rejects mismatched values and operation identities', async () => {
    const { identity } = await node()
    const transport = gateway(async (body) => ({
      type: 'node.project_exec_result',
      operation_id: body.operation_id,
      ok: true,
      exec: { enabled: true, shell: '/bin/device-shell' },
    }))
    const confirmed = await run(Devices.setProjectExec(alice.id, identity.node_id, true, transport))
    expect(confirmed.runtime_report?.exec).toEqual({ enabled: true, shell: '/bin/device-shell' })
    await expect(run(Devices.setProjectExec(alice.id, identity.node_id, false, transport))).rejects.toMatchObject({
      code: 'invalid_node_response',
    })
    const wrong = gateway(async () => ({
      type: 'node.project_exec_result',
      operation_id: randomUUID(),
      ok: true,
      exec: { enabled: true, shell: '/bin/sh' },
    }))
    await expect(run(Devices.setProjectExec(alice.id, identity.node_id, true, wrong))).rejects.toMatchObject({
      code: 'invalid_node_response',
    })
  })
  it('rejects malformed roots and repositories outside confirmed authorization', async () => {
    const { identity } = await node()
    const transport = gateway(async (body) => ({
      type: 'node.browse_roots_result',
      operation_id: body.operation_id,
      ok: true,
      roots: [{ root_id: 'workspace', path: '/workspace' }],
      repos: [{ path: '/workspace/repo', origin: 'git.example/team/repo' }],
    }))
    expect(
      (await run(Devices.updateBrowseRoots(alice.id, identity.node_id, 'add', '/workspace', transport))).runtime_report
        ?.repos,
    ).toHaveLength(1)
    const outside = gateway(async (body) => ({
      type: 'node.browse_roots_result',
      operation_id: body.operation_id,
      ok: true,
      roots: [{ root_id: 'workspace', path: '/workspace' }],
      repos: [{ path: '/private' }],
    }))
    await expect(
      run(Devices.updateBrowseRoots(alice.id, identity.node_id, 'add', '/workspace', outside)),
    ).rejects.toMatchObject({ code: 'invalid_node_response' })
    await expect(
      run(Devices.updateBrowseRoots(alice.id, identity.node_id, 'remove', '/workspace', transport)),
    ).rejects.toMatchObject({ code: 'invalid_node_response' })
  })
  it('bounds escaped roots in the confirmed report after a directory save', async () => {
    const { identity } = await node()
    const path = `/workspace/${'&'.repeat(200)}`
    const roots = Array.from({ length: 100 }, (_, index) => ({ root_id: `root-${index}`, path: `${path}/${index}` }))
    const transport = gateway(async (body) => ({
      type: 'node.browse_roots_result',
      operation_id: body.operation_id,
      ok: true,
      roots,
      repos: [],
    }))
    const confirmed = await run(Devices.updateBrowseRoots(alice.id, identity.node_id, 'add', `${path}/0`, transport))
    expect(Schema.is(RuntimeReport)(confirmed.runtime_report)).toBe(true)
    expect(confirmed.runtime_report?.truncated).toBe(true)
    expect(confirmed.runtime_report?.roots?.length).toBeGreaterThan(0)
    expect(confirmed.runtime_report?.roots?.length).toBeLessThan(roots.length)
  })
  it('reads roots missing from the report and rechecks ownership after the reply', async () => {
    const { identity } = await node()
    const page = { roots: [{ root_id: 'other', path: '/other' }], next_cursor: `${'a'.repeat(64)}:1` }
    let requests = 0
    const transport = gateway(async (body) => {
      requests++
      return { type: 'node.browse_roots_get_result', operation_id: body.operation_id, ok: true, page }
    })
    await expect(run(Devices.getBrowseRoots(bob.id, identity.node_id, {}, transport))).rejects.toMatchObject({
      code: 'forbidden',
    })
    expect(requests).toBe(0)
    expect(await run(Devices.getBrowseRoots(alice.id, identity.node_id, {}, transport))).toEqual(page)
    const revoked = gateway(async (body) => {
      await run(Nodes.revokeNode(alice.id, identity.node_id))
      return { type: 'node.browse_roots_get_result', operation_id: body.operation_id, ok: true, page }
    })
    await expect(run(Devices.getBrowseRoots(alice.id, identity.node_id, {}, revoked))).rejects.toMatchObject({
      code: 'forbidden',
    })
  })
  it('rejects inconsistent roots cursors and exposes a list change as a conflict', async () => {
    const { identity } = await node()
    const inconsistent = gateway(async (body) => ({
      type: 'node.browse_roots_get_result',
      operation_id: body.operation_id,
      ok: true,
      page: { roots: [{ root_id: 'other', path: '/other' }], next_cursor: `${'a'.repeat(64)}:1` },
    }))
    await expect(
      run(Devices.getBrowseRoots(alice.id, identity.node_id, { cursor: `${'a'.repeat(64)}:1` }, inconsistent)),
    ).rejects.toMatchObject({ code: 'invalid_node_response' })
    const changed = gateway(async (body) => ({
      type: 'node.browse_roots_get_result',
      operation_id: body.operation_id,
      ok: false,
      code: 'roots_changed',
    }))
    await expect(run(Devices.getBrowseRoots(alice.id, identity.node_id, {}, changed))).rejects.toMatchObject({
      status: 409,
      code: 'roots_changed',
    })
  })
  it('returns only device login codes and preserves rejected-device reasons', async () => {
    const { identity } = await node()
    const transport = gateway(async (body) => ({
      type: 'node.subscription_login_result',
      operation_id: body.operation_id,
      ok: true,
      provider: body.type === 'node.subscription_login' ? body.provider : '',
      verification_uri: 'https://auth.invalid/device',
      user_code: 'LOCAL-CODE',
      expires_in_seconds: 600,
    }))
    expect(await run(Devices.startSubscriptionLogin(alice.id, identity.node_id, 'ChatGPT', transport))).toEqual({
      provider: 'openai-codex',
      verification_uri: 'https://auth.invalid/device',
      user_code: 'LOCAL-CODE',
      expires_in_seconds: 600,
    })
    await expect(
      run(Devices.startSubscriptionLogin(alice.id, identity.node_id, '../other', transport)),
    ).rejects.toMatchObject({ code: 'invalid_provider' })
    expect(
      await run(Devices.startSubscriptionLogin(alice.id, identity.node_id, 'registered-provider', transport)),
    ).toMatchObject({ provider: 'registered-provider' })
    const failed = gateway(async (body) => ({
      type: 'node.subscription_login_result',
      operation_id: body.operation_id,
      ok: false,
      code: 'login_unavailable',
      message: 'Runtime 不可用',
    }))
    await expect(run(Devices.startSubscriptionLogin(alice.id, identity.node_id, 'xai', failed))).rejects.toMatchObject({
      code: 'login_unavailable',
      message: 'Runtime 不可用',
    })
  })
  it('rejects post-confirmation revocation and RPC failure', async () => {
    const { identity } = await node()
    const transport = gateway(async (body) => {
      await run(Nodes.revokeNode(alice.id, identity.node_id))
      return {
        type: 'node.project_exec_result',
        operation_id: body.operation_id,
        ok: true,
        exec: { enabled: true, shell: '/bin/sh' },
      }
    })
    await expect(run(Devices.setProjectExec(alice.id, identity.node_id, true, transport))).rejects.toMatchObject({
      code: 'forbidden',
    })
    const next = await node()
    const unavailable = gateway(async () => {
      throw new AppError(503, 'node_timeout')
    })
    await expect(run(Devices.setProjectExec(alice.id, next.identity.node_id, true, unavailable))).rejects.toMatchObject(
      { code: 'node_timeout' },
    )
  })
  it('preserves POSIX names and file offsets while keeping Windows path checks', async () => {
    const { identity, source } = await node()
    const path = 'literal\\name:12.txt'
    const version = 'b'.repeat(64)
    let requests = 0
    const transport = gateway(async (body) => {
      requests++
      if (body.type !== 'files.browse') throw new Error('unexpected request')
      expect(body).toMatchObject({ path, offset: 3, version })
      return {
        type: 'files.browse_result',
        operation_id: body.operation_id,
        ok: true,
        kind: 'file',
        root_id: 'workspace',
        path,
        content: 'tail',
        offset: 3,
        size: 7,
        version,
        truncated: false,
      }
    })
    const query = { root_id: 'workspace', path, offset: 3, version }
    expect(await run(Devices.browse(alice.id, identity.node_id, query, transport))).toMatchObject({
      content: 'tail',
      offset: 3,
    })
    await run(Nodes.syncNode(source, { display_name: 'Windows device', system: 'windows', capabilities: [] }))
    await expect(run(Devices.browse(alice.id, identity.node_id, query, transport))).rejects.toMatchObject({
      code: 'invalid_path',
    })
    expect(requests).toBe(1)
  })
  it('validates file response identity and refuses unsuccessful previews', async () => {
    const { identity } = await node()
    const transport = gateway(async (body) => ({
      type: 'files.browse_result',
      operation_id: body.operation_id,
      ok: true,
      kind: 'file',
      root_id: 'workspace',
      path: 'log.txt',
      content: 'local text',
      offset: 0,
      version: 'a'.repeat(64),
      size: 10,
      truncated: false,
    }))
    expect(
      await run(Devices.browse(alice.id, identity.node_id, { root_id: 'workspace', path: 'log.txt' }, transport)),
    ).toMatchObject({ node_id: identity.node_id, content: 'local text' })
    const escaped = gateway(async (body) => ({
      type: 'files.browse_result',
      operation_id: body.operation_id,
      ok: false,
      code: 'path_escaped',
    }))
    await expect(
      run(Devices.browse(alice.id, identity.node_id, { root_id: 'workspace', path: 'escape/private' }, escaped)),
    ).rejects.toMatchObject({ code: 'path_escaped' })
    const incomplete = gateway(async (body) => ({
      type: 'files.browse_result',
      operation_id: body.operation_id,
      ok: true,
      kind: 'directory',
      root_id: 'workspace',
      path: '',
    }))
    await expect(
      run(Devices.browse(alice.id, identity.node_id, { root_id: 'workspace' }, incomplete)),
    ).rejects.toMatchObject({ code: 'invalid_node_response' })
    const binary = gateway(async (body) => ({
      type: 'files.browse_result',
      operation_id: body.operation_id,
      ok: false,
      code: 'not_text',
    }))
    await expect(
      run(Devices.browse(alice.id, identity.node_id, { root_id: 'workspace', path: 'image.png' }, binary)),
    ).rejects.toMatchObject({ status: 415, code: 'not_text' })
  })
})
