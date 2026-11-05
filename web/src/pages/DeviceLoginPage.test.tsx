import { createMemoryHistory } from '@tanstack/react-router'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vite-plus/test'
import { App } from '../app/App'
import { createAppRouter } from '../app/router'
import { ClientError } from '../data/client'
import { HttpError } from '../data/http/transport'
import { createMockClient } from '../data/mock/client'
import type { ScenarioId } from '../data/mock/scenarios'

function setup(path = '/device-login?code=ABCD-EFGH', scenario: ScenarioId = 'normal') {
  const client = createMockClient(scenario, { latency: { read: 0, save: 0, device: 0, run: 8000 } })
  const lookup = vi.spyOn(client, 'getDeviceLoginSession')
  const approve = vi.spyOn(client, 'approveDeviceLoginSession')
  const deny = vi.spyOn(client, 'denyDeviceLoginSession')
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) })
  const show = () => render(<App client={client} router={router} />)
  return { client, lookup, approve, deny, router, show }
}

it('prefills the short code and requires explicit approval after showing the device', async () => {
  const user = userEvent.setup()
  const f = setup()
  f.show()
  expect(await screen.findByText('Build server')).toBeInTheDocument()
  expect(screen.getByText('Linux')).toBeInTheDocument()
  expect(screen.getByLabelText('设备登录码')).toHaveValue('ABCD-EFGH')
  expect(f.lookup).toHaveBeenCalledWith('ABCD-EFGH')
  expect(f.approve).not.toHaveBeenCalled()
  expect(f.deny).not.toHaveBeenCalled()
  expect(document.body.textContent).not.toContain('device_code')
  await user.click(screen.getByRole('button', { name: '允许登录' }))
  expect(await screen.findByRole('status')).toHaveTextContent('已允许设备登录')
  expect(f.approve).toHaveBeenCalledExactlyOnceWith('device-login-session', 'ABCD-EFGH')
  expect(screen.queryByRole('button', { name: '允许登录' })).not.toBeInTheDocument()
})

it('accepts a manual code and explicitly denies the matching request', async () => {
  const user = userEvent.setup()
  const f = setup('/device-login')
  f.show()
  await screen.findByLabelText('设备登录码')
  expect(f.lookup).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: '查找设备' }))
  expect(await screen.findByText('请输入设备登录码。')).toBeInTheDocument()
  await user.type(screen.getByLabelText('设备登录码'), '  abcd-efgh  ')
  await user.click(screen.getByRole('button', { name: '查找设备' }))
  expect(await screen.findByText('Build server')).toBeInTheDocument()
  expect(f.lookup).toHaveBeenCalledWith('abcd-efgh')
  expect(f.router.state.location.search).toEqual({ code: 'abcd-efgh' })
  await user.click(screen.getByRole('button', { name: '拒绝登录' }))
  expect(await screen.findByRole('status')).toHaveTextContent('已拒绝设备登录')
  expect(f.deny).toHaveBeenCalledExactlyOnceWith('device-login-session')
  expect(f.approve).not.toHaveBeenCalled()
})

it('preserves the confirmation URL and code through employee login', async () => {
  const user = userEvent.setup()
  const f = setup('/device-login?code=ABCD-EFGH', 'signedOut')
  f.show()
  await user.type(await screen.findByLabelText('用户名'), 'kaken')
  expect(f.router.state.location.search).toMatchObject({ redirect: '/device-login?code=ABCD-EFGH' })
  expect(f.lookup).not.toHaveBeenCalled()
  await user.type(screen.getByLabelText('密码'), 'sample-password')
  await user.click(screen.getByRole('button', { name: '登录' }))
  expect(await screen.findByText('Build server')).toBeInTheDocument()
  expect(f.router.state.location.href).toBe('/device-login?code=ABCD-EFGH')
  expect(f.approve).not.toHaveBeenCalled()
})

it('preserves the code when a password change is required', async () => {
  const f = setup()
  const session = await f.client.getSession()
  vi.spyOn(f.client, 'getSession').mockResolvedValue({ ...session, mustChangePassword: true })
  f.show()
  await screen.findByRole('heading', { name: '修改密码' })
  expect(f.router.state.location.search).toMatchObject({ redirect: '/device-login?code=ABCD-EFGH' })
  expect(f.lookup).not.toHaveBeenCalled()
  expect(f.approve).not.toHaveBeenCalled()
})

it.each([
  [404, 'device_login_not_found', '找不到待确认的设备登录码'],
  [410, 'device_login_expired', '设备登录码已过期'],
  [409, 'device_login_handled', '此设备登录请求已处理'],
])('shows lookup failure %s without offering approval', async (status, code, message) => {
  const f = setup()
  f.lookup.mockRejectedValueOnce(new HttpError(status, { code }))
  f.show()
  expect(await screen.findByRole('alert')).toHaveTextContent(message)
  expect(screen.getByLabelText('设备登录码')).toHaveValue('ABCD-EFGH')
  expect(screen.queryByRole('button', { name: '允许登录' })).not.toBeInTheDocument()
})

it.each([409, 410])('handles a request resolved or expired before approval (%s)', async (status) => {
  const user = userEvent.setup()
  const f = setup()
  f.approve.mockRejectedValueOnce(
    new HttpError(status, { code: status === 410 ? 'device_login_expired' : 'device_login_handled' }),
  )
  f.show()
  await user.click(await screen.findByRole('button', { name: '允许登录' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(status === 410 ? '已过期' : '已处理')
  expect(screen.queryByRole('button', { name: '允许登录' })).not.toBeInTheDocument()
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

it('preserves the code after a network failure and lets the user retry', async () => {
  const user = userEvent.setup()
  const f = setup()
  f.lookup.mockRejectedValueOnce(new ClientError('unavailable', 'offline'))
  f.show()
  expect(await screen.findByRole('alert')).toHaveTextContent('无法连接 Baton，请重试。')
  await user.click(screen.getByRole('button', { name: '查找设备' }))
  expect(await screen.findByText('Build server')).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(f.approve).not.toHaveBeenCalled()
  await user.clear(screen.getByLabelText('设备登录码'))
  await user.type(screen.getByLabelText('设备登录码'), 'WXYZ-1234')
  expect(screen.queryByRole('button', { name: '允许登录' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '查找设备' }))
  await waitFor(() => expect(f.lookup).toHaveBeenLastCalledWith('WXYZ-1234'))
  expect(await screen.findByRole('alert')).toHaveTextContent('找不到待确认的设备登录码')
})
