import type { ActivitySnapshot } from '@baton/protocol'
import type { BatonClient } from './client'
import type { DesktopActivity, DesktopBridge } from './desktop'
import type { Project, Thread } from './types'

// 托盘复用网页数据，不按当前页面的设备或 Project 筛选。
export function desktopActivity(threads: Thread[], projects: Project[]): DesktopActivity {
  const active = threads.filter((thread) => thread.status !== 'archived')
  const waitingIds = new Set<string>()
  for (const thread of active) {
    if (thread.pendingQuestions?.length) waitingIds.add(thread.id)
  }
  return {
    running: active.filter((thread) => thread.status === 'running').length,
    waiting:
      active.filter((thread) => waitingIds.has(thread.id)).length +
      projects.filter((project) => project.status !== 'archived' && project.latestReplySeq > project.readReplySeq)
        .length,
    threads: active
      .filter((thread) => waitingIds.has(thread.id))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      .slice(0, 5)
      .map(({ id, title }) => ({ id, title: title.slice(0, 512) })),
  }
}

export function desktopActivitySnapshot(snapshot: ActivitySnapshot): DesktopActivity {
  return {
    running: snapshot.running_count,
    waiting: snapshot.waiting_count,
    threads: snapshot.waiting_threads.slice(0, 5).map((thread) => ({
      id: thread.thread_id,
      title: thread.title.slice(0, 512),
    })),
  }
}

export function notificationScope(origin: string, employeeId: string) {
  return JSON.stringify([origin, employeeId])
}

// WebSocket 只触发重放；游标在原生端确认接收整页后才推进。
export function relayDesktopNotifications(
  client: BatonClient,
  bridge: DesktopBridge,
  scope: string,
  onError: (error: unknown) => void,
) {
  let stopped = false
  let running = false
  let dirty = false
  let initialized = false
  let cursor: string | null = null
  const replay = client.replayNotifications?.bind(client)
  const readCursor = bridge.notificationCursor?.bind(bridge)
  const deliver = bridge.deliverNotifications?.bind(bridge)
  if (!replay || !readCursor || !deliver) return () => {}

  async function drain() {
    if (running || stopped) return
    running = true
    try {
      if (!initialized) {
        cursor = await readCursor!(scope)
        initialized = true
      }
      while (dirty && !stopped) {
        dirty = false
        const page = await replay!(cursor ?? undefined)
        if (stopped) return
        await deliver!({ scope, events: page.events, cursor: page.cursor })
        if (stopped) return
        if (page.has_more && page.cursor === cursor) throw new Error('Notification replay cursor did not advance')
        cursor = page.cursor
        dirty ||= page.has_more
      }
    } catch (error) {
      if (!stopped) onError(error)
    } finally {
      running = false
    }
  }

  function refresh() {
    dirty = true
    void drain()
  }
  // 普通数据刷新也重试，覆盖断线及本机暂时无法保存游标的情况。
  const unsubscribe = client.subscribe(refresh)
  refresh()
  return () => {
    stopped = true
    unsubscribe()
  }
}
