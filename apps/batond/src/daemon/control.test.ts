import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { lstat, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect } from 'effect'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import type { NodeIdentity } from '@baton/protocol'
import { BUILD, PROTOCOL_VERSION } from '@baton/protocol/release'
import { runDaemon, type RunDaemonOptions } from './daemon.ts'
import { ControlClient } from './control-client.ts'
import { controlPaths, decodeControlRequest, decodeControlResponse } from './control.ts'
import { requestAuthenticated } from './ipc.ts'
import { processLockIsHeld } from '../platform/lock.ts'
import { writePrivateFileAtomic } from '../platform/private.ts'
import { ensurePrivateDirectory } from '../platform/private.ts'
import { readProcessIdentity } from '../platform/identity.ts'
import { reapProcessTree } from '../platform/process-tree.ts'
import { makePrivateTempDirectory } from '../testing/private.ts'
import { loadIdentity, saveDeviceIdentity } from './identity.ts'
import { DeviceLogin } from './device-login.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action()
})
const identity = (): NodeIdentity => ({
  node_id: randomUUID(),
  employee_id: randomUUID(),
  display_name: 'Local device',
  system: 'linux',
  role: '',
  capabilities: [],
  registration_seq: 1,
  registered_at: new Date().toISOString(),
  coordinator_url: 'https://coordinator.invalid',
  credential: { id: randomUUID(), token: 'private-long-lived-token', version: 1, expires_at: null },
})
async function fixture(options: Partial<RunDaemonOptions> = {}) {
  const directory = await makePrivateTempDirectory('baton-control-')
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const controller = new AbortController()
  let running: Promise<void> | undefined
  let launches = 0
  const start = async () => {
    launches++
    running = Effect.runPromise(
      Effect.scoped(runDaemon({ dataDirectory: directory, boundRuntime: () => Effect.never, ...options })),
      { signal: controller.signal },
    )
    running.catch(() => undefined)
  }
  cleanup.push(async () => {
    controller.abort()
    await running?.catch(() => undefined)
  })
  const client = new ControlClient(directory, { start })
  return { directory, client, launches: () => launches, running: () => running }
}

it('serializes concurrent autostarts, authenticates IPC and keeps a private unbound daemon alive', async () => {
  const { directory, client, launches, running } = await fixture()
  const results = await Promise.all(Array.from({ length: 8 }, () => client.status()))
  expect(launches()).toBe(1)
  expect(results.every((result) => result.state === 'unbound' && result.pid === process.pid)).toBe(true)
  const paths = controlPaths(directory)
  if (process.platform !== 'win32') {
    expect((await lstat(paths.token)).mode & 0o777).toBe(0o600)
    expect((await lstat(paths.endpoint)).mode & 0o777).toBe(0o600)
  }
  await expect(
    requestAuthenticated({
      endpoint: paths.endpoint,
      token: '0'.repeat(64),
      request: { method: 'status' },
      decodeRequest: decodeControlRequest,
      decodeResponse: decodeControlResponse,
    }),
  ).rejects.toMatchObject({ code: 'unauthorized' })
  expect(() => decodeControlRequest({ method: 'status', unexpected: true })).toThrow()
  expect(() =>
    decodeControlRequest({
      method: 'login_start',
      coordinator_url: 'https://coordinator.invalid',
      display_name: 'x'.repeat(81),
    }),
  ).toThrow()
  expect(() => decodeControlRequest({ method: 'resolve_thread_directory', thread_id: 'invalid' })).toThrow()
  expect(await client.shutdown()).toEqual({ ok: true })
  await running()
  expect(await processLockIsHeld(join(directory, 'daemon.lock'))).toBe(false)
})

it('uses short per-user socket fallbacks and stable Windows pipe identities', () => {
  const directory = `/tmp/${'long/'.repeat(60)}device`
  const unix = controlPaths(directory, { platform: 'linux', runtimeDirectory: '/run/user/123', uid: 123 })
  expect(unix.endpoint).toMatch(/^\/run\/user\/123\/baton\/ctl-[a-f0-9]{20}\.sock$/)
  expect(Buffer.byteLength(unix.endpoint)).toBeLessThanOrEqual(103)
  expect(controlPaths(directory, { platform: 'linux', runtimeDirectory: '/x'.repeat(100), uid: 123 }).endpoint).toMatch(
    /^\/tmp\/baton-123\//,
  )
  expect(controlPaths(directory, { platform: 'win32' }).endpoint).toMatch(/^\\\\\.\\pipe\\baton-ctl-[a-f0-9]{24}$/)
})

