import { randomUUID } from 'node:crypto'
import { rm, stat, unlink } from 'node:fs/promises'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { request } from 'node:https'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test'
import type { NodeIdentity, ReauthNodeInput } from '@baton/protocol'
import { readPrivateFile, writePrivateFileAtomic } from '../platform/private.ts'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { loadIdentity, loadCoordinatorCA, reauthNode, registerNode } from './identity.ts'

vi.mock('../platform/private.ts', async (importOriginal) => {
  const files = await importOriginal<typeof import('../platform/private.ts')>()
  return { ...files, writePrivateFileAtomic: vi.fn(files.writePrivateFileAtomic) }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, unlink: vi.fn(fs.unlink) }
})

vi.mock('node:https', () => ({ request: vi.fn() }))

function respondHTTPS(status: number, body: string) {
  const requests: ReauthNodeInput[] = []
  vi.mocked(request).mockImplementation((...args) => {
    const respond = args.at(-1) as (response: IncomingMessage) => void
    const outgoing = Object.assign(new PassThrough(), { setTimeout: () => outgoing })
    const chunks: Buffer[] = []
    outgoing.on('data', (chunk: Buffer) => chunks.push(chunk))
    outgoing.once('finish', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as ReauthNodeInput)
      const incoming = Object.assign(new PassThrough(), { statusCode: status })
      respond(incoming as unknown as IncomingMessage)
      incoming.end(body)
    })
    return outgoing as unknown as ClientRequest
  })
  return requests
}

