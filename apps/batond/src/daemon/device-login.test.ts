import { createServer } from 'node:https'
import { readFile, rm } from 'node:fs/promises'
import { once } from 'node:events'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getCACertificates } from 'node:tls'
import { expect, it, vi } from 'vite-plus/test'
import { DeviceLogin, deviceLoginHTTPS } from './device-login.ts'
import { makePrivateTempDirectory } from '../testing/private.ts'

const systemTrust = vi.hoisted(() => ({ roots: [] as string[] }))
vi.mock('node:tls', async (original) => ({
  ...(await original<typeof import('node:tls')>()),
  getCACertificates: vi.fn(() => systemTrust.roots),
}))

it('accepts the production session endpoint HTTP 201 over verified local HTTPS', async () => {
  const cert = await readFile(new URL('../testing/data/device-login.crt', import.meta.url), 'utf8')
  const key = await readFile(new URL('../testing/data/device-login-private-key.txt', import.meta.url), 'utf8')
  systemTrust.roots = [cert]
  const server = createServer({ cert, key }, (_request, response) => {
    response.writeHead(201, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ session_id: 'local-session' }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address !== 'object') throw new Error('No local TLS port')
  try {
    const url = `https://127.0.0.1:${address.port}/api/v1/device-auth/sessions`
    expect(await deviceLoginHTTPS(url, { display_name: 'Local' }, {})).toEqual({ session_id: 'local-session' })
    expect(getCACertificates).toHaveBeenCalledWith('system')
    systemTrust.roots = []
    await expect(deviceLoginHTTPS(url, {}, {})).rejects.toThrow('设备登录请求失败')
  } finally {
    systemTrust.roots = []
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it('cancels a pending daemon login without polling or writing an identity', async () => {
  const directory = await makePrivateTempDirectory('baton-login-')
  const transport = vi.fn(async () => ({
    session_id: randomUUID(),
    device_code: 'secret-device-code',
    user_code: 'ABCD-EFGH',
    verification_uri: 'https://center.invalid/device-login',
    verification_uri_complete: 'https://center.invalid/device-login?code=ABCD-EFGH',
    expires_at: new Date(Date.now() + 600000).toISOString(),
    expires_in_seconds: 600,
    interval_seconds: 2,
  }))
  const approved = vi.fn(async () => undefined)
  const login = new DeviceLogin({
    dataDirectory: directory,
    transport,
    onApproved: approved,
    onFinished: async () => undefined,
  })
  try {
    const publicSession = await login.start('https://center.invalid')
    expect(JSON.stringify(publicSession)).not.toContain('secret-device-code')
    await login.cancel()
    expect(transport).toHaveBeenCalledTimes(1)
    expect(approved).not.toHaveBeenCalled()
    await expect(readFile(join(directory, 'identity.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await login.cancel()
    await rm(directory, { recursive: true, force: true })
  }
})