it('owns the device code privately, saves the approved identity and prevents silent replacement', async () => {
  const saved = identity()
  const sessionId = randomUUID()
  const calls: { url: string; body: unknown }[] = []
  const { directory, client } = await fixture({
    boundRuntime: (_identity, state) => Effect.promise(() => state('online')).pipe(Effect.andThen(Effect.never)),
    deviceLoginTransport: async (url, body) => {
      calls.push({ url, body })
      return url.endsWith('/sessions')
        ? {
            session_id: sessionId,
            device_code: 'private-device-code',
            user_code: 'ABCD-EFGH',
            verification_uri: 'https://coordinator.invalid/device-login',
            verification_uri_complete: 'https://coordinator.invalid/device-login?code=ABCD-EFGH',
            expires_at: new Date(Date.now() + 600000).toISOString(),
            expires_in_seconds: 600,
            interval_seconds: 2,
          }
        : { status: 'approved', identity: saved }
    },
  })
  const pending = await client.request({ method: 'login_start', coordinator_url: 'https://coordinator.invalid' })
  expect(pending).toMatchObject({ ok: true, status: 'pending', session_id: sessionId })
  expect(JSON.stringify([pending, await client.status()])).not.toContain('private-device-code')
  await vi.waitFor(async () => expect((await client.status()).state).toBe('online'), { timeout: 5000 })
  expect(await loadIdentity(directory)).toEqual(saved)
  expect(calls[1]?.body).toEqual({ session_id: sessionId, device_code: 'private-device-code' })
  expect(await client.request({ method: 'login_start', coordinator_url: 'https://coordinator.invalid' })).toMatchObject(
    { status: 'already_bound' },
  )
  expect(await client.request({ method: 'login_start', coordinator_url: 'https://other.invalid' })).toMatchObject({
    ok: false,
    code: 'logout_required',
  })
  await writePrivateFileAtomic(join(directory, 'model-credentials.json'), 'preserved')
  expect(await client.request({ method: 'logout' })).toEqual({ ok: true })
  await expect(loadIdentity(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(directory, 'model-credentials.json'), 'utf8')).toBe('preserved')
  expect((await client.status()).state).toBe('unbound')
})

it.each(['credential_revoked', 'node_version_incompatible'])(
  'retains terminal %s rejection without reconnecting',
  async (code) => {
    let attempts = 0
    const saved = identity()
    const { directory, client } = await fixture({
      identity: saved,
      boundRuntime: () => {
        attempts++
        return Effect.fail(Object.assign(new Error('拒绝连接'), { code }))
      },
    })
    await vi.waitFor(async () => expect((await client.status()).state).toBe('rejected'))
    expect((await client.status()).rejection).toMatchObject({ code })
    expect(attempts).toBe(1)
    expect(await client.request({ method: 'login_start', coordinator_url: saved.coordinator_url! })).toMatchObject({
      ok: false,
      code: 'logout_required',
    })
    expect(JSON.parse(await readFile(join(directory, 'control-state.json'), 'utf8')).rejection.code).toBe(code)
  },
)

it('keeps an identity approved while a replacement login is being cancelled', async () => {
  const saved = identity()
  const transport = vi.fn(async () => ({
    session_id: randomUUID(),
    device_code: 'private-device-code',
    user_code: 'ABCD-EFGH',
    verification_uri: 'https://coordinator.invalid/device-login',
    verification_uri_complete: 'https://coordinator.invalid/device-login?code=ABCD-EFGH',
    expires_at: new Date(Date.now() + 600000).toISOString(),
    expires_in_seconds: 600,
    interval_seconds: 2,
  }))
  const { directory, client } = await fixture({ deviceLoginTransport: transport })
  // oxlint-disable-next-line typescript/unbound-method -- The original is invoked with cancel.call(this) below.
  const cancel = DeviceLogin.prototype.cancel
  let completedApproval = false
  const racedCancel = vi.spyOn(DeviceLogin.prototype, 'cancel').mockImplementation(async function (this: DeviceLogin) {
    if (this.pending && !completedApproval) {
      completedApproval = true
      // An approved poll may already be committing identity when cancellation begins.
      await this.options.onApproved(await saveDeviceIdentity(directory, saved, saved.coordinator_url!))
    }
    await cancel.call(this)
  })
  try {
    expect(await client.request({ method: 'login_start', coordinator_url: saved.coordinator_url! })).toMatchObject({
      status: 'pending',
    })
    expect(await client.request({ method: 'login_start', coordinator_url: 'https://other.invalid' })).toMatchObject({
      ok: false,
      code: 'logout_required',
    })
    expect((await client.status()).node_id).toBe(saved.node_id)
    expect(await loadIdentity(directory)).toEqual(saved)
    expect(transport).toHaveBeenCalledTimes(1)
  } finally {
    racedCancel.mockRestore()
  }
})

