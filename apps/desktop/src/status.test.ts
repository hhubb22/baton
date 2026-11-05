import { expect, it } from 'vite-plus/test'
import { canExposeBridge } from './bridge.ts'
import { desktopStatus, desktopStatusReason, stoppedStatus } from './status.ts'

it('maps the control status without inventing a bound identity', () => {
  expect(desktopStatus({ ok: true, state: 'unbound', service_installed: false })).toEqual({
    state: 'unbound',
    registered: false,
    service_installed: false,
  })
  expect(
    desktopStatus({
      ok: true,
      state: 'online',
      pid: 42,
      batond_version: '1.0.0',
      protocol_version: 1,
      platform: 'darwin arm64',
      coordinator_url: 'https://center.test',
      node_id: '11111111-1111-4111-8111-111111111111',
      employee_id: '22222222-2222-4222-8222-222222222222',
      display_name: 'MacBook',
      service_installed: true,
    }),
  ).toMatchObject({
    state: 'online',
    registered: true,
    node_id: '11111111-1111-4111-8111-111111111111',
    display_name: 'MacBook',
    service_installed: true,
  })
})

it('reports rejection before a transient error and falls back to a stopped status', () => {
  const rejection = { code: 'credential_revoked', message: '凭据已吊销', at: '2026-01-01T00:00:00.000Z' }
  expect(desktopStatusReason(desktopStatus({ ok: true, state: 'rejected', rejection }))).toBe('凭据已吊销')
  expect(desktopStatusReason(stoppedStatus('无法启动'))).toBe('无法启动')
  expect(stoppedStatus().state).toBe('stopped')
})

it('only exposes the bridge to the saved center main frame', () => {
  expect(canExposeBridge(true, 'https://center.test', 'https://center.test')).toBe(true)
  expect(canExposeBridge(false, 'https://center.test', 'https://center.test')).toBe(false)
  expect(canExposeBridge(true, 'https://elsewhere.test', 'https://center.test')).toBe(false)
  expect(canExposeBridge(true, 'file:///setup.html', undefined)).toBe(false)
  expect(canExposeBridge(true, 'https://center.test', '')).toBe(false)
})