const temporary: string[] = []
beforeEach(async () => {
  vi.mocked(request).mockReset()
  const files = await vi.importActual<typeof import('../platform/private.ts')>('../platform/private.ts')
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(writePrivateFileAtomic).mockReset().mockImplementation(files.writePrivateFileAtomic)
  vi.mocked(unlink).mockReset().mockImplementation(fs.unlink)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture(saveIdentity = true) {
  const path = await makePrivateTempDirectory('baton-reauth-')
  temporary.push(path)
  const identity: NodeIdentity = {
    node_id: randomUUID(),
    employee_id: randomUUID(),
    coordinator_url: 'https://coordinator.invalid',
    display_name: 'Offline node',
    system: 'linux',
    role: '',
    capabilities: [],
    registration_seq: 7,
    registered_at: '2026-01-01T00:00:00Z',
    credential: {
      id: randomUUID(),
      token: 'offline-previous-token',
      version: 1,
      expires_at: '2026-01-02T00:00:00Z',
    },
  }
  const issued: NodeIdentity = {
    ...identity,
    credential: {
      id: randomUUID(),
      token: 'offline-replacement-token',
      version: 2,
      expires_at: '2026-02-01T00:00:00Z',
    },
  }
  if (saveIdentity) await writePrivateFileAtomic(join(path, 'identity.json'), JSON.stringify(identity))
  const enrollmentFile = join(path, 'enrollment')
  await writePrivateFileAtomic(enrollmentFile, 'offline-reauth-enrollment')
  const pendingPath = join(path, 'reauth-pending.json')
  const requests: ReauthNodeInput[] = []
  const receipts = new Map<string, { request: ReauthNodeInput; identity: NodeIdentity }>()
  const transport = async (url: string, body: ReauthNodeInput) => {
    expect(url).toBe(`https://coordinator.invalid/api/v1/nodes/${identity.node_id}/reauth`)
    const pending = JSON.parse((await readPrivateFile(pendingPath)).toString('utf8')) as { request: ReauthNodeInput }
    expect(pending.request).toEqual(body)
    requests.push(body)
    const receipt = receipts.get(body.operation_id)
    if (receipt) {
      expect(body).toEqual(receipt.request)
      return receipt.identity
    }
    expect(body).toMatchObject({
      enrollment_token: 'offline-reauth-enrollment',
      previous_token: identity.credential.token,
      operation_id: expect.any(String),
    })
    receipts.set(body.operation_id, { request: body, identity: issued })
    return issued
  }
  return { path, identity, issued, enrollmentFile, pendingPath, requests, receipts, transport }
}

it('reauthenticates the original node using its saved coordinator and atomically replaces only its identity', async () => {
  const f = await fixture()
  const caFile = join(f.path, 'ca.pem')
  await writePrivateFileAtomic(caFile, 'offline-ca')
  await writePrivateFileAtomic(join(f.path, 'browse-roots.json'), 'local-directory-configuration')
  const controller = new AbortController()
  const identity = await reauthNode({
    dataDirectory: f.path,
    enrollmentFile: f.enrollmentFile,
    caFile,
    signal: controller.signal,
    transport: async (url, body, options) => {
      expect(options).toEqual({ ca: 'offline-ca', signal: controller.signal })
      if (process.platform !== 'win32') expect((await stat(f.pendingPath)).mode & 0o777).toBe(0o600)
      return f.transport(url, body)
    },
  })
  expect(identity).toEqual(f.issued)
  expect(await loadIdentity(f.path)).toEqual(f.issued)
  expect(f.receipts.size).toBe(1)
  await expect(readPrivateFile(f.pendingPath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await readPrivateFile(join(f.path, 'browse-roots.json'))).toString()).toBe('local-directory-configuration')
  expect((await readPrivateFile(join(f.path, 'identity.json'))).toString()).not.toContain('offline-reauth-enrollment')
})

it('clears an explicitly expired uncommitted operation so a new enrollment can authenticate the original node', async () => {
  const f = await fixture()
  const options = { dataDirectory: f.path, enrollmentFile: f.enrollmentFile }
  const first = respondHTTPS(503, JSON.stringify({ code: 'unavailable' }))
  await expect(reauthNode(options)).rejects.toThrow('原操作已保留')
  const original = first[0]!
  await writePrivateFileAtomic(f.enrollmentFile, 'new-offline-reauth-enrollment')
  const expired = respondHTTPS(
    401,
    JSON.stringify({
      code: 'enrollment_expired',
      message: 'offline-previous-token must never appear in errors',
    }),
  )
  const error = await reauthNode(options).catch((error: unknown) => error)
  expect(String(error)).toContain('领取新的重新认证凭据')
  expect(String(error)).not.toContain(f.identity.credential.token)
  expect(expired).toEqual([original])
  await expect(readPrivateFile(f.pendingPath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await loadIdentity(f.path)).toEqual(f.identity)

  const retried = respondHTTPS(200, JSON.stringify(f.issued))
  expect(await reauthNode(options)).toEqual(f.issued)
  expect(retried[0]).toMatchObject({
    enrollment_token: 'new-offline-reauth-enrollment',
    previous_token: original.previous_token,
  })
  expect(retried[0]!.operation_id).not.toBe(original.operation_id)
  expect(await loadIdentity(f.path)).toEqual(f.issued)
  await expect(readPrivateFile(f.pendingPath)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each([
  { status: 503, body: JSON.stringify({ code: 'enrollment_expired', status: 401 }) },
  { status: 403, body: JSON.stringify({ code: 'enrollment_expired' }) },
  { status: 401, body: JSON.stringify({ code: 'invalid_enrollment' }) },
  { status: 401, body: JSON.stringify({ code: 401 }) },
  { status: 401, body: JSON.stringify({ code: 'enrollment_expired\noffline-secret' }) },
  { status: 401, body: '{invalid-json' },
])(
  'retains the original operation after HTTP $status with an unconfirmed or invalid failure body',
  async ({ status, body }) => {
    const f = await fixture()
    const requests = respondHTTPS(status, body)
    const options = { dataDirectory: f.path, enrollmentFile: f.enrollmentFile }
    await expect(reauthNode(options)).rejects.toThrow('原操作已保留')
    const pending = await readPrivateFile(f.pendingPath)
    await expect(reauthNode(options)).rejects.toThrow('原操作已保留')
    expect(await readPrivateFile(f.pendingPath)).toEqual(pending)
    expect(requests).toHaveLength(2)
    expect(requests[1]).toEqual(requests[0])
    expect(await loadIdentity(f.path)).toEqual(f.identity)
  },
)

it.each(['response lost', 'exit before identity save', 'exit after identity save'])(
  'retries the original operation after %s without replacing the credential again',
  async (failure) => {
    const f = await fixture()
    const options = { dataDirectory: f.path, enrollmentFile: f.enrollmentFile, transport: f.transport }
    if (failure === 'exit before identity save') {
      const files = await vi.importActual<typeof import('../platform/private.ts')>('../platform/private.ts')
      vi.mocked(writePrivateFileAtomic).mockImplementation(async (path, data) => {
        if (path === join(f.path, 'identity.json')) throw new Error('Interrupted before identity save')
        await files.writePrivateFileAtomic(path, data)
      })
    } else if (failure === 'exit after identity save') {
      const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
      vi.mocked(unlink).mockImplementation(async (path) => {
        if (path === f.pendingPath) throw new Error('Interrupted before pending cleanup')
        await fs.unlink(path)
      })
    } else {
      options.transport = async (url, body) => {
        await f.transport(url, body)
        throw new Error('Response lost')
      }
    }
    await expect(reauthNode(options)).rejects.toThrow()
    const pending = await readPrivateFile(f.pendingPath)
    expect(await loadIdentity(f.path)).toEqual(failure === 'exit after identity save' ? f.issued : f.identity)
    const files = await vi.importActual<typeof import('../platform/private.ts')>('../platform/private.ts')
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(writePrivateFileAtomic).mockImplementation(files.writePrivateFileAtomic)
    vi.mocked(unlink).mockImplementation(fs.unlink)
    await unlink(f.enrollmentFile)
    vi.stubEnv('BATON_ENROLLMENT_TOKEN', 'different-enrollment-must-not-replace-pending')
    expect(await reauthNode({ dataDirectory: f.path, transport: f.transport })).toEqual(f.issued)
    expect(f.requests).toHaveLength(2)
    expect(f.requests[1]).toEqual(f.requests[0])
    expect(JSON.parse(pending.toString('utf8'))).toMatchObject({ request: f.requests[0] })
    expect(f.receipts.size).toBe(1)
    expect(await loadIdentity(f.path)).toEqual(f.issued)
    await expect(readPrivateFile(f.pendingPath)).rejects.toMatchObject({ code: 'ENOENT' })
  },
)

it.each(['missing identity', 'missing coordinator'])(
  'refuses %s without submitting a request or registering a new node',
  async (failure) => {
    const f = await fixture(false)
    if (failure === 'missing coordinator') {
      const { coordinator_url: _, ...identity } = f.identity
      await writePrivateFileAtomic(join(f.path, 'identity.json'), JSON.stringify(identity))
    }
    await expect(
      reauthNode({ dataDirectory: f.path, enrollmentFile: f.enrollmentFile, transport: f.transport }),
    ).rejects.toThrow('identity_recovery_required')
    expect(f.requests).toEqual([])
    await expect(readPrivateFile(f.pendingPath)).rejects.toMatchObject({ code: 'ENOENT' })
  },
)

it('preserves the original identity and pending operation when the response belongs to another node', async () => {
  const f = await fixture()
  await expect(
    reauthNode({
      dataDirectory: f.path,
      enrollmentFile: f.enrollmentFile,
      transport: async () => ({ ...f.issued, node_id: randomUUID() }),
    }),
  ).rejects.toThrow('identity_recovery_required')
  expect(await loadIdentity(f.path)).toEqual(f.identity)
  expect((await readPrivateFile(f.pendingPath)).length).toBeGreaterThan(0)
})

it('preserves a malformed pending record instead of starting a different operation', async () => {
  const f = await fixture()
  await writePrivateFileAtomic(f.pendingPath, '{interrupted-record')
  await expect(
    reauthNode({ dataDirectory: f.path, enrollmentFile: f.enrollmentFile, transport: f.transport }),
  ).rejects.toThrow('identity_recovery_required')
  expect(f.requests).toEqual([])
  expect((await readPrivateFile(f.pendingPath)).toString()).toBe('{interrupted-record')
  expect(await loadIdentity(f.path)).toEqual(f.identity)
})

it('saves the registration CA under the identity lock, reuses it and replaces it only after successful reauthentication', async () => {
  const f = await fixture(false)
  const caPath = join(f.path, 'coordinator-ca.pem')
  const explicit = join(f.path, 'explicit-ca.pem')
  await writePrivateFileAtomic(explicit, 'replacement-ca')
  await registerNode({
    dataDirectory: f.path,
    coordinatorURL: f.identity.coordinator_url!,
    enrollmentFile: f.enrollmentFile,
    caPem: 'deployment-ca',
    transport: async (_url, _body, options) => {
      expect(options.ca).toBe('deployment-ca')
      await expect(readPrivateFile(caPath)).rejects.toMatchObject({ code: 'ENOENT' })
      return f.identity
    },
  })
  expect(await loadCoordinatorCA(f.path)).toBe('deployment-ca')
  if (process.platform !== 'win32') expect((await stat(caPath)).mode & 0o777).toBe(0o600)
  await reauthNode({
    dataDirectory: f.path,
    enrollmentFile: f.enrollmentFile,
    transport: async (url, body, options) => {
      expect(options.ca).toBe('deployment-ca')
      return f.transport(url, body)
    },
  })
  await expect(
    reauthNode({
      dataDirectory: f.path,
      enrollmentFile: f.enrollmentFile,
      caFile: explicit,
      transport: async () => {
        throw new Error('offline failure')
      },
    }),
  ).rejects.toThrow('原操作已保留')
  expect(await loadCoordinatorCA(f.path)).toBe('deployment-ca')
  expect(await loadCoordinatorCA(f.path, explicit)).toBe('replacement-ca')
  await reauthNode({
    dataDirectory: f.path,
    caFile: explicit,
    transport: async (_url, _body, options) => {
      expect(options.ca).toBe('replacement-ca')
      return f.issued
    },
  })
  expect(await loadCoordinatorCA(f.path)).toBe('replacement-ca')
  const saves = vi.mocked(writePrivateFileAtomic).mock.calls.map(([path]) => path)
  expect(saves.lastIndexOf(caPath)).toBeLessThan(saves.lastIndexOf(join(f.path, 'identity.json')))
})

it('prefers an explicit registration CA and removes a stale saved CA when registering with system trust', async () => {
  const f = await fixture(false)
  const explicit = join(f.path, 'explicit.pem')
  await writePrivateFileAtomic(explicit, 'explicit-ca')
  const options = {
    dataDirectory: f.path,
    coordinatorURL: f.identity.coordinator_url!,
    enrollmentFile: f.enrollmentFile,
  }
  await expect(
    registerNode({
      ...options,
      caFile: explicit,
      caPem: 'ignored-ca',
      transport: async (_url, _body, options) => {
        expect(options.ca).toBe('explicit-ca')
        throw new Error('offline failure')
      },
    }),
  ).rejects.toThrow('无法向 Coordinator 注册节点')
  expect(await loadCoordinatorCA(f.path)).toBeUndefined()
  await writePrivateFileAtomic(join(f.path, 'coordinator-ca.pem'), 'stale-ca')
  await registerNode({
    ...options,
    transport: async (_url, _body, options) => {
      expect(options.ca).toBeUndefined()
      return f.identity
    },
  })
  expect(await loadCoordinatorCA(f.path)).toBeUndefined()
  await expect(loadCoordinatorCA(f.path, join(f.path, 'missing.pem'))).rejects.toMatchObject({ code: 'ENOENT' })
})
