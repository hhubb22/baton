import { useLocation, useRouter } from '@tanstack/react-router'
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ClientError, type BatonClient } from '../data/client'
import { desktopCapability, type DesktopTarget } from '../data/desktop'
import {
  desktopActivity,
  desktopActivitySnapshot,
  notificationScope,
  relayDesktopNotifications,
} from '../data/desktop-notifications'
import { useActivity, useClient, useInbox, useSession, useThreads } from '../data/queries'
import { Banner } from '../ui/Banner'

const TargetNotice = createContext<string | null>(null)

export function DesktopTargetNotice() {
  const notice = useContext(TargetNotice)
  return notice ? <Banner icon="alert" title={notice} /> : null
}

export function viewedThread(pathname: string, search: Record<string, unknown>): string | null {
  const standalone = /^\/threads\/([^/]+)\/?$/.exec(pathname)
  if (standalone) return decodeURIComponent(standalone[1]!)
  if (pathname === '/threads' || /^\/projects\/[^/]+\/?$/.test(pathname)) {
    return typeof search.thread === 'string' ? search.thread : null
  }
  return null
}

type DesktopDestination =
  | { kind: 'thread'; id: string }
  | { kind: 'project'; id: string; threadId?: string }
  | { kind: 'threads' | 'projects'; notice: string }
  | { kind: 'devices'; id?: string }

export async function resolveDesktopTarget(client: BatonClient, target: DesktopTarget): Promise<DesktopDestination> {
  if (target.thread_id) {
    try {
      const thread = await client.getThread(target.thread_id)
      if (thread.status === 'archived') return { kind: 'threads' as const, notice: '对话已归档。' }
      if (thread.projectId) {
        const project = await client.getProject(thread.projectId)
        if (project.status === 'archived') return { kind: 'projects' as const, notice: '项目已归档。' }
        return { kind: 'project' as const, id: project.id, threadId: thread.id }
      }
      return { kind: 'thread' as const, id: thread.id }
    } catch (error) {
      if (error instanceof ClientError && error.code === 'notFound')
        return { kind: 'threads' as const, notice: '对话已删除。' }
      throw error
    }
  }
  if (target.project_id) {
    try {
      const project = await client.getProject(target.project_id)
      if (project.status === 'archived') return { kind: 'projects' as const, notice: '项目已归档。' }
      return { kind: 'project' as const, id: project.id }
    } catch (error) {
      if (error instanceof ClientError && error.code === 'notFound')
        return { kind: 'projects' as const, notice: '项目已删除。' }
      throw error
    }
  }
  return { kind: 'devices' as const, id: target.node_id }
}

function Notifications({ employeeId }: { employeeId: string }) {
  const client = useClient()
  const location = useLocation()
  const bridge = desktopCapability('notifications')!
  const thread = viewedThread(location.pathname, location.search)
  useEffect(() => {
    void bridge.viewingThread?.(thread).catch(() => {})
    return () => {
      void bridge.viewingThread?.(null).catch(() => {})
    }
  }, [bridge, thread])
  useEffect(
    () =>
      relayDesktopNotifications(client, bridge, notificationScope(window.location.origin, employeeId), () => {
        console.warn('Desktop notification delivery will retry on the next refresh.')
      }),
    [client, bridge, employeeId],
  )
  return null
}

function TrayActivity() {
  const client = useClient()
  const bridge = desktopCapability('tray-status')!
  const snapshot = useActivity()
  const threads = useThreads()
  const inbox = useInbox()
  const activity = useMemo(
    () =>
      snapshot.data
        ? desktopActivitySnapshot(snapshot.data)
        : client.getActivity
          ? { running: 0, waiting: 0, threads: [] }
          : desktopActivity(threads.data ?? [], inbox.data ?? []),
    [client, snapshot.data, threads.data, inbox.data],
  )
  useEffect(() => {
    void bridge.setActivity?.(activity).catch(() => {})
  }, [bridge, activity])
  useEffect(
    () => () => {
      void bridge.setActivity?.({ running: 0, waiting: 0, threads: [] }).catch(() => {})
    },
    [bridge],
  )
  return null
}

export function DesktopWorkspace({ children }: { children: ReactNode }) {
  const client = useClient()
  const session = useSession()
  const router = useRouter()
  const location = useLocation()
  const [notice, setNotice] = useState<{ href: string; message: string } | null>(null)
  const requestId = useRef(0)
  const notifications = desktopCapability('notifications')
  const tray = desktopCapability('tray-status')
  const bridge = notifications ?? tray
  const employeeId = session.data?.account?.id

  useEffect(() => {
    if (!bridge?.onOpenTarget || !employeeId) return
    let disposed = false
    const unsubscribe = bridge.onOpenTarget((target) => {
      const currentRequest = ++requestId.current
      void resolveDesktopTarget(client, target)
        .then(async (destination) => {
          if (disposed || currentRequest !== requestId.current) return
          setNotice(null)
          switch (destination.kind) {
            case 'thread':
              await router.navigate({ to: '/threads', search: { thread: destination.id } })
              break
            case 'project':
              await router.navigate({
                to: '/projects/$projectId',
                params: { projectId: destination.id },
                search: { thread: destination.threadId },
              })
              break
            case 'threads':
              await router.navigate({ to: '/threads', search: {} })
              break
            case 'projects':
              await router.navigate({ to: '/projects/archived' })
              break
            case 'devices':
              await router.navigate({ to: '/devices', search: { device: destination.id } })
              break
          }
          if (!disposed && currentRequest === requestId.current && 'notice' in destination)
            setNotice({ href: router.state.location.href, message: destination.notice })
        })
        .catch(() => {
          if (!disposed && currentRequest === requestId.current)
            setNotice({ href: router.state.location.href, message: '无法打开通知，请重试。' })
        })
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [bridge, client, router, employeeId])

  return (
    <TargetNotice value={notice?.href === location.href ? notice.message : null}>
      {employeeId && notifications && <Notifications employeeId={employeeId} />}
      {employeeId && tray && <TrayActivity />}
      {children}
    </TargetNotice>
  )
}
