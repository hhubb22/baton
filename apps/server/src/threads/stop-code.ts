import type { Thread, ThreadReport, ThreadStopCode } from '@baton/protocol'

// 已发布 Worker 的报告只有原因文本；新报告优先使用 stop_code。
export function legacyStopCode(reason: string): ThreadStopCode | undefined {
  if (
    /history_missing|history_lost|native Agent history missing|对话记录.*(丢失|不存在)|历史.*(丢失|找不到)/i.test(
      reason,
    )
  )
    return 'history_lost'
  if (/folder_missing|working_directory_missing|目录.*(不存在|找不到)|找不到.*目录/i.test(reason))
    return 'folder_missing'
  if (/forced|没有在 1 分钟内停下/i.test(reason)) return 'forced_stop'
  return undefined
}

export function reportStopCode(t: Thread, r: ThreadReport, confirmedStop = false): ThreadStopCode {
  if (r.history_unavailable) return 'history_lost'
  return (
    r.stop_code ??
    legacyStopCode(r.reason ?? '') ??
    (confirmedStop || t.stop_confirmed_at ? 'user_stopped' : !t.opened_at ? 'start_failed' : 'interrupted')
  )
}
