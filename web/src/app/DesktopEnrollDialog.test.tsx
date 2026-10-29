import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { createMockClient } from '../data/mock/client'
import { ClientProvider } from '../data/queries'
import type { DesktopStatus } from '../data/desktop'
import { createDesktopBridge, registeredDesktop } from '../test/desktop'
import { EnrollDialog } from './EnrollDialog'

afterEach(() => vi.unstubAllGlobals())

function setup(status?: DesktopStatus) {
  const desktop = createDesktopBridge(status)
  vi.stubGlobal('batonDesktop', desktop.bridge)
  const client = createMockClient('downloads', { latency: { read: 0, save: 0, device: 0, run: 8000 } })
  const create = vi.spyOn(client, 'createEnrollment')
  const downloads = vi.spyOn(client, 'getDownloads')
  render(
    <ClientProvider client={client}>
      <EnrollDialog onClose={() => {}} />
    </ClientProvider>,
  )
  return { desktop, client, create, downloads, user: userEvent.setup() }
}

it.each(['', '  Build Mac  '])(
  'connects with display name %j without rendering credentials, commands or downloads',
  async (name) => {
    const f = setup()
    f.desktop.bridge.enroll.mockResolvedValue(registeredDesktop)
    await screen.findByRole('button', { name: '连接' })
    expect(f.create).not.toHaveBeenCalled()
    const input = screen.getByLabelText('设备名称')
    expect(input).toHaveValue('')
    if (name) await f.user.type(input, name)
    await f.user.click(screen.getByRole('button', { name: '连接' }))
    await waitFor(() => expect(f.desktop.bridge.enroll).toHaveBeenCalledTimes(1))
    const issued = await f.create.mock.results[0]!.value
    expect(f.create).toHaveBeenCalledWith(undefined)
    expect(f.desktop.bridge.enroll).toHaveBeenCalledWith({
      code: issued.code,
      ...(name ? { displayName: name.trim() } : {}),
    })
    expect(f.desktop.bridge.reauth).not.toHaveBeenCalled()
    expect(document.body).not.toHaveTextContent(issued.code)
    expect(screen.queryByLabelText('设置码')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('在终端运行')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Download/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: '操作系统' })).not.toBeInTheDocument()
    expect(f.downloads).not.toHaveBeenCalled()
    expect(await screen.findByRole('button', { name: '完成' })).toBeInTheDocument()
  },
)

