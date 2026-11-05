import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { request as httpRequest } from 'node:http'
import { Effect, Exit, Scope } from 'effect'
import { expect, test, vi } from 'vite-plus/test'
import * as P from '@baton/protocol'
import * as Auth from '@baton/server/auth'
import * as Nodes from '@baton/server/nodes'
import { startServer } from '@baton/server/server'
import { openTestDatabase } from '@baton/server/testing/database'
import { runDaemon } from '@baton/batond/daemon/daemon'
import { ControlClient } from '@baton/batond/daemon/control-client'
import { connectWebSocket } from '@baton/batond/daemon/transport'
import { loadIdentity } from '@baton/batond/daemon/identity'

test('device-code approval binds a resident daemon through HTTP and authenticated local control', async () => {
  const database = await openTestDatabase()
  const directory = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'baton-device-login-'))
  const dataDirectory = join(directory, 'node')
  const origin = 'https://baton.local'
  const serverScope = await Effect.runPromise(Scope.make())
  const daemonController = new AbortController()
  let daemon: Promise<void> | undefined
  try {
    await writeFile(join(directory, 'index.html'), '<!doctype html><title>Local device login</title>')
    const server = await database.run(
      startServer({
        port: 0,
        allowedOrigins: [origin],
        signer: Nodes.CredentialSigner.generate(),
        webDirectory: directory,
        dispatchMs: 20,
        heartbeatMs: 1000,
        offlineMs: 5000,
      }).pipe(Effect.provideService(Scope.Scope, serverScope)),
    )
    const base = `http://127.0.0.1:${server.port}`
    const username = 'devicealice'
    const password = 'offline-device-login-password'
    const employee = await database.run(Auth.createEmployee(username, 'Device Alice', password))
    await database.run(Auth.changePassword(employee.id, password, 'offline-device-updated-password'))
    let cookie = ''
    let csrf = ''
    const browser = async (path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(`${base}/api/v1${path}`, {
        method,
        headers: {
          Host: 'baton.local',
          Origin: origin,
          Cookie: cookie,
          'X-CSRF-Token': csrf,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const sessionCookie = response.headers.get('set-cookie')
      if (sessionCookie) cookie = sessionCookie.split(';')[0]!
      return response
    }
    const login = await browser('/login', 'POST', { username, password: 'offline-device-updated-password' })
    expect(login.status).toBe(200)
    csrf = ((await login.json()) as P.SessionResponse).csrf_token
    let connectionAttempts = 0
    daemon = Effect.runPromise(
      Effect.scoped(
        runDaemon({
          dataDirectory,
          heartbeatMs: 1000,
          pollIntervalMs: 20,
          probeIntervalMs: 60000,
          probe: async () => [],
          deviceLoginTransport: (url, body, options) =>
            new Promise((resolve, reject) => {
              // Only this transport maps the public HTTPS origin to the local fixture.
              const request = httpRequest(
                `${base}${new URL(url).pathname}`,
                {
                  method: 'POST',
                  headers: { Host: 'baton.local', 'content-type': 'application/json' },
                  ...(options.signal ? { signal: options.signal } : {}),
                },
                (response) => {
                  let text = ''
                  response.setEncoding('utf8')
                  response.on('data', (chunk: string) => {
                    text += chunk
                  })
                  response.on('error', reject)
                  response.on('end', () => {
                    if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
                      reject(new Error(`Device login HTTP ${response.statusCode}`))
                      return
                    }
                    try {
                      resolve(JSON.parse(text))
                    } catch (error) {
                      reject(error)
                    }
                  })
                },
              )
              request.on('error', reject)
              request.end(JSON.stringify(body))
            }),
          transport: (_url, options) => {
            connectionAttempts++
            return connectWebSocket(`ws://127.0.0.1:${server.port}/v1/node`, options)
          },
        }),
      ),
      { signal: daemonController.signal },
    )
    const client = new ControlClient(dataDirectory)
    const status = () => client.request({ method: 'status' }, { autostart: false })
    await vi.waitFor(async () => expect((await status()).state).toBe('unbound'))
    const pending = await client.request({
      method: 'login_start',
      coordinator_url: origin,
      display_name: 'Local test device',
    })
    expect(pending).toMatchObject({ ok: true, status: 'pending' })
    expect(JSON.stringify(pending)).not.toContain('device_code')
    expect(pending.verification_uri_complete).toContain('/device-login?code=')
    const lookup = await browser(`/device-auth/sessions/by-code/${pending.user_code}`)
    expect(lookup.status).toBe(200)
    expect(await lookup.json()).toMatchObject({
      session_id: pending.session_id,
      display_name: 'Local test device',
      user_code: pending.user_code,
    })
    const approvePath = `/device-auth/sessions/${pending.session_id}/approve`
    expect((await browser(approvePath, 'POST', { user_code: pending.user_code })).status).toBe(204)
    await vi.waitFor(async () => expect((await status()).state).toBe('online'), { timeout: 8000 })
    const identity = await loadIdentity(dataDirectory)
    expect(identity.employee_id).toBe(employee.id)
    expect(((await browser('/nodes').then((response) => response.json())) as P.NodesResponse).nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: identity.node_id, online: true, synced: true })]),
    )
    const repeated = await client.request({ method: 'login_start', coordinator_url: origin })
    expect(repeated).toMatchObject({ ok: true, status: 'already_bound' })
    expect((await loadIdentity(dataDirectory)).node_id).toBe(identity.node_id)
    expect(await client.request({ method: 'login_start', coordinator_url: 'https://another.local' })).toMatchObject({
      ok: false,
      code: 'logout_required',
    })
    expect((await browser(`/nodes/${identity.node_id}/revoke`, 'POST', {})).status).toBe(200)
    await vi.waitFor(async () => expect((await status()).state).toBe('rejected'), { timeout: 5000 })
    const rejectedAttempts = connectionAttempts
    expect(await client.request({ method: 'login_start', coordinator_url: origin })).toMatchObject({
      ok: false,
      code: 'logout_required',
    })
    expect(connectionAttempts).toBe(rejectedAttempts)
    expect(await client.request({ method: 'logout' })).toMatchObject({ ok: true })
    expect((await status()).state).toBe('unbound')
    await expect(readFile(join(dataDirectory, 'identity.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await client.shutdown()).toMatchObject({ ok: true })
    await daemon
    daemon = undefined
  } finally {
    daemonController.abort()
    await daemon?.catch(() => {})
    await database.run(Scope.close(serverScope, Exit.void))
    await database.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
