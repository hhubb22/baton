import type { Thread, ThreadReport, ThreadStopCode } from '@baton/protocol'

/** 节点拒绝打开 Thread 时的回执代码对应的停止类别。 */
export function openRejectionStopCode(code: string | undefined): ThreadStopCode {
  return code === 'working_directory_missing' ? 'folder_missing' : 'start_failed'
}

export function reportStopCode(t: Thread, r: ThreadReport, confirmedStop = false): ThreadStopCode {
  if (r.history_unavailable) return 'history_lost'
  return (
    r.stop_code ??
    (confirmedStop || t.stop_confirmed_at ? 'user_stopped' : !t.opened_at ? 'start_failed' : 'interrupted')
  )
}
