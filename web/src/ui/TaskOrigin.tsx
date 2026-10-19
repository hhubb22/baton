import type { TaskRecord } from '../tasks.ts'
export function TaskOrigin({ task }: { task: TaskRecord }) {
  return <p>{task.origin_conversation_id ? '由 Project Agent 发起' : task.source_session_id ? '由执行 Agent 发起' : '由用户发起'}</p>
}