it('retains identity when bound-runtime process cleanup fails', async () => {
  const saved = identity()
  const { directory, client } = await fixture({
    identity: saved,
    boundRuntime: () => Effect.never.pipe(Effect.ensuring(Effect.die(new Error('process cleanup failed')))),
  })
  await writePrivateFileAtomic(join(directory, 'identity.json'), JSON.stringify(saved))
  await client.status()
  expect(await client.request({ method: 'logout' })).toMatchObject({
    ok: false,
    message: expect.stringContaining('process cleanup failed'),
  })
  expect(await loadIdentity(directory)).toEqual(saved)
})

it('keeps identity when the retirement barrier cannot be committed', async () => {
  const saved = identity()
  const { directory, client } = await fixture({ identity: saved })
  await writePrivateFileAtomic(join(directory, 'identity.json'), JSON.stringify(saved))
  await client.status()
  await writePrivateFileAtomic(join(directory, 'retired-bindings.json'), '{}')
  expect(await client.request({ method: 'logout' })).toMatchObject({ ok: false })
  expect(await loadIdentity(directory)).toEqual(saved)
})

it('does not restart a retired identity after an interrupted logout', async () => {
  const saved = identity()
  let starts = 0
  const { directory, client } = await fixture({
    identity: saved,
    boundRuntime: () => {
      starts++
      return Effect.never
    },
  })
  await writePrivateFileAtomic(
    join(directory, 'retired-bindings.json'),
    JSON.stringify({ node_ids: [saved.node_id], thread_ids: [], execution_ids: [], project_run_ids: [] }),
  )
  expect(await client.status()).toMatchObject({ state: 'rejected', rejection: { code: 'binding_retired' } })
  expect(starts).toBe(0)
})

it('discards rejection state belonging to a different binding', async () => {
  const saved = identity()
  const { directory, client } = await fixture({ identity: saved })
  await writePrivateFileAtomic(
    join(directory, 'control-state.json'),
    JSON.stringify({
      node_id: randomUUID(),
      coordinator_url: 'https://previous.invalid',
      rejection: { code: 'credential_revoked', message: 'Old binding revoked', at: new Date().toISOString() },
      batond_version: BUILD.version,
      protocol_version: PROTOCOL_VERSION,
    }),
  )
  expect(await client.status()).toMatchObject({ state: 'connecting' })
  await expect(readFile(join(directory, 'control-state.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.skipIf(process.platform === 'win32')(
  'logout reaps detached Worker descendants before deleting identity',
  async () => {
    const saved = identity()
    const { directory, client } = await fixture({ identity: saved })
    await writePrivateFileAtomic(join(directory, 'identity.json'), JSON.stringify(saved))
    const threadId = randomUUID()
    await ensurePrivateDirectory(join(directory, 'threads'))
    await ensurePrivateDirectory(join(directory, 'threads', threadId))
    const lockPath = join(directory, 'threads', threadId, 'worker.lock')
    const lockModule = new URL('../platform/lock.ts', import.meta.url).href
    const script = `import { acquireProcessLock } from ${JSON.stringify(lockModule)}; import { spawn } from 'node:child_process'; await acquireProcessLock(${JSON.stringify(lockPath)}); const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'}); await new Promise(resolve=>child.once('spawn',resolve)); process.on('SIGTERM',()=>{}); console.log(JSON.stringify({pid:process.pid,child:child.pid})); setInterval(()=>{},1000)`
    const worker = spawn(process.execPath, ['--input-type=module', '-e', script], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await once(worker, 'spawn')
    const [chunk] = await once(worker.stdout, 'data')
    const pids = JSON.parse(String(chunk)) as { pid: number; child: number }
    const record = await readProcessIdentity(pids.pid)
    if (!record) throw new Error('Worker fixture exited before cleanup')
    cleanup.push(() => reapProcessTree(record))
    expect(await readProcessIdentity(pids.child)).not.toBeNull()
    expect(await client.request({ method: 'logout' })).toEqual({ ok: true })
    expect(await readProcessIdentity(pids.pid)).toBeNull()
    expect(await readProcessIdentity(pids.child)).toBeNull()
    await expect(loadIdentity(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  },
  10000,
)
