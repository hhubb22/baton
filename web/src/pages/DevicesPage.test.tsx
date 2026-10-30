import { createMemoryHistory } from '@tanstack/react-router'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { App } from '../app/App'
import { createAppRouter } from '../app/router'
import { createMockClient } from '../data/mock/client'
import { createDesktopBridge, registeredDesktop } from '../test/desktop'

afterEach(() => vi.unstubAllGlobals())

it('queues an update for an offline device and displays reported progress', async () => {
  const user = userEvent.setup()
  const client = createMockClient('normal', { latency: { read: 0, save: 0, device: 0, run: 8000 } })
  const list = client.listDevices.bind(client)
  client.listDevices = async () =>
    (await list()).map((device) => ({
      ...device,
      connection: 'offline' as const,
      updateProtocol: 1,
      updateManagementLastSeen: Date.now(),
      updateAvailability: { status: 'available' as const, version: 'v2', checkedAt: Date.now() },
    }))
  const update = vi.spyOn(client, 'updateDevice').mockResolvedValue(undefined)
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: ['/devices'] }) })
  render(<App client={client} router={router} />)
  await user.click(await screen.findByRole('button', { name: /^Ubuntu Dev/ }))
  expect(screen.getByText('更新管理通道可用')).toBeInTheDocument()
  expect(screen.getByText(/有新版本 v2 · 检查时间/)).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '更新设备' }))
  expect(update).toHaveBeenCalledWith('dev-ubuntu')
  expect(await screen.findByText('更新请求已保存，等待设备处理。')).toBeInTheDocument()
})

it('asks for local initialization when the device does not report update support', async () => {
  const user = userEvent.setup()
  const client = createMockClient('normal', { latency: { read: 0, save: 0, device: 0, run: 8000 } })
  const update = vi.spyOn(client, 'updateDevice')
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: ['/devices'] }) })
  render(<App client={client} router={router} />)
  await user.click(await screen.findByRole('button', { name: /^Ubuntu Dev/ }))
  expect(screen.getByText('请在设备上安装新版并完成一次本机初始化。')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '更新设备' })).not.toBeInTheDocument()
  expect(update).not.toHaveBeenCalled()
})

it('shows reported device update progress without changing its connection state', async () => {
  const user = userEvent.setup()
  const client = createMockClient('normal', { latency: { read: 0, save: 0, device: 0, run: 8000 } })
  const list = client.listDevices.bind(client)
  client.listDevices = async () =>
    (await list()).map((device) =>
      device.id === 'dev-ubuntu'
        ? {
            ...device,
            connection: 'offline' as const,
            updateProtocol: 1,
            upgradeState: {
              operationId: 'operation',
              sourceVersion: 'v1',
              targetVersion: 'v2',
              phase: 'migrating' as const,
            },
          }
        : device,
    )
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: ['/devices'] }) })
  render(<App client={client} router={router} />)
  await user.click(await screen.findByRole('button', { name: /^Ubuntu Dev/ }))
  expect(screen.getByText('v2 · 正在迁移')).toBeInTheDocument()
  expect(screen.getByText('新对话将等待设备就绪。')).toBeInTheDocument()
})

it('adds, edits and deletes a device API connection without sending a key to the center', async () => {
  const user = userEvent.setup()
  const client = createMockClient('modelSources', { latency: { read: 0, save: 0, device: 0, run: 8000 } })
  const configure = vi.spyOn(client, 'configureModelConnection')
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: ['/devices'] }) })
  render(<App client={client} router={router} />)
  await user.click(await screen.findByRole('button', { name: /^Ubuntu Dev/ }))
  expect(screen.getByText('Local gateway')).toBeInTheDocument()
  expect(screen.getByText(/需要密钥/)).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '添加连接' }))
  await user.type(screen.getByLabelText('名称'), 'Custom')
  await user.clear(screen.getByLabelText('服务地址'))
  await user.type(screen.getByLabelText('服务地址'), 'http://localhost:9999/v1')
  await user.selectOptions(screen.getByLabelText('协议'), 'anthropic-messages')
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
  await user.click(screen.getByRole('button', { name: '新建项目' }))
  await user.type(screen.getByLabelText('名称'), 'API project')
  await user.selectOptions(
    screen.getByLabelText('模型来源'),
    screen.getByRole('option', { name: 'Custom · Ubuntu Dev' }),
  )
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

