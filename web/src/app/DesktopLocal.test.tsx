import { createMemoryHistory } from '@tanstack/react-router'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type { DesktopBridge, DesktopDiagnostics, DesktopStatus } from '../data/desktop'
import { createMockClient } from '../data/mock/client'
import { ClientProvider } from '../data/queries'
import { createDesktopBridge, registeredDesktop as desktopStatusFixture } from '../test/desktop'
import { App } from './App'
import { FolderDialog } from './FolderDialog'
import { LocalThreadActions } from './LocalThreadActions'
import { createAppRouter } from './router'

const registeredDesktop = desktopStatusFixture as Extract<DesktopStatus, { registered: true }>

const diagnostics: DesktopDiagnostics = {
  clientVersion: '0.1.0',
  batondVersion: '0.1.1',
  platform: 'darwin arm64',
  processState: 'stopped',
  lastExit: { at: '2026-10-27T14:32:00Z', reason: 'Unexpected exit · code 1' },
  upgradePhase: null,
  canRestart: true,
}

function localBridge(status: DesktopStatus = registeredDesktop) {
  const desktop = createDesktopBridge(status)
  const bridge = {
    ...desktop.bridge,
    capabilities: ['open-local', 'pick-directory', 'diagnostics'].map((name) => ({ name, version: 1 })),
    openLocal: vi.fn<NonNullable<DesktopBridge['openLocal']>>(async () => {}),
    pickDirectory: vi.fn<NonNullable<DesktopBridge['pickDirectory']>>(async () => null),
    diagnostics: vi.fn<NonNullable<DesktopBridge['diagnostics']>>(async () => diagnostics),
    restartDaemon: vi.fn<NonNullable<DesktopBridge['restartDaemon']>>(async () => {}),
    openLogs: vi.fn<NonNullable<DesktopBridge['openLogs']>>(async () => {}),
    copyDiagnostics: vi.fn<NonNullable<DesktopBridge['copyDiagnostics']>>(async () => {}),
  }
  vi.stubGlobal('batonDesktop', bridge)
  return { ...desktop, bridge }
}

function fixture(path = '/threads', desktop = localBridge()) {
  const client = createMockClient('normal', { latency: { read: 0, save: 0, device: 0, run: 8000 } })
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) })
  return {
    client,
    router,
    desktop,
    user: userEvent.setup(),
    show: () => render(<App client={client} router={router} />),
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('local thread actions', () => {
  it.each(['/threads/thr-webui', '/threads?thread=thr-webui', '/projects/prj-baton?thread=thr-webui'])(
    'opens a local thread by ID from %s',
    async (path) => {
      const f = fixture(path)
      f.show()
      const reveal = await screen.findByRole('button', { name: '在 Finder 中显示' })
      await f.user.click(reveal)
      await f.user.click(screen.getByRole('button', { name: '在编辑器中打开' }))
      expect(f.desktop.bridge.openLocal.mock.calls).toEqual([
        [{ threadId: 'thr-webui', action: 'reveal' }],
        [{ threadId: 'thr-webui', action: 'editor' }],
      ])
      f.desktop.bridge.openLocal.mockRejectedValueOnce(
        new Error("Error invoking remote method 'baton:open-local': Error: This folder no longer exists."),
      )
      await f.user.click(reveal)
      expect(await screen.findByRole('alert')).toHaveTextContent('This folder no longer exists.')
      expect(screen.getByRole('alert')).not.toHaveTextContent('Error invoking remote method')
    },
  )

  it.each(['remote', 'browser', 'old client', 'future capability', 'unregistered'])(
    'hides local actions for %s',
    async (mode) => {
      const desktop = localBridge()
      if (mode === 'browser') vi.stubGlobal('batonDesktop', undefined)
      if (mode === 'old client') desktop.bridge.capabilities = []
      if (mode === 'future capability') desktop.bridge.capabilities.forEach((capability) => (capability.version = 2))
      if (mode === 'unregistered') desktop.publish({ registered: false, state: 'unregistered' })
      const client = createMockClient('normal')
      render(
        <ClientProvider client={client}>
          <LocalThreadActions thread={{ id: 'thr-webui', deviceId: mode === 'remote' ? 'dev-ubuntu' : 'dev-mac' }} />
        </ClientProvider>,
      )
      if (mode !== 'browser') await waitFor(() => expect(desktop.bridge.status).toHaveBeenCalled())
      expect(screen.queryByRole('group', { name: '打开本地文件夹' })).not.toBeInTheDocument()
    },
  )

  it('uses the desktop system for Windows labels and removes actions when the local identity changes', async () => {
    const desktop = localBridge({ ...registeredDesktop, system: 'windows' })
    const client = createMockClient('normal')
    render(
      <ClientProvider client={client}>
        <LocalThreadActions thread={{ id: 'thr-webui', deviceId: 'dev-mac' }} />
      </ClientProvider>,
    )
    expect(await screen.findByRole('button', { name: '在文件资源管理器中显示' })).toBeInTheDocument()
    await act(async () => desktop.publish({ ...registeredDesktop, node_id: 'dev-windows' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '在编辑器中打开' })).not.toBeInTheDocument())
  })

  it('offers actions on local project thread rows, with no project directory or picker', async () => {
    const f = fixture('/projects/prj-baton', localBridge({ ...registeredDesktop, node_id: 'dev-ubuntu' }))
    f.show()
    const overview = await screen.findByRole('complementary', { name: '概览' })
    await within(overview).findByRole('button', { name: '在编辑器中打开' })
    const thread = within(overview).getByRole('button', { name: /Fix gateway reconnect race/ })
    const row = thread.parentElement!
    await f.user.click(await within(row).findByRole('button', { name: '在编辑器中打开' }))
    expect(f.desktop.bridge.openLocal).toHaveBeenCalledWith({ threadId: 'thr-gateway', action: 'editor' })
    expect(f.router.state.location.search.thread).toBeUndefined()
    expect(screen.queryByRole('button', { name: '选择本地文件夹…' })).not.toBeInTheDocument()
    await f.user.click(screen.getByRole('button', { name: '新建项目' }))
    const dialog = await screen.findByRole('dialog', { name: '新建项目' })
    expect(within(dialog).queryByLabelText('设备')).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: '选择本地文件夹…' })).not.toBeInTheDocument()
  })
})

