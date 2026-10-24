import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'
import type { RuntimeReport } from '@baton/protocol'
import * as Auth from './auth.ts'
import * as Nodes from './nodes.ts'
import * as Devices from './device-management.ts'
import { AppError, type NodeSource } from './errors.ts'
import { openTestDatabase, type TestDatabase } from './testing/database.ts'

let database: TestDatabase
let alice: Auth.Employee, bob: Auth.Employee
const signer = Nodes.CredentialSigner.generate()
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
  return { identity, source }
}
const gateway = (
  handler: (body: Parameters<Devices.DeviceGateway['request']>[2]) => Promise<Record<string, unknown>>,
): Devices.DeviceGateway => ({ request: async (_node, _employee, body) => handler(body) })

describe('authenticated device management confirmation', () => {
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
  it('returns only device login codes and preserves rejected-device reasons', async () => {
    const { identity } = await node()
    const transport = gateway(async (body) => ({
      type: 'node.subscription_login_result',
      operation_id: body.operation_id,
      ok: true,
      provider: 'openai-codex',
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
      run(Devices.startSubscriptionLogin(alice.id, identity.node_id, 'other', transport)),
    ).rejects.toMatchObject({ code: 'invalid_provider' })
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
