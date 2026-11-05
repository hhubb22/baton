import { expect, it, vi } from 'vite-plus/test'
import type { ControlClient } from '@baton/batond/daemon/control-client'
import type { ControlResponse } from '@baton/batond/daemon/control'
import { DaemonClient, quitAction, stopDaemonForQuit } from './daemon-client.ts'

function control(responses: ControlResponse[]) {
  const request = vi.fn(async () => {
    const response = responses.shift()
    if (!response) throw new Error('unexpected request')
    return response
  })
  return { request, client: { request } as unknown as ControlClient }
}

it('returns a pending device login with only public fields', async () => {
  const { request, client: controlClient } = control([
    {
      ok: true,
      status: 'pending',
      session_id: 'session',
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://center.test/device-login',
      verification_uri_complete: 'https://center.test/device-login?user_code=ABCD-EFGH',
      expires_at: '2026-01-01T00:10:00.000Z',
      expires_in_seconds: 600,
    },
  ])
  const client = new DaemonClient('/resources', '/data', controlClient)
  await expect(client.startLogin('https://center.test', 'MacBook')).resolves.toEqual({
    status: 'pending',
    login: {
      session_id: 'session',
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://center.test/device-login',
      verification_uri_complete: 'https://center.test/device-login?user_code=ABCD-EFGH',
      expires_at: '2026-01-01T00:10:00.000Z',
      expires_in_seconds: 600,
    },
  })
  expect(request).toHaveBeenCalledWith(
    { method: 'login_start', coordinator_url: 'https://center.test', display_name: 'MacBook' },
    {},
  )
})

it('reports an already bound device and rejects a malformed pending answer', async () => {
  const { client: bound } = control([
    { ok: true, status: 'already_bound' },
    { ok: true, state: 'online', node_id: 'node' },
  ])
  await expect(new DaemonClient('/resources', '/data', bound).startLogin('https://center.test')).resolves.toMatchObject(
    { status: 'already_bound', device: { state: 'online' } },
  )
  const { client: missing } = control([{ ok: true, status: 'pending' }])
  await expect(new DaemonClient('/resources', '/data', missing).startLogin('https://center.test')).rejects.toThrow(
    '未能开始',
  )
})

it('resolves a thread directory through the control channel', async () => {
  const { client: controlClient } = control([
    {
      ok: true,
      node_id: '11111111-1111-4111-8111-111111111111',
      employee_id: '22222222-2222-4222-8222-222222222222',
      coordinator_url: 'https://center.test',
      directory: '/work',
    },
  ])
  await expect(
    new DaemonClient('/resources', '/data', controlClient).threadDirectory('33333333-3333-4333-8333-333333333333'),
  ).resolves.toEqual({
    node_id: '11111111-1111-4111-8111-111111111111',
    employee_id: '22222222-2222-4222-8222-222222222222',
    coordinator_url: 'https://center.test',
    working_directory: '/work',
  })
})

it('never shuts down a user service but stops an ad hoc daemon within ten seconds', async () => {
  expect(quitAction(true)).toBe('keep')
  expect(quitAction(false)).toBe('shutdown')
  expect(quitAction(undefined)).toBe('shutdown')
  const { request: serviceRequest, client: service } = control([])
  await expect(
    stopDaemonForQuit(service, { state: 'online', registered: true, service_installed: true }),
  ).resolves.toBe('keep')
  expect(serviceRequest).not.toHaveBeenCalled()
  const { request: adhocRequest, client: adhoc } = control([{ ok: true }])
  await expect(stopDaemonForQuit(adhoc, { state: 'online', registered: true, service_installed: false })).resolves.toBe(
    'shutdown',
  )
  expect(adhocRequest).toHaveBeenCalledWith({ method: 'shutdown' }, { autostart: false, timeoutMs: 10_000 })
})

it('turns an unavailable control channel into a stopped status', async () => {
  const fake = {
    request: vi.fn(async () => {
      throw new Error('unreachable')
    }),
  } as unknown as ControlClient
  await expect(new DaemonClient('/resources', '/data', fake).status()).resolves.toMatchObject({
    state: 'stopped',
    registered: false,
  })
})
