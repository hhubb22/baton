import type { FullOutputReference } from '../types'
import { apiPath, type HttpContext } from './context'
import { createTransport } from './transport'

export interface FullOutputPage {
  output_id: string
  storage_generation: string
  offset: number
  next_offset: number
  total_bytes: number
  expires_at: string
  encoding: 'base64'
  data: string
  done: boolean
}
interface OutputResponse {
  ok: boolean
  session_id: string
  code?: string
  cursor?: string
  full_output?: FullOutputPage
}
const messages: Record<string, string> = {
  node_offline: '设备已离线，请连接设备以读取完整输出。',
  node_syncing: '设备正在重新连接，请稍后重试。',
  output_missing: '完整输出已不在此设备上。',
  output_expired: '此输出已超过保留期限。',
  output_identity_mismatch: '此输出不属于这条回复。',
  output_changed: '保存的输出已更改，请从头读取。',
}

export function createFullOutputReader(request: HttpContext['request'], execution = false) {
  return async (threadId: string, reference: FullOutputReference, cursor = '0', signal?: AbortSignal) => {
    const query = new URLSearchParams({
      output_id: reference.id,
      storage_generation: reference.storage_generation,
    })
    if (execution) query.set('offset', cursor)
    else {
      query.set('action', 'full_output')
      query.set('cursor', cursor)
    }
    const response = await request<OutputResponse | FullOutputPage>(
      `/${execution ? 'executions' : 'threads'}/${apiPath(threadId)}/output?${query}`,
      { signal },
    )
    const result = execution
      ? {
          ok: true,
          session_id: threadId,
          full_output: response as FullOutputPage,
          cursor: String((response as FullOutputPage).next_offset),
        }
      : (response as OutputResponse)
    if (!result.ok) throw new Error(messages[result.code ?? ''] ?? '设备无法读取此输出，请重试。')
    const page = result.full_output
    if (
      !page ||
      result.session_id !== threadId ||
      page.output_id !== reference.id ||
      page.storage_generation !== reference.storage_generation ||
      page.total_bytes !== reference.total_bytes ||
      page.expires_at !== reference.expires_at ||
      page.encoding !== 'base64' ||
      !Number.isSafeInteger(page.offset) ||
      page.offset !== Number(cursor) ||
      !Number.isSafeInteger(page.next_offset) ||
      page.next_offset < page.offset ||
      page.next_offset > page.total_bytes ||
      page.next_offset - page.offset > 12 * 1024 ||
      page.done !== (page.next_offset === page.total_bytes) ||
      (!page.done && page.next_offset === page.offset) ||
      result.cursor !== String(page.next_offset) ||
      typeof page.data !== 'string' ||
      page.data.length > 16 * 1024
    )
      throw new Error('设备返回的输出页面无效。')
    let bytes: Uint8Array
    try {
      bytes = Uint8Array.from(atob(page.data), (char) => char.charCodeAt(0))
    } catch {
      throw new Error('设备返回的输出页面无效。')
    }
    if (bytes.length !== page.next_offset - page.offset) throw new Error('设备返回的输出页面不完整。')
    return { page, bytes }
  }
}

export const readFullOutput = createFullOutputReader(createTransport().request)
export const readExecutionFullOutput = createFullOutputReader(createTransport().request, true)