it('offers local setup and tracks desktop updates, including external ownership and rejection reasons', async () => {
  const f = desktopPage()
  const view = f.show()
  await screen.findByRole('button', { name: '连接此电脑' })
  expect(screen.queryByRole('button', { name: '连接设备' })).not.toBeInTheDocument()
  await act(async () => f.desktop.publish(registeredDesktop))
  await waitFor(() => expect(screen.getByRole('region', { name: '此电脑' })).toHaveTextContent('在线'))
  expect(screen.queryByRole('button', { name: '连接此电脑' })).not.toBeInTheDocument()
  await act(async () =>
    f.desktop.publish({ ...registeredDesktop, state: 'external', connection_state: 'rejected', code: 'needs_reauth' }),
  )
  await waitFor(() => expect(screen.getByRole('region', { name: '此电脑' })).toHaveTextContent('由外部服务管理'))
  expect(screen.getByText('此电脑的登录已过期。')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '重新连接此电脑' })).toBeInTheDocument()
  await act(async () =>
    f.desktop.publish({ ...registeredDesktop, state: 'rejected', code: 'node_version_incompatible' }),
  )
  await waitFor(() => expect(screen.getByRole('region', { name: '此电脑' })).toHaveTextContent('连接被拒绝'))
  expect(screen.getByText('请从 Baton 下载最新的桌面客户端。')).toBeInTheDocument()
  await act(async () => f.desktop.publish({ ...registeredDesktop, state: 'rejected', message: 'Certificate expired.' }))
  expect(await screen.findByText('Certificate expired.')).toBeInTheDocument()
  view.unmount()
  expect(f.desktop.listeners.size).toBe(0)
})

it('reauthenticates the local idle-expired device using the current account API and bridge identity', async () => {
  const f = desktopPage(createDesktopBridge(registeredDesktop))
  const list = await f.client.listDevices()
  vi.spyOn(f.client, 'listDevices').mockResolvedValue(
    list.map((device) => (device.id === 'dev-mac' ? { ...device, credentialState: 'idle_expired' } : device)),
  )
  const create = vi.spyOn(f.client, 'createEnrollment')
  f.desktop.bridge.reauth.mockResolvedValue(registeredDesktop)
  f.show()
  await f.user.click(await screen.findByRole('button', { name: '重新连接此电脑' }))
  await f.user.click(await screen.findByRole('button', { name: '重新连接' }))
  await waitFor(() => expect(f.desktop.bridge.reauth).toHaveBeenCalledTimes(1))
  expect(create).toHaveBeenCalledWith('dev-mac')
  const issued = await create.mock.results[0]!.value
  expect(document.body).not.toHaveTextContent(issued.code)
  expect(f.desktop.bridge.enroll).not.toHaveBeenCalled()
})

it('opens local setup with an editable, empty device name', async () => {
  const f = desktopPage()
  f.show()
  await f.user.click(await screen.findByRole('button', { name: '连接此电脑' }))
  expect(await screen.findByRole('dialog', { name: '连接此电脑' })).toBeInTheDocument()
  expect(screen.getByLabelText('设备名称')).toHaveValue('')
  expect(screen.queryByLabelText('在终端运行')).not.toBeInTheDocument()
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
  await act(async () => finish({ registered: false, state: 'unregistered' }))
  await waitFor(() => expect(screen.getByRole('region', { name: '此电脑' })).toHaveTextContent('在线'))
  expect(screen.queryByRole('button', { name: '连接此电脑' })).not.toBeInTheDocument()
})
