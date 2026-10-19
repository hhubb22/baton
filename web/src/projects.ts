import { request } from './api.ts'

export type Project = {
  id: string; title: string; goal: string; status: string; version: number
  agent: { id: string; provider: string; model: string }
  conversation: { id: string; state: string; last_seq: number }
}
export type ProjectEvent = { seq: number; kind: string; created_at: string; payload: unknown }
export type ProjectMemory = { id: string; title: string; content: string; revision: number; author: string; updated_at: string }
export type ProjectMessage = { id: number; client_message_id: string; content: string; created_at: string }
export type ProjectStatus = {
  state: string; waiting_reason?: string; pending_inputs: number; last_error?: string; next_attempt_at?: string; last_seq: number
  run?: { id: string; node_id: string; node_name: string; state: string; effective: boolean; placement_reason: string; end_reason?: string; stop_acked_at?: string }
  preview?: { after_seq: number; text: string; truncated: boolean }
}
export type EventPage = { events: ProjectEvent[]; next_after_seq: number; has_more: boolean }
export const projectAPI = (id: string) => `/api/v1/projects/${encodeURIComponent(id)}`
export const projectURL = (id: string) => `/projects/${encodeURIComponent(id)}`
export const getProject = (id: string) => request<Project>(projectAPI(id))
export const getProjectStatus = (id: string) => request<ProjectStatus>(`${projectAPI(id)}/status`)
export const getProjectEvents = (id: string, after: number) => request<EventPage>(`${projectAPI(id)}/events?after_seq=${after}&limit=100`)
export const waitingReasons: Record<string, string> = {
  all_devices_offline: '正在等待设备：所有设备离线。', waiting_sync: '正在等待设备完成同步。', runtime_missing: '正在等待安装 Project Agent Runtime 的设备。',
  login_required: '正在等待设备上的模型订阅登录。', capacity: '正在等待设备空出运行名额。', scheduling: '正在等待设备启动运行。',
  model_not_configured: '请先填写模型订阅和模型。', retry_backoff: '模型请求失败，正在等待自动重试。',
}
export const projectStates: Record<string, string> = { idle: '空闲', waiting: '等待中', starting: '正在启动 Project Agent', running: 'Project Agent 正在运行', needs_attention: '需要处理', paused: 'Project 已暂停', archived: 'Project 已归档' }
export const placementReasons: Record<string, string> = { default_device: '使用默认设备', default_not_set: '未设置默认设备，使用可用设备', default_unavailable: '默认设备不可用，使用其他设备', default_offline: '默认设备离线，使用其他设备', default_runtime_missing: '默认设备缺少 Runtime，使用其他设备', default_login_required: '默认设备需要登录，使用其他设备', default_capacity: '默认设备名额已满，使用其他设备', default_revoked: '默认设备已吊销，使用其他设备' }

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
export type ConversationItem = { label: string; text: string; attentionCallID?: string }
// 输入事件的文本封装了队列条目；浏览器只提取正文，未知结构保留为文本。
export function conversationItems(event: ProjectEvent): ConversationItem[] {
  const payload = record(event.payload)
  const message = record(payload.message)
  const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : Array.isArray(message.content) ? message.content : []
  if (event.kind === 'input') {
    const items: ConversationItem[] = []
    for (const block of blocks) {
      const text = record(block).text
      if (typeof text !== 'string') continue
      try {
        const inputs: unknown = JSON.parse(text)
        if (!Array.isArray(inputs)) throw new Error('invalid_inputs')
        for (const input of inputs) {
          const value = record(input), body = record(value.payload)
          items.push({ label: value.source_type === 'user_message' ? '你' : value.source_type === 'task_result' ? '任务结果' : '项目通知', text: typeof body.content === 'string' ? body.content : JSON.stringify(body, null, 2) })
        }
      } catch { items.push({ label: '输入', text }) }
    }
    if (items.length) return items
  }
  const label = event.kind === 'assistant' ? 'Project Agent' : event.kind === 'tool_result' ? '工具结果' : '对话记录'
  const items = blocks.flatMap((value) => {
    const block = record(value)
    if (block.type === 'text' && typeof block.text === 'string') return [{ label, text: block.text }]
    if (block.type === 'toolCall') return [{ label: '工具调用', text: `${String(block.name ?? '')}\n${JSON.stringify(block.arguments, null, 2)}`, ...(block.name === 'inbox.ask' && typeof block.id === 'string' ? { attentionCallID: block.id } : {}) }]
    return []
  })
  return items.length ? items : [{ label, text: JSON.stringify(event.payload, null, 2) }]
}

const messageKey = (employee: string, project: string) => `baton_project_message:${employee}:${project}`
export function pendingMessageID(employee: string, project: string): string {
  try { return sessionStorage.getItem(messageKey(employee, project)) ?? '' } catch { return '' }
}
export function saveMessageID(employee: string, project: string, id: string) {
  if (id) sessionStorage.setItem(messageKey(employee, project), id)
  else sessionStorage.removeItem(messageKey(employee, project))
}
