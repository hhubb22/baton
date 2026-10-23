import { ClientError } from '../client'
import type { LiveOutput } from '../types'
import { apiPath, type HttpContext } from './context'
import { HttpError } from './transport'

export type OutputResult = {
  ok: boolean
  code?: string
  state?: string
  text?: string
  cursor?: string
  gap?: boolean
}
type OutputState = {
  seq?: number
  cursor: string
  chunks: LiveOutput['chunks']
  error?: ClientError
}
type Subscription = { thread_id: string; cursor?: string }

const outputByteLimit = 256 * 1024
function appendOutput(previous: LiveOutput['chunks'], result: OutputResult): LiveOutput['chunks'] {
  const chunks = previous.map((chunk) => ({ ...chunk }))
  if (result.gap && chunks.at(-1)?.kind !== 'gap') chunks.push({ kind: 'gap' })
  if (result.text) {
    const last = chunks.at(-1)
    if (last?.kind === 'text') last.text += result.text
    else chunks.push({ kind: 'text', text: result.text })
  }
  const encoder = new TextEncoder()
  let bytes = chunks.reduce(
    (total, chunk) => total + (chunk.kind === 'text' ? encoder.encode(chunk.text).byteLength : 0),
    0,
  )
  let dropped = false
  while (bytes > outputByteLimit || chunks.length > 255) {
    dropped = true
    const first = chunks[0]
    if (first.kind === 'gap') {
      chunks.shift()
      continue
    }
    const encoded = encoder.encode(first.text)
    if (chunks.length > 255 || bytes - encoded.length >= outputByteLimit) {
      bytes -= encoded.length
      chunks.shift()
    } else {
      let offset = bytes - outputByteLimit
      while (offset < encoded.length && (encoded[offset] & 0xc0) === 0x80) offset += 1
      first.text = new TextDecoder().decode(encoded.subarray(offset))
      bytes -= offset
    }
  }
  if (dropped && chunks[0]?.kind !== 'gap') chunks.unshift({ kind: 'gap' })
  return chunks
}

export function createOutputAPI(request: HttpContext['request']) {
  const output = new Map<string, OutputState>()
  const reads = new Map<string, Promise<LiveOutput>>()
  const watchers = new Map<string, Set<(output: LiveOutput | null) => void>>()
  let send: ((subscription: Subscription) => void) | null = null
  let selected = ''
  let revision = 0
  const current = (id: string): OutputState => output.get(id) ?? { cursor: '', chunks: [] }
  const snapshot = (id: string): LiveOutput => {
    const value = current(id)
    if (value.error) throw value.error
    return { threadId: id, chunks: structuredClone(value.chunks) }
  }
  const notify = (id: string) => {
    const value = send && selected === id && !current(id).error ? snapshot(id) : null
    watchers.get(id)?.forEach((listener) => listener(value))
  }
  const subscribe = () => send?.({ thread_id: selected, cursor: current(selected).cursor || undefined })

  function apply(id: string, result: OutputResult, seq?: number) {
    const previous = current(id)
    if (!result.ok || (!result.cursor && !['idle', 'stopped', 'unknown'].includes(result.state ?? ''))) {
      output.set(id, {
        ...previous,
        error: new ClientError(
          'unavailable',
          result.code === 'node_offline' ? 'The device is offline.' : 'The device could not read live output.',
        ),
      })
      return
    }
    if (result.state && ['idle', 'stopped', 'unknown'].includes(result.state)) {
      output.set(id, { seq, cursor: result.cursor ?? '', chunks: [] })
      return
    }
    const epochChanged = previous.cursor && previous.cursor.split(':')[0] !== result.cursor!.split(':')[0]
    const turnChanged = seq !== undefined && previous.seq !== undefined && previous.seq !== seq
    output.set(id, {
      seq: seq ?? previous.seq,
      cursor: result.cursor!,
      chunks: appendOutput(epochChanged || turnChanged ? [] : previous.chunks, result),
    })
  }

  async function read(id: string): Promise<LiveOutput> {
    if (send && selected === id) return snapshot(id)
    const baseline = revision
    const initial = output.get(id)
    const t = await request<{
      status: string
      current_turn?: { worker_turn_seq: number } | null
    }>(`/threads/${apiPath(id)}`)
    if (baseline !== revision || output.get(id) !== initial || (send && selected === id)) return snapshot(id)
    if (t.status !== 'running' || !t.current_turn) {
      output.delete(id)
      return { threadId: id, chunks: [] }
    }
    const previous = current(id)
    const seq = t.current_turn.worker_turn_seq
    const query = new URLSearchParams()
    if (previous.cursor && (previous.seq === undefined || previous.seq === seq)) query.set('cursor', previous.cursor)
    let result: OutputResult
    try {
      result = await request<OutputResult>(`/threads/${apiPath(id)}/output${query.size ? `?${query}` : ''}`)
    } catch (error) {
      const code = error instanceof HttpError ? (error.payload as { code?: string } | null)?.code : undefined
      if (code !== 'node_offline' && code !== 'history_missing' && code !== 'trace_missing') throw error
      result = { ok: false, code }
    }
    if (baseline === revision && output.get(id) === initial && !(send && selected === id)) apply(id, result, seq)
    return snapshot(id)
  }

  return {
    readOutput(id: string): Promise<LiveOutput> {
      if (send && selected === id) return Promise.resolve().then(() => snapshot(id))
      const pending = reads.get(id)
      if (pending) return pending
      const pendingRead = read(id).finally(() => {
        if (reads.get(id) === pendingRead) reads.delete(id)
      })
      reads.set(id, pendingRead)
      return pendingRead
    },
    subscribeOutput(id: string, listener: (output: LiveOutput | null) => void) {
      let listeners = watchers.get(id)
      if (!listeners) {
        listeners = new Set()
        watchers.set(id, listeners)
      }
      listeners.add(listener)
      selected = id
      subscribe()
      notify(id)
      return () => {
        listeners.delete(listener)
        if (listeners.size) return
        watchers.delete(id)
        output.delete(id)
        revision += 1
        if (selected === id) {
          selected = [...watchers.keys()].at(-1) ?? ''
          subscribe()
          if (selected) notify(selected)
        }
      }
    },
    setConnection(connection: typeof send) {
      send = connection
      revision += 1
      if (send && selected) subscribe()
      if (selected) notify(selected)
    },
    receive(id: string, result: OutputResult) {
      if (!send || id !== selected || !watchers.has(id)) return
      apply(id, result)
      notify(id)
    },
    clear() {
      revision += 1
      output.clear()
      reads.clear()
    },
  }
}
