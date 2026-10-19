import { useCallback, useEffect, useState } from 'react'
import { messageOf, request } from './api.ts'
import type { TaskRecord } from './tasks.ts'

export type TaskResult = Pick<TaskRecord, 'task_id' | 'target_node_id' | 'status' | 'version' | 'summary' | 'error_code' | 'error_message' | 'evidence' | 'artifacts' | 'evidence_empty_reason' | 'artifacts_empty_reason'>
export type AttentionRequest = {
  id: string; project_id: string; project_title: string; conversation_id: string; origin_tool_call_id?: string
  source: 'agent' | 'system'; title: string; summary: string; content: string; task_id?: string
  options: { id: string; label: string; description?: string; recommended?: boolean }[]; allow_text: boolean
  state: string; version: number; action_url?: string; created_at: string; updated_at: string; resolved_at?: string
  withdraw_reason?: string; resolution?: { employee_id: string; option_id?: string; option_label?: string; text?: string; client_request_id: string }
  task_result_version?: number; task_result?: TaskResult; latest_task_result_version?: number; latest_task_result_updated_at?: string
}
export type InboxPage = { requests: AttentionRequest[]; open_count: number; next_cursor?: string }
export type AskProject = (id: string, text: string) => void
export const attentionStates: Record<string, string> = { open: '待处理', answered: '已回答', closed: '已关闭', withdrawn: '已撤回', resolved: '已解决' }
export const attentionURL = (id: string) => `/inbox/${encodeURIComponent(id)}`
export const attentionAPI = (id: string) => `/api/v1/attention-requests/${encodeURIComponent(id)}`
export const getAttention = (id: string) => request<AttentionRequest>(attentionAPI(id))
export const listInbox = (state = 'open', filter: Record<string, string> = {}, cursor = '') => request<InboxPage>(`/api/v1/inbox?${new URLSearchParams({ state, ...filter, ...(cursor ? { cursor } : {}) })}`)
export const attentionChanged = () => window.dispatchEvent(new Event('baton-attention-changed'))

// 相关事项读取全部分页；Inbox 两栏只重读用户已展开的页数。
export function useAttentionList(state: string, filter: Record<string, string> = {}, pages = 1) {
  const [value, setValue] = useState<InboxPage>({ requests: [], open_count: 0 })
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const query = new URLSearchParams(filter).toString()
  const refresh = useCallback(() => setRevision((v) => v + 1), [])
  useEffect(() => {
    let stopped = false, loading = false
    const load = async () => {
      if (loading) return
      loading = true
      try {
        let cursor = '', count = 0
        const items: AttentionRequest[] = []
        let page: InboxPage
        do {
          page = await listInbox(state, Object.fromEntries(new URLSearchParams(query)), cursor)
          items.push(...page.requests); cursor = page.next_cursor ?? ''; count++
        } while (cursor && count < pages && !stopped)
        if (!stopped) { setValue({ ...page!, requests: items }); setError('') }
      } catch (err) { if (!stopped) setError(`${messageOf(err)}。请重新查询事项。`) }
      finally { loading = false }
    }
    void load()
    const timer = window.setInterval(() => void load(), 5000)
    window.addEventListener('baton-attention-changed', refresh)
    window.addEventListener('focus', refresh)
    return () => { stopped = true; window.clearInterval(timer); window.removeEventListener('baton-attention-changed', refresh); window.removeEventListener('focus', refresh) }
  }, [state, query, pages, revision, refresh])
  return { ...value, error, refresh }
}
