import { request } from './api.ts'

export type ResultRef = { node_id?: string; storage_ref?: string; resource_id: string; access_status: string; note?: string }
export type TaskRecord = {
  project_id?: string; origin_conversation_id?: string; task_id: string; request_id: string; description: string; target_node_id: string; agent_type: string
  status: string; version: number; accepted_at: string; updated_at?: string; queue_expires_at: string; execution_timeout_seconds: number
  delivery_status?: string; delivery_updated_at?: string; source_session_id?: string | null; parent_task_id?: string | null
  target_session_id?: string | null; rerun_of_task_id?: string; working_directory?: string | null; device_names: string[]
  authorization_scope?: string | null; expected_outputs?: string | null; execution_expires_at?: string
  cancel_requested_at?: string; stop_requested_at?: string; stop_acknowledged_at?: string; stop_confirmed_at?: string; stop_outcome_known: boolean
  summary?: string; error_code?: string; error_message?: string; evidence?: ResultRef[]; artifacts?: ResultRef[]
  evidence_empty_reason?: string; artifacts_empty_reason?: string
}
export type TaskEvent = {
  event_id: string; kind: string; version: number; status: string; created_at: string; actor_employee_id: string; reason_code?: string
  resolution?: { status: string; summary: string; reason: string; evidence: ResultRef[]; evidence_empty_reason?: string; previous: TaskRecord }
  rerun?: { task_id: string; reason: string; previous_status: string }
}
export type TaskPage = { tasks: TaskRecord[]; next_cursor?: string }
export type TaskInput = {
  request_id: string; description: string; target_node_id?: string; agent_type?: string; target_session_id?: string
  working_directory?: string; device_names?: string[]; authorization_scope?: string; expected_outputs?: string
  queue_timeout_seconds: number; execution_timeout_seconds: number
}
export type RerunInput = { request_id: string; expected_version: number; reason: string; confirm_side_effects: boolean }
export type ResolveInput = { expected_version: number; status: string; summary: string; reason: string; evidence: ResultRef[]; evidence_empty_reason?: string }
export const taskStates: Record<string, string> = { queued: '待执行（已接受，尚未确认启动）', running: '执行中', needs_verification: '待核实', completed: '完成', failed: '失败', cancelled: '取消' }
export const taskEventLabels: Record<string, string> = { accepted: '中心已接受', prepared: '节点已准备', start_authorized: '已签发启动许可', started: '节点已确认启动', result: '结果已保存', failed: '执行失败', needs_verification: '转为待核实', cancelled: '已取消', cancel_requested: '已请求取消', stop_requested: '已请求中止', stop_report: '节点报告停止情况', resolved: '人工核实', rerun_requested: '已发起新执行' }
export const deliveryStates: Record<string, string> = { not_ready: '等待结果', stored: '结果已保存在中心', pending: '等待交回来源 Session', available: '来源节点已收到，等待交付 Session', delivered: '已交付来源 Session', uncertain: '交付待核实', source_stopped: '来源 Session 已停止，结果保存在中心' }
export const manualAllowed = (task: TaskRecord) => ['needs_verification', 'completed', 'failed', 'cancelled'].includes(task.status)
export const taskURL = (id: string) => `/tasks/${encodeURIComponent(id)}`
export const taskAPI = (id: string) => `/api/v1/tasks/${encodeURIComponent(id)}`
export const getTask = (id: string) => request<TaskRecord>(taskAPI(id))
export const getTaskEvents = (id: string) => request<{ events: TaskEvent[] }>(`${taskAPI(id)}/events`)
export function listTasks(filter: Record<string, string> = {}) {
  const query = new URLSearchParams(filter).toString()
  return request<TaskPage>(`/api/v1/tasks${query ? `?${query}` : ''}`)
}
export function previewQuery(ref: ResultRef): { root_id: string; path: string } | null {
  if (!ref.node_id || !ref.storage_ref?.startsWith('root:') || !ref.storage_ref.slice(5)) return null
  return { root_id: ref.storage_ref.slice(5), path: ref.resource_id }
}
export const timeLabel = (value?: string | null) => value ? new Date(value).toLocaleString('zh-CN') : '暂无记录'

// 标签页只保存操作标识；任务说明、授权文本和证据不写入浏览器存储。
export type PendingTask = { requestID: string; originalTaskID?: string }
const pendingKey = (employee: string) => `baton_pending_task:${employee}`
export function readPendingTask(employee: string): PendingTask | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(pendingKey(employee)) ?? 'null') as PendingTask | null
    if (!value || typeof value.requestID !== 'string' || (value.originalTaskID !== undefined && typeof value.originalTaskID !== 'string')) return null
    return { requestID: value.requestID, originalTaskID: value.originalTaskID }
  } catch { return null }
}
export function savePendingTask(employee: string, value: PendingTask | null) {
  if (value) sessionStorage.setItem(pendingKey(employee), JSON.stringify(value))
  else sessionStorage.removeItem(pendingKey(employee))
}

export function clearPendingTask(employee: string, requestID: string): boolean {
  if (readPendingTask(employee)?.requestID !== requestID) return false
  savePendingTask(employee, null)
  return true
}
