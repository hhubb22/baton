import { createMemoryHistory } from '@tanstack/react-router'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { App } from '../app/App'
import { createAppRouter } from '../app/router'
import { createMockClient } from '../data/mock/client'
import { createDesktopBridge, registeredDesktop } from '../test/desktop'
import { chooseOption } from '../test/select'

afterEach(() => vi.unstubAllGlobals())

it('adds, edits and deletes a device API connection without sending a key to the center', async () => {
  const user = userEvent.setup()
  const client = createMockClient('modelSources', { latency: { read: 0, save: 0, device: 0, run: 8000 } })
  const configure = vi.spyOn(client, 'configureModelConnection')
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: ['/devices'] }) })
  render(<App client={client} router={router} />)
  await user.click(await screen.findByRole('button', { name: /^Ubuntu Dev/ }))
  expect(screen.getByText(/2 个 API 连接（1 个需要密钥）/)).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '项目助手' }))
  const assistantDialog = await screen.findByRole('dialog', { name: 'Ubuntu Dev 上的项目助手' })
  expect(within(assistantDialog).getByText('Local gateway')).toBeInTheDocument()
  expect(within(assistantDialog).getByText(/需要密钥/)).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '添加连接' }))
  await user.type(screen.getByLabelText('名称'), 'Custom')
  await user.clear(screen.getByLabelText('服务地址'))
  await user.type(screen.getByLabelText('服务地址'), 'http://localhost:9999/v1')
  await chooseOption(user, screen.getByLabelText('协议'), 'Anthropic Messages')
  expect(screen.getByLabelText('服务地址')).toHaveValue('http://localhost:9999/v1')
  expect(screen.getByText(/localhost:9999\/v1\/messages\?beta=true/)).toBeInTheDocument()
  await user.type(screen.getByLabelText('模型 ID'), 'model-id')
  expect(screen.getByText(/connection-key/)).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '保存连接' }))
  await screen.findByText('Custom')
  expect(configure).toHaveBeenCalledWith(
    expect.objectContaining({
      action: 'save',
      connection: expect.objectContaining({ name: 'Custom', models: ['model-id'] }),
    }),
  )
  expect(JSON.stringify(configure.mock.calls)).not.toContain('key-file contents')
  await user.click(screen.getByRole('button', { name: '完成' }))
  await user.click(screen.getByRole('button', { name: '新建项目' }))
  await user.type(screen.getByLabelText('名称'), 'API project')
  await chooseOption(user, screen.getByLabelText('模型来源'), 'Custom · Ubuntu Dev')
  expect(screen.getByText(/此连接需要设备在线并配置 API 密钥/)).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '创建项目' }))
  await waitFor(async () =>
    expect(
      (await client.listProjects()).some(
        (item) => item.name === 'API project' && item.sourceNodeId === 'dev-ubuntu' && item.model === 'model-id',
      ),
    ).toBe(true),
  )
  expect(await screen.findByText('Custom · Ubuntu Dev · model-id')).toBeInTheDocument()
  await user.click(screen.getByRole('link', { name: /设备/ }))
  await user.click(await screen.findByRole('button', { name: /^Ubuntu Dev/ }))
  await user.click(screen.getByRole('button', { name: '项目助手' }))
  await user.click(screen.getByRole('button', { name: '编辑 Custom' }))
  await user.click(screen.getByRole('button', { name: '删除连接' }))
  expect(screen.getByText(/删除此连接后，API project/)).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '确认删除' }))
  await waitFor(() => expect(screen.queryByText('Custom')).not.toBeInTheDocument())
})

