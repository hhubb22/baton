import type { ActivitySnapshot } from '@baton/protocol'
import { createMemoryHistory } from '@tanstack/react-router'
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { ClientError } from '../data/client'
import type { DesktopTarget } from '../data/desktop'
import { desktopActivity, notificationScope } from '../data/desktop-notifications'
import { createMockClient } from '../data/mock/client'
import { createDesktopBridge } from '../test/desktop'
import { App } from './App'
import { resolveDesktopTarget, viewedThread } from './DesktopWorkspace'
import { createAppRouter } from './router'

function fixture(path = '/threads', capabilities = ['notifications', 'tray-status'], snapshot?: ActivitySnapshot) {
  const client = createMockClient('normal')
  if (snapshot) client.getActivity = async () => snapshot
  const replay = vi.fn(async () => ({ events: [], cursor: '0', has_more: false }))
  client.replayNotifications = replay
  const targets = new Set<(target: DesktopTarget) => void>()
  const bridge = {
    ...createDesktopBridge().bridge,
    capabilities: capabilities.map((name) => ({ name, version: 1 })),
    notificationCursor: vi.fn(async () => '0'),
    deliverNotifications: vi.fn(async () => {}),
    viewingThread: vi.fn(async (_threadId: string | null) => {}),
    setActivity: vi.fn(async (_activity: ReturnType<typeof desktopActivity>) => {}),
    onOpenTarget: vi.fn((listener: (target: DesktopTarget) => void) => {
      targets.add(listener)
      return () => {
        targets.delete(listener)
      }
    }),
  }
  vi.stubGlobal('batonDesktop', bridge)
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) })
  const mounted = render(<App client={client} router={router} />)
  return {
    client,
    replay,
    bridge,
    router,
    ...mounted,
    open(target: DesktopTarget) {
      act(() => {
        for (const listener of targets) listener(target)
      })
    },
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('desktop workspace', () => {
  it('uses the complete server snapshot for questions on unopened threads', async () => {
    const f = fixture('/threads', ['tray-status'], {
      running_count: 8,
      waiting_count: 1,
      waiting_threads: [{ thread_id: 'unopened', title: 'x'.repeat(1000) }],
    })
    await waitFor(() =>
      expect(f.bridge.setActivity).toHaveBeenLastCalledWith({
        running: 8,
        waiting: 1,
        threads: [{ id: 'unopened', title: 'x'.repeat(512) }],
      }),
    )
  })

  it.each([{ capabilities: [] }, { capabilities: ['future-feature'] }, { capabilities: ['tray-status'] }])(
    'does not start notifications without that capability: %j',
    async ({ capabilities }) => {
      const f = fixture('/threads', capabilities)
      await screen.findByRole('link', { name: /Rebuild web UI foundation/ })
      expect(f.replay).not.toHaveBeenCalled()
      expect(f.bridge.viewingThread).not.toHaveBeenCalled()
      if (capabilities.includes('tray-status')) await waitFor(() => expect(f.bridge.setActivity).toHaveBeenCalled())
      else expect(f.bridge.setActivity).not.toHaveBeenCalled()
    },
  )

  it('reports the viewed thread from standalone, list and project routes, and clears native state on logout', async () => {
    const f = fixture('/threads/thr-webui')
    await waitFor(() => expect(f.bridge.viewingThread).toHaveBeenLastCalledWith('thr-webui'))
    await waitFor(() => expect(f.bridge.notificationCursor).toHaveBeenCalled())
    const session = await f.client.getSession()
    expect(f.bridge.notificationCursor).toHaveBeenCalledWith(notificationScope(location.origin, session.account!.id))
    const expected = desktopActivity(await f.client.listThreads(), await f.client.listInbox())
    await waitFor(() => expect(f.bridge.setActivity).toHaveBeenLastCalledWith(expected))
    await act(() => f.router.navigate({ to: '/threads', search: { thread: 'thr-fix' } }))
    await waitFor(() => expect(f.bridge.viewingThread).toHaveBeenLastCalledWith('thr-fix'))
    await act(() =>
      f.router.navigate({
        to: '/projects/$projectId',
        params: { projectId: 'proj-baton' },
        search: { thread: 'thr-webui' },
      }),
    )
    await waitFor(() => expect(f.bridge.viewingThread).toHaveBeenLastCalledWith('thr-webui'))
    await act(() => f.router.navigate({ to: '/inbox' }))
    await waitFor(() => expect(f.bridge.viewingThread).toHaveBeenLastCalledWith(null))
    await act(() => f.client.signOut())
    await waitFor(() => expect(f.router.state.location.pathname).toBe('/login'))
    expect(f.bridge.viewingThread).toHaveBeenLastCalledWith(null)
    expect(f.bridge.setActivity).toHaveBeenLastCalledWith({ running: 0, waiting: 0, threads: [] })
  })

  it('opens a project thread in its project and opens a device detail from native targets', async () => {
    const f = fixture()
    await waitFor(() => expect(f.bridge.onOpenTarget).toHaveBeenCalled())
    const thread = (await f.client.listThreads()).find((item) => item.projectId !== null && item.status !== 'archived')!
    f.open({ thread_id: thread.id, project_id: thread.projectId! })
    await waitFor(() => expect(f.router.state.location.pathname).toBe(`/projects/${thread.projectId}`))
    expect(f.router.state.location.search).toEqual({ thread: thread.id })
    const device = (await f.client.listDevices())[0]!
    f.open({ node_id: device.id })
    await waitFor(() => expect(f.router.state.location.pathname).toBe('/devices'))
    expect(f.router.state.location.search).toEqual({ device: device.id })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: new RegExp(device.name) })).toHaveAttribute('aria-expanded', 'true'),
    )
  })

  it('opens lists and shows the designed reason for deleted or archived targets', async () => {
    const f = fixture()
    await waitFor(() => expect(f.bridge.onOpenTarget).toHaveBeenCalled())
    f.open({ thread_id: 'deleted' })
    expect(await screen.findByText('对话已删除。')).toBeInTheDocument()
    expect(f.router.state.location.pathname).toBe('/threads')
    const read = f.client.getProject.bind(f.client)
    f.client.getProject = async (id) => ({ ...(await read(id)), status: 'archived' })
    const project = (await f.client.listProjects())[0]!
    f.open({ project_id: project.id })
    expect(await screen.findByText('项目已归档。')).toBeInTheDocument()
    expect(f.router.state.location.pathname).toBe('/projects/archived')
    await act(() => f.router.navigate({ to: '/threads' }))
    expect(screen.queryByText('项目已归档。')).not.toBeInTheDocument()
  })
})

it('resolves deleted and archived threads without navigating to unavailable details', async () => {
  const client = createMockClient('normal')
  const thread = (await client.listThreads())[0]!
  const read = client.getThread.bind(client)
  client.getThread = async (id) => ({ ...(await read(id)), status: 'archived' })
  expect(await resolveDesktopTarget(client, { thread_id: thread.id })).toEqual({
    kind: 'threads',
    notice: '对话已归档。',
  })
  expect(await resolveDesktopTarget(client, { project_id: 'deleted' })).toEqual({
    kind: 'projects',
    notice: '项目已删除。',
  })
  client.getThread = async () => {
    throw new ClientError('unavailable', 'offline')
  }
  await expect(resolveDesktopTarget(client, { thread_id: thread.id })).rejects.toMatchObject({ code: 'unavailable' })
  expect(viewedThread('/inbox', { thread: thread.id })).toBeNull()
  expect(viewedThread('/devices', { thread: thread.id })).toBeNull()
})