it('issues a new code on retry, keeps the name and removes credentials from bridge errors', async () => {
  const f = setup()
  f.desktop.bridge.enroll.mockImplementationOnce(async ({ code }) => {
    throw new Error(`Certificate expired. ${code}`)
  })
  f.desktop.bridge.enroll.mockResolvedValue(registeredDesktop)
  await f.user.type(await screen.findByLabelText('设备名称'), 'Build Mac')
  await f.user.click(await screen.findByRole('button', { name: '连接' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Certificate expired.')
  const first = await f.create.mock.results[0]!.value
  expect(document.body).not.toHaveTextContent(first.code)
  expect(screen.getByLabelText('设备名称')).toHaveValue('Build Mac')
  await f.user.click(screen.getByRole('button', { name: '重试' }))
  await waitFor(() => expect(f.desktop.bridge.enroll).toHaveBeenCalledTimes(2))
  const second = await f.create.mock.results[1]!.value
  expect(second.code).not.toBe(first.code)
  expect(f.desktop.bridge.enroll).toHaveBeenLastCalledWith({ code: second.code, displayName: 'Build Mac' })
  expect(document.body).not.toHaveTextContent(second.code)
})

it('reacquires an expired code before sending it to the desktop app', async () => {
  const f = setup()
  const issued = await f.client.createEnrollment()
  f.create.mockClear().mockResolvedValueOnce({ ...issued, state: 'expired', expiresIn: 0, code: 'expired-secret' })
  f.desktop.bridge.enroll.mockResolvedValue(registeredDesktop)
  await f.user.click(await screen.findByRole('button', { name: '连接' }))
  await waitFor(() => expect(f.desktop.bridge.enroll).toHaveBeenCalledTimes(1))
  expect(f.create).toHaveBeenCalledTimes(2)
  expect(f.desktop.bridge.enroll.mock.calls[0]![0].code).not.toBe('expired-secret')
  expect(document.body).not.toHaveTextContent('expired-secret')
})

it('shows an expired bridge credential in UI language and gets a fresh one on retry', async () => {
  const f = setup()
  f.desktop.bridge.enroll.mockRejectedValueOnce(
    new Error("Error invoking remote method 'baton:enroll': Error: 接入凭据已过期，请在中心重新领取"),
  )
  f.desktop.bridge.enroll.mockResolvedValue(registeredDesktop)
  await f.user.click(await screen.findByRole('button', { name: '连接' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('设置码已过期，请重试。')
  expect(document.body).not.toHaveTextContent('baton:enroll')
  await f.user.click(screen.getByRole('button', { name: '重试' }))
  await screen.findByRole('button', { name: '完成' })
  expect(f.create).toHaveBeenCalledTimes(2)
  expect(f.desktop.bridge.enroll.mock.calls[0]![0].code).not.toBe(f.desktop.bridge.enroll.mock.calls[1]![0].code)
})

it('reauthenticates the bridge node without creating another device or showing credentials', async () => {
  const f = setup({ ...registeredDesktop, state: 'rejected', code: 'needs_reauth' })
  f.desktop.bridge.reauth.mockResolvedValue(registeredDesktop)
  await f.user.click(await screen.findByRole('button', { name: '重新连接' }))
  await waitFor(() => expect(f.desktop.bridge.reauth).toHaveBeenCalledTimes(1))
  const issued = await f.create.mock.results[0]!.value
  expect(f.create).toHaveBeenCalledWith('dev-mac')
  expect(f.desktop.bridge.reauth).toHaveBeenCalledWith({ code: issued.code })
  expect(f.desktop.bridge.enroll).not.toHaveBeenCalled()
  expect(screen.queryByLabelText('设备名称')).not.toBeInTheDocument()
  expect(document.body).not.toHaveTextContent(issued.code)
})

it('prevents duplicate clicks while the desktop call is pending', async () => {
  const f = setup()
  let complete!: (status: DesktopStatus) => void
  f.desktop.bridge.enroll.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  const button = await screen.findByRole('button', { name: '连接' })
  await f.user.dblClick(button)
  await waitFor(() => expect(f.desktop.bridge.enroll).toHaveBeenCalledTimes(1))
  expect(f.create).toHaveBeenCalledTimes(1)
  complete(registeredDesktop)
  await screen.findByRole('button', { name: '完成' })
})

it('keeps a rejected registration retryable and follows the center enrollment state', async () => {
  const f = setup()
  f.desktop.bridge.enroll.mockResolvedValueOnce({
    registered: false,
    state: 'rejected',
    message: 'Certificate expired.',
  })
  f.desktop.bridge.enroll.mockImplementationOnce(async () => {
    f.client.controls.connectEnrollment('Build Mac', 'macOS')
    return registeredDesktop
  })
  await f.user.click(await screen.findByRole('button', { name: '连接' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Certificate expired.')
  await f.user.click(screen.getByRole('button', { name: '重试' }))
  await screen.findByRole('button', { name: '完成' })
  expect(f.create).toHaveBeenCalledTimes(2)
  expect(document.body).not.toHaveTextContent((await f.create.mock.results[1]!.value).code)
})

it('keeps connecting when the code is consumed before the device comes online', async () => {
  const f = setup()
  f.desktop.bridge.enroll.mockResolvedValue({ ...registeredDesktop, state: 'connecting' })
  const read = vi.spyOn(f.client, 'getEnrollment').mockImplementation(async (id) => ({
    id,
    state: 'used',
    coordinatorUrl: window.location.origin,
    deviceId: 'dev-mac',
    expiresIn: 600000,
  }))
  await f.user.click(await screen.findByRole('button', { name: '连接' }))
  await screen.findByRole('button', { name: '完成' })
  await waitFor(() => expect(read).toHaveBeenCalled())
  expect(screen.getByText('正在连接…')).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.queryByText(/Setup code expired/)).not.toBeInTheDocument()
})

it('uses an identity created while the dialog was open instead of registering again', async () => {
  const f = setup()
  await screen.findByRole('button', { name: '连接' })
  f.desktop.bridge.status.mockResolvedValue(registeredDesktop)
  await f.user.click(screen.getByRole('button', { name: '连接' }))
  await screen.findByRole('button', { name: '完成' })
  expect(f.create).not.toHaveBeenCalled()
  expect(f.desktop.bridge.enroll).not.toHaveBeenCalled()
  expect(f.desktop.bridge.reauth).not.toHaveBeenCalled()
})

it('does not reauthenticate another device through the local bridge', async () => {
  const desktop = createDesktopBridge({ ...registeredDesktop, state: 'rejected', code: 'needs_reauth' })
  vi.stubGlobal('batonDesktop', desktop.bridge)
  const client = createMockClient('downloads', { latency: { read: 0, save: 0, device: 0, run: 8000 } })
  const remote = (await client.listDevices()).find((device) => device.id === 'dev-ubuntu')!
  const create = vi.spyOn(client, 'createEnrollment')
  render(
    <ClientProvider client={client}>
      <EnrollDialog device={remote} onClose={() => {}} />
    </ClientProvider>,
  )
  expect(await screen.findByRole('alert')).toHaveTextContent('请在浏览器中重新连接此设备。')
  expect(screen.queryByRole('button', { name: '重新连接' })).not.toBeInTheDocument()
  expect(create).not.toHaveBeenCalled()
  expect(desktop.bridge.reauth).not.toHaveBeenCalled()
})

it('retries a failed code request without sending an empty credential', async () => {
  const f = setup()
  f.create.mockRejectedValueOnce(new Error('Baton could not be reached.'))
  f.desktop.bridge.enroll.mockResolvedValue(registeredDesktop)
  await f.user.click(await screen.findByRole('button', { name: '连接' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Baton could not be reached.')
  expect(f.desktop.bridge.enroll).not.toHaveBeenCalled()
  await f.user.click(screen.getByRole('button', { name: '重试' }))
  await waitFor(() => expect(f.desktop.bridge.enroll).toHaveBeenCalledTimes(1))
})
