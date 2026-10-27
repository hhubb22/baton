import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Schema } from 'effect'

export const NotificationTarget = Schema.Struct({
  thread_id: Schema.optionalKey(Schema.String),
  project_id: Schema.optionalKey(Schema.String),
  node_id: Schema.optionalKey(Schema.String),
})
export type NotificationTarget = typeof NotificationTarget.Type

const SavedNotifications = Schema.Struct({
  enabled: Schema.Boolean,
  scopes: Schema.Record(
    Schema.String,
    Schema.Struct({ cursor: Schema.NullOr(Schema.String), seen: Schema.Array(Schema.String) }),
  ),
})
type SavedNotifications = typeof SavedNotifications.Type

export interface NativeNotice {
  event_id: string
  title: string
  body: string
  thread_id?: string
  project_id?: string
  node_id?: string
}

export interface NativeNotification {
  on(event: 'click' | 'close' | 'failed', listener: () => void): unknown
  show(): void
}

export function notificationPresenter(
  create: (notice: NativeNotice) => NativeNotification | null,
  open: (target: NotificationTarget) => void,
) {
  const active = new Set<NativeNotification>()
  return (notice: NativeNotice) => {
    const notification = create(notice)
    if (!notification) return
    active.add(notification)
    notification.on('click', () =>
      open({
        ...(notice.thread_id ? { thread_id: notice.thread_id } : {}),
        ...(notice.project_id ? { project_id: notice.project_id } : {}),
        ...(notice.node_id ? { node_id: notice.node_id } : {}),
      }),
    )
    notification.on('close', () => active.delete(notification))
    notification.on('failed', () => active.delete(notification))
    notification.show()
  }
}

export interface Activity {
  running: number
  waiting: number
  threads: readonly { id: string; title: string }[]
}
export const emptyActivity: Activity = { running: 0, waiting: 0, threads: [] }

export async function notificationState(directory: string, present: (notice: NativeNotice) => void) {
  const file = join(directory, 'notifications.json')
  let saved: SavedNotifications = { enabled: true, scopes: {} }
  try {
    saved = Schema.decodeUnknownSync(SavedNotifications)(JSON.parse(await readFile(file, 'utf8')))
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  let serial: Promise<unknown> = Promise.resolve()
  const update = <A>(task: () => Promise<A>): Promise<A> => {
    const next = serial.then(task)
    serial = next.catch(() => {})
    return next
  }
  const persist = async (next: SavedNotifications) => {
    await writeFile(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 })
    await rename(`${file}.tmp`, file)
    saved = next
  }
  return {
    enabled: () => saved.enabled,
    setEnabled: (enabled: boolean) => update(() => persist({ ...saved, enabled })),
    cursor: async (scope: string) => {
      await serial
      return saved.scopes[scope]?.cursor ?? null
    },
    deliver: (
      scope: string,
      notices: readonly NativeNotice[],
      cursor: string | null,
      visibleThread: string | null | (() => string | null),
    ) =>
      update(async () => {
        const previous = saved.scopes[scope] ?? { cursor: null, seen: [] }
        const seen = new Set(previous.seen)
        const fresh = notices.filter((notice) => {
          if (seen.has(notice.event_id)) return false
          seen.add(notice.event_id)
          return true
        })
        if (fresh.length === 0 && previous.cursor === cursor) return
        // 先保存已消费的事件，窗口重载或进程重启不会重复弹出。
        await persist({ ...saved, scopes: { ...saved.scopes, [scope]: { cursor, seen: [...seen] } } })
        if (!saved.enabled) return
        const focusedThread = typeof visibleThread === 'function' ? visibleThread() : visibleThread
        for (const notice of fresh) if (!notice.thread_id || notice.thread_id !== focusedThread) present(notice)
      }),
  }
}