describe('native folder selection', () => {
  it('leaves the choice on cancel and rejection, then validates a selected folder before using it', async () => {
    const f = fixture()
    const list = vi.spyOn(f.client, 'listFolders')
    const add = vi.spyOn(f.client, 'addDeviceFolder')
    f.show()
    const location = await screen.findByRole('button', { name: '文件夹：baton' })
    const pick = async () => {
      await f.user.click(location)
      await f.user.click(await screen.findByRole('menuitem', { name: '选择本地文件夹…' }))
    }
    await pick()
    await waitFor(() => expect(f.desktop.bridge.pickDirectory).toHaveBeenCalledWith({ nodeId: 'dev-mac' }))
    expect(location).toHaveAccessibleName('文件夹：baton')
    expect(list).not.toHaveBeenCalled()

    f.desktop.bridge.pickDirectory.mockResolvedValueOnce('/private')
    await pick()
    expect(await screen.findByText('所选文件夹不在此设备允许访问的范围内。')).toBeInTheDocument()
    expect(location).toHaveAccessibleName('文件夹：baton')
    expect(add).not.toHaveBeenCalled()

    f.desktop.bridge.pickDirectory.mockResolvedValueOnce('~/src/compat-suite')
    let finish!: (value: Awaited<ReturnType<typeof f.client.listFolders>>) => void
    list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await pick()
    await waitFor(() => expect(list).toHaveBeenLastCalledWith('dev-mac', '~/src/compat-suite'))
    expect(location).toHaveAccessibleName('文件夹：baton')
    await act(async () =>
      finish({
        state: 'ready',
        deviceId: 'dev-mac',
        path: '~/src/compat-suite',
        folders: [],
        files: [],
        scanLimited: false,
      }),
    )
    expect(await screen.findByRole('button', { name: '文件夹：compat-suite' })).toBeInTheDocument()
    expect(screen.queryByText('所选文件夹不在此设备允许访问的范围内。')).not.toBeInTheDocument()
    expect(add).not.toHaveBeenCalled()
  })

  it('only shows the native picker for the selected local device, including in the folder dialog', async () => {
    const desktop = localBridge()
    const client = createMockClient('normal', { latency: { read: 0, save: 0, device: 0, run: 8000 } })
    const selected = vi.fn()
    const user = userEvent.setup()
    render(
      <ClientProvider client={client}>
        <FolderDialog deviceId="dev-ubuntu" onSelect={selected} onClose={() => {}} />
      </ClientProvider>,
    )
    const dialog = await screen.findByRole('dialog', { name: '选择文件夹' })
    expect(within(dialog).queryByRole('button', { name: '选择本地文件夹…' })).not.toBeInTheDocument()
    await within(dialog).findByRole('option', { name: 'MacBook Pro' })
    await user.selectOptions(within(dialog).getByLabelText('设备'), 'dev-mac')
    desktop.bridge.pickDirectory.mockResolvedValueOnce('/outside')
    await user.click(await within(dialog).findByRole('button', { name: '选择本地文件夹…' }))
    expect(await within(dialog).findByText('所选文件夹不在此设备允许访问的范围内。')).toBeInTheDocument()
    expect(selected).not.toHaveBeenCalled()
    let finish!: (path: string | null) => void
    desktop.bridge.pickDirectory.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await user.click(within(dialog).getByRole('button', { name: '选择本地文件夹…' }))
    await user.selectOptions(within(dialog).getByLabelText('设备'), 'dev-ubuntu')
    await act(async () => finish('~/src/baton'))
    expect(selected).not.toHaveBeenCalled()
    expect(within(dialog).queryByRole('button', { name: '选择本地文件夹…' })).not.toBeInTheDocument()
  })

  it.each(['browser', 'old client', 'remote'])('keeps the location menu unchanged in %s', async (mode) => {
    const f = fixture(
      '/threads',
      localBridge(mode === 'remote' ? { ...registeredDesktop, node_id: 'dev-windows' } : registeredDesktop),
    )
    if (mode === 'browser') vi.stubGlobal('batonDesktop', undefined)
    if (mode === 'old client') f.desktop.bridge.capabilities = []
    f.show()
    await f.user.click(await screen.findByRole('button', { name: '文件夹：baton' }))
    await screen.findByRole('menuitem', { name: '选择其他文件夹…' })
    expect(screen.queryByRole('menuitem', { name: '选择本地文件夹…' })).not.toBeInTheDocument()
  })
})

