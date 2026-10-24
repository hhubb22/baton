import type { Message } from '@earendil-works/pi-ai'
export interface Event {
  seq: number
  kind: 'input' | 'assistant' | 'tool_result' | 'compaction'
  payload: any
}
export interface Bootstrap {
  project: {
    title: string
    goal: string
    agent: { provider: string; model: string }
    conversation: { id: string }
  }
  prompt_version: string
  memory_index?: string
  compaction?: Event
  compaction_seq?: number
  goal_utf8_base64?: string
  local_wait_protocol?: number
  after_seq: number
  last_seq: number
}
export interface Request {
  operation: string
  last_seq?: number
  after_seq?: number
  max_bytes?: number
  client_event_id?: string
  payload?: unknown
  reason?: string
  tool_call_id?: string
  tool_name?: string
  arguments?: unknown
}
export interface RPC {
  call(request: Request): Promise<any>
}
export class RuntimeError extends Error {
  constructor(public code: string) {
    super(code)
  }
}
export function checkedRPC(call: (request: Request) => Promise<any>): RPC {
  return {
    async call(request) {
      const result = await call(request)
      if (
        !result ||
        typeof result !== 'object' ||
        result.type !== 'project_runtime.result' ||
        typeof result.ok !== 'boolean' ||
        (result.code !== undefined && typeof result.code !== 'string') ||
        !result.ok
      )
        throw new RuntimeError(result?.code ?? 'invalid_response')
      return result.data
    },
  }
}

// jsonb 会调整对象键顺序；递归排序保留消息的全部字段和数组顺序。
export function canonical<T>(value: T): T {
  if (Array.isArray(value)) return value.map(canonical) as T
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    ) as T
  return value
}
export function eventMessage(event: Event): Message {
  if (event.payload.format !== 'pi-ai/1' || !event.payload.message) throw new RuntimeError('unsupported_event')
  return canonical(event.payload.message)
}