it('loads the complete model list before editing a truncated device report', async () => {
  const user = userEvent.setup()
  const client = createMockClient('modelSources', { latency: { read: 0, save: 0, device: 0, run: 8000 } })
  const list = client.listDevices.bind(client)
  client.listDevices = async () =>
    (await list()).map((device) => ({
      ...device,
      modelConnections: device.modelConnections?.map((connection) =>
        connection.name === 'Local gateway' ? { ...connection, models: [], modelsTruncated: true } : connection,
      ),
    }))
  const original = client.configureModelConnection.bind(client)
  let release!: () => void
  const delayed = new Promise<void>((resolve) => {
    release = resolve
  })
  const configure = vi.spyOn(client, 'configureModelConnection').mockImplementation(async (input) => {
    if (input.action === 'get') await delayed
    return original(input)
  })
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: ['/devices'] }) })
  render(<App client={client} router={router} />)
  await user.click(await screen.findByRole('button', { name: /^Ubuntu Dev/ }))
  await user.click(screen.getByRole('button', { name: '项目助手' }))
  await user.click(screen.getByRole('button', { name: '编辑 Local gateway' }))
  expect(screen.getByLabelText('模型 ID')).toHaveAttribute('readonly')
  await user.clear(screen.getByLabelText('名称'))
  await user.type(screen.getByLabelText('名称'), 'Edited while loading')
  await user.clear(screen.getByLabelText('服务地址'))
  await user.type(screen.getByLabelText('服务地址'), 'http://localhost:9999/v1')
  await act(async () => release())
  await waitFor(() => expect(screen.getByLabelText('模型 ID')).toHaveValue('local-model'))
  expect(screen.getByLabelText('名称')).toHaveValue('Edited while loading')
  expect(screen.getByLabelText('服务地址')).toHaveValue('http://localhost:9999/v1')
  expect(screen.getByLabelText('模型 ID')).not.toHaveAttribute('readonly')
  expect(configure).toHaveBeenCalledWith(expect.objectContaining({ action: 'get' }))
  expect(screen.getByRole('button', { name: '保存连接' })).toBeEnabled()
})

it('shows read-only summaries in the expanded row and inspects coding agents in a split modal', async () => {
  const user = userEvent.setup()
  const client = createMockClient('error', { latency: { read: 0, save: 0, device: 0, run: 8000 } })
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: ['/devices'] }) })
  render(<App client={client} router={router} />)
  await user.click(await screen.findByRole('button', { name: /^Ubuntu Dev/ }))
  expect(screen.getByText('Claude 已登录')).toBeInTheDocument()
  expect(screen.getByText('Kiro 可用 · Codex ChatGPT 登录已过期')).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: '编码 Agent' }))
  const dialog = await screen.findByRole('dialog', { name: 'Ubuntu Dev 上的编码 Agent' })
  // 默认选中第一个需要处理的 Agent（Codex）
  expect(screen.getByRole('tab', { name: /Codex/ })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByText('ChatGPT 登录已过期')).toBeInTheDocument()
  expect(screen.getByText(/codex login/)).toBeInTheDocument()

  // 切换到可用的 Kiro 查看模型与能力
  await user.click(screen.getByRole('tab', { name: /Kiro/ }))
  expect(screen.getByRole('tab', { name: /Kiro/ })).toHaveAttribute('aria-selected', 'true')
  expect(within(dialog).getByText('claude-sonnet-5-5')).toBeInTheDocument()
  expect(within(dialog).getByText('新建对话')).toBeInTheDocument()
})

describe('desktop app link', () => {
  it.each([
    [undefined, true, true, true],
    [1, true, true, false],
    [2, true, true, true],
    [undefined, false, false, false],
    [undefined, true, false, false],
  ])('handles bridge %s, downloads %s and connect URL %s', async (protocol, enabled, hasLink, visible) => {
    vi.stubGlobal(
      'batonDesktop',
      protocol === 1 ? createDesktopBridge().bridge : protocol === undefined ? undefined : { protocol },
    )
    const client = createMockClient(enabled ? 'downloads' : 'noDownloads', {
      latency: { read: 0, save: 0, device: 0, run: 8000 },
    })
    const downloads = await client.getDownloads()
    const getDownloads = vi.spyOn(client, 'getDownloads').mockResolvedValue({
      ...downloads,
      connect_url: hasLink ? downloads.connect_url : null,
    })
    const router = createAppRouter({ history: createMemoryHistory({ initialEntries: ['/devices'] }) })
    render(<App client={client} router={router} />)
    await screen.findByRole('heading', { name: '3 台设备，2 台在线' })
    await waitFor(() => expect(getDownloads).toHaveBeenCalled())
    if (visible) {
      expect(await screen.findByRole('link', { name: '在桌面客户端打开' })).toHaveAttribute(
        'href',
        downloads.connect_url,
      )
    } else {
      expect(screen.queryByRole('link', { name: '在桌面客户端打开' })).not.toBeInTheDocument()
    }
  })
})

function desktopPage(initial = createDesktopBridge()) {
  vi.stubGlobal('batonDesktop', initial.bridge)
  const client = createMockClient('downloads', { latency: { read: 0, save: 0, device: 0, run: 8000 } })
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: ['/devices'] }) })
  return {
    client,
    desktop: initial,
    user: userEvent.setup(),
    show: () => render(<App client={client} router={router} />),
  }
}

