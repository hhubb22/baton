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
  node_offline: 'The device is offline. Connect it to read the full output.',
  node_syncing: 'The device is reconnecting. Try again shortly.',
  output_missing: 'The full output is no longer on this device.',
  output_expired: 'The retention period for this output has ended.',
  output_identity_mismatch: 'This output does not belong to this reply.',
  output_changed: 'The saved output changed. Read it again from the start.',
}

export function createFullOutputReader(request: HttpContext['request']) {
  return async (threadId: string, reference: FullOutputReference, cursor = '0', signal?: AbortSignal) => {
    const query = new URLSearchParams({
      action: 'full_output',
      output_id: reference.id,
      storage_generation: reference.storage_generation,
      cursor,
    })
    const result = await request<OutputResponse>(`/threads/${apiPath(threadId)}/output?${query}`, { signal })
    if (!result.ok) throw new Error(messages[result.code ?? ''] ?? 'The device could not read this output. Try again.')
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
      throw new Error('The device returned an invalid output page.')
    let bytes: Uint8Array
    try {
      bytes = Uint8Array.from(atob(page.data), (char) => char.charCodeAt(0))
    } catch {
      throw new Error('The device returned an invalid output page.')
    }
    if (bytes.length !== page.next_offset - page.offset)
      throw new Error('The device returned an incomplete output page.')
    return { page, bytes }
  }
}

export const readFullOutput = createFullOutputReader(createTransport().request)