describe('local device diagnostics', () => {
  it('shows local details, exit time and update phase, and invokes restart, logs and copy by device ID', async () => {
    const f = fixture('/devices?device=dev-mac')
    f.desktop.bridge.diagnostics.mockResolvedValue({ ...diagnostics, upgradePhase: 'migrating' })
    f.show()
    const section = await screen.findByRole('region', { name: '本机诊断' })
    expect(await within(section).findByText('Baton 0.1.0 · batond 0.1.1')).toBeInTheDocument()
    expect(section).toHaveTextContent('darwin arm64')
    expect(section).toHaveTextContent('Unexpected exit · code 1')
    expect(section.querySelector('time')).toHaveAttribute('datetime', diagnostics.lastExit!.at)
    expect(section).toHaveTextContent('正在升级')
    await f.user.click(within(section).getByRole('button', { name: '打开日志文件夹' }))
    await f.user.click(within(section).getByRole('button', { name: '复制诊断摘要' }))
    expect(await within(section).findByRole('button', { name: '诊断摘要已复制' })).toBeInTheDocument()
    await f.user.click(within(section).getByRole('button', { name: '重启设备服务' }))
    expect(f.desktop.bridge.restartDaemon).toHaveBeenCalledWith({ nodeId: 'dev-mac' })
    expect(f.desktop.bridge.openLogs).toHaveBeenCalledWith({ nodeId: 'dev-mac' })
    expect(f.desktop.bridge.copyDiagnostics).toHaveBeenCalledWith({ nodeId: 'dev-mac' })
    await waitFor(() => expect(f.desktop.bridge.diagnostics.mock.calls.length).toBeGreaterThan(1))
  })

  it('explains external service management and has no restart action', async () => {
    const f = fixture('/devices?device=dev-mac', localBridge({ ...registeredDesktop, state: 'external' }))
    f.desktop.bridge.diagnostics.mockResolvedValue({ ...diagnostics, processState: 'external', canRestart: false })
    f.show()
    const section = await screen.findByRole('region', { name: '本机诊断' })
    expect(await within(section).findByText('由外部服务管理')).toBeInTheDocument()
    expect(within(section).queryByRole('button', { name: '重启设备服务' })).not.toBeInTheDocument()
    expect(within(section).getByRole('button', { name: '打开日志文件夹' })).toBeInTheDocument()
    expect(within(section).getByRole('button', { name: '复制诊断摘要' })).toBeInTheDocument()
  })

  it('retries failed reads and displays action failures', async () => {
    const f = fixture('/devices?device=dev-mac')
    f.desktop.bridge.diagnostics.mockRejectedValueOnce(new Error('IPC unavailable'))
    f.desktop.bridge.openLogs.mockRejectedValueOnce(new Error('Could not open logs folder.'))
    f.show()
    const section = await screen.findByRole('region', { name: '本机诊断' })
    await within(section).findByText('无法读取诊断信息。')
    await f.user.click(within(section).getByRole('button', { name: '重试' }))
    await f.user.click(await within(section).findByRole('button', { name: '打开日志文件夹' }))
    expect(await within(section).findByRole('alert')).toHaveTextContent('Could not open logs folder.')
  })

  it.each(['browser', 'old client', 'remote'])('does not read diagnostics in %s', async (mode) => {
    const f = fixture(`/devices?device=${mode === 'remote' ? 'dev-ubuntu' : 'dev-mac'}`)
    if (mode === 'browser') vi.stubGlobal('batonDesktop', undefined)
    if (mode === 'old client') f.desktop.bridge.capabilities = []
    f.show()
    await screen.findByRole('button', { name: '断开设备' })
    expect(screen.queryByRole('region', { name: '本机诊断' })).not.toBeInTheDocument()
    expect(f.desktop.bridge.diagnostics).not.toHaveBeenCalled()
  })
})