it('tracks desktop status and shows the rejection reason', async () => {
  const f = desktopPage()
  const view = f.show()
  await screen.findByRole('button', { name: '连接这台电脑' })
  expect(screen.queryByRole('button', { name: '连接设备' })).not.toBeInTheDocument()
  await act(async () => f.desktop.publish(registeredDesktop))
  await waitFor(() => expect(screen.getByRole('region', { name: '此电脑' })).toHaveTextContent('在线'))
  expect(screen.queryByRole('button', { name: '连接这台电脑' })).not.toBeInTheDocument()
  await act(async () =>
    f.desktop.publish({
      ...registeredDesktop,
      state: 'rejected',
      rejection: {
        code: 'node_version_incompatible',
        message: '请从 Baton 下载最新的桌面客户端。',
        at: new Date().toISOString(),
      },
    }),
  )
  await waitFor(() => expect(screen.getByRole('region', { name: '此电脑' })).toHaveTextContent('连接被拒绝'))
  expect(screen.getByText('请从 Baton 下载最新的桌面客户端。')).toBeInTheDocument()
  await act(async () =>
    f.desktop.publish({
      ...registeredDesktop,
      state: 'rejected',
      rejection: { code: 'unauthorized', message: 'Certificate expired.', at: new Date().toISOString() },
    }),
  )
  expect(await screen.findByText('Certificate expired.')).toBeInTheDocument()
  view.unmount()
  expect(f.desktop.listeners.size).toBe(0)
})

it('connects this computer with a device login code', async () => {
  const f = desktopPage()
  const approve = vi.spyOn(f.client, 'approveDeviceLoginSession')
  f.show()
  await f.user.click(await screen.findByRole('button', { name: '连接这台电脑' }))
  const dialog = await screen.findByRole('dialog', { name: '连接这台电脑' })
  expect(await within(dialog).findByText('ABCD-EFGH')).toBeInTheDocument()
  expect(await within(dialog).findByText('Build server')).toBeInTheDocument()
  expect(within(dialog).getByText('Linux')).toBeInTheDocument()
  expect(f.desktop.bridge.startLogin).toHaveBeenCalledWith({})
  expect(within(dialog).getByText('10 分钟内有效')).toBeInTheDocument()
  expect(document.body).not.toHaveTextContent('device_code')
  await f.user.click(within(dialog).getByRole('button', { name: '允许登录' }))
  await waitFor(() => expect(approve).toHaveBeenCalledWith('device-login-session', 'ABCD-EFGH'))
  expect(within(dialog).getByText('已允许登录，正在完成连接。可以关闭此窗口。')).toBeInTheDocument()
  await act(async () => f.desktop.publish(registeredDesktop))
  await waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent('此电脑已连接。'))
  expect(document.body).not.toHaveTextContent('device_code')
})

it('cancels a pending device login when the dialog closes', async () => {
  const f = desktopPage()
  f.show()
  await f.user.click(await screen.findByRole('button', { name: '连接这台电脑' }))
  const dialog = await screen.findByRole('dialog', { name: '连接这台电脑' })
  await within(dialog).findByText('ABCD-EFGH')
  await f.user.click(within(dialog).getByRole('button', { name: '取消' }))
  await waitFor(() => expect(f.desktop.bridge.cancelLogin).toHaveBeenCalledTimes(1))
  expect(screen.queryByRole('dialog', { name: '连接这台电脑' })).not.toBeInTheDocument()
})

it('retries failed status reads and ignores an older initial read after a status notification', async () => {
  const f = desktopPage()
  f.desktop.bridge.status.mockRejectedValueOnce(new Error('IPC unavailable'))
  f.show()
  expect(await screen.findByRole('alert')).toHaveTextContent('无法读取此电脑的状态。')
  let finish!: (status: typeof registeredDesktop) => void
  f.desktop.bridge.status.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  await f.user.click(screen.getByRole('button', { name: '重试' }))
  await act(async () => f.desktop.publish(registeredDesktop))
  await act(async () => finish({ registered: false, state: 'unbound' }))
  await waitFor(() => expect(screen.getByRole('region', { name: '此电脑' })).toHaveTextContent('在线'))
  expect(screen.queryByRole('button', { name: '连接此电脑' })).not.toBeInTheDocument()
})
