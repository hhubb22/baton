import { ClientError, type BatonClient } from '../client'
import type {
  Attachment,
  Delivery,
  FilePreview,
  FolderListing,
  HistoryPage,
  LiveOutput,
  Message,
  OperationPhase,
  Thread,
  ThreadStop,
  Trace,
  TraceStep,
} from '../types'
import { apiPath, timestamp, type HttpContext } from './context'
import { HttpError } from './transport'

type ThreadDTO = {
  id: string
  node_id: string
  agent_type: string
  model: string
  next_model?: string
  working_directory: string
  project_id?: string
  status: string
  status_reason: string
  created_at: string
  last_activity_at: string
  native_session_id?: string
  opened_at?: string
  stop_requested_at?: string
  stop_confirmed_at?: string
  archive_requested_at?: string
  node_online: boolean
  node_synced: boolean
  current_turn?: { worker_turn_seq: number; started_at: string } | null
  pending_messages?: MessageDTO[]
  failed_messages?: MessageDTO[]
}
type MessageDTO = {
  id: string
  thread_id: string
  client_message_id: string
  sender: string
  content: string
  status: string
  status_reason?: string
  created_at: string
  worker_turn_seq?: number
}
type EventDTO = {
  id: number
  kind: string
  created_at: string
  payload: {
    event_id?: string
    client_message_id?: string
    worker_turn_seq?: number
    reason?: string
    content?: string
    count?: number
    attachments?: AttachmentDTO[]
    metadata?: { activity?: Message['activity'] }
  } & Partial<MessageDTO>
}
type AttachmentDTO = {
  kind: string
  node_id?: string
  root_id?: string
  path?: string
  absolute_path?: string
  size?: number
  repo?: string
  sha?: string
  subject?: string
}
type FileDTO = {
  kind: string
  roots?: { id: string; path: string }[]
  entries?: { name: string; kind: string; size?: number }[]
  content?: string
  size?: number
  truncated: boolean
  next_cursor?: string
  remainder?: { scan_limited?: boolean }
}
type SessionDTO = {
  ok: boolean
  code?: string
  state?: string
  text?: string
  cursor?: string
  gap?: boolean
}
type NativeEntry = {
  id?: string
  parent_id?: string
  kind?: string
  text: string
  reference: string
  truncated: boolean
}
type HistoryDTO = SessionDTO & {
  history?: { entries: NativeEntry[]; cursor: string; has_more: boolean; gap: boolean; code?: string }
}
type Phase = { phase: OperationPhase; detail?: string | null }
type ThreadAPI = Pick<
  BatonClient,
  | 'listThreads'
  | 'listMessages'
  | 'createThread'
  | 'sendMessage'
  | 'cancelMessage'
  | 'setThreadModel'
  | 'stopThread'
  | 'archiveThread'
  | 'resumeThread'
  | 'readTrace'
  | 'readHistory'
  | 'readOutput'
  | 'listFolders'
  | 'readFile'
>

const base = '/threads'
const threadPath = (id: string) => `${base}/${apiPath(id)}`
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) })
const unavailable = (message: string): never => {
  throw new ClientError('unavailable', message)
}
const errorCode = (error: unknown): string | undefined => {
  if (!(error instanceof HttpError)) return undefined
  const payload = error.payload as { code?: string } | null
  return payload?.code
}
const unavailableReason = (code?: string): 'offline' | 'missing' | null => {
  if (code === 'node_offline') return 'offline'
  if (code === 'history_missing' || code === 'trace_missing') return 'missing'
  return null
}

function stopOf(t: ThreadDTO): ThreadStop | null {
  if (t.status !== 'stopped' && t.status !== 'unknown') return null
  const reason = t.status_reason ?? ''
  let kind: ThreadStop['kind'] = 'interrupted'
  if (
    /history_missing|history_lost|native Agent history missing|对话记录.*(丢失|不存在)|历史.*(丢失|找不到)/i.test(
      reason,
    )
  )
    kind = 'historyLost'
  else if (/folder_missing|working_directory_missing|目录.*(不存在|找不到)|找不到.*目录/i.test(reason))
    kind = 'folderMissing'
  else if (/forced|没有在 1 分钟内停下/i.test(reason)) kind = 'forced'
  else if (t.stop_confirmed_at) kind = 'byYou'
  else if (!t.opened_at) kind = 'startFailed'
  return { kind, detail: reason || null }
}

function mapThread(t: ThreadDTO, events: EventDTO[]): Thread {
  const first = events.find((event) => event.kind === 'message.accepted')?.payload.content
  const statuses: Record<string, Thread['status']> = {
    waiting_device: 'waiting',
    running: 'running',
    idle: 'idle',
    stopped: 'stopped',
    unknown: 'unknown',
    archived: 'archived',
  }
  if (t.agent_type !== 'pi' && t.agent_type !== 'codex' && t.agent_type !== 'kiro' && t.agent_type !== 'shell') {
    throw new ClientError('invalid', `Unsupported thread agent: ${t.agent_type}`)
  }
  const latestStop = events.findLastIndex(
    (event) => event.kind === 'stop.requested' || event.kind === 'archive.requested',
  )
  const canceled = latestStop < 0 ? [] : events.slice(latestStop).filter((event) => event.kind === 'message.withdrawn')
  return {
    id: t.id,
    title: first?.split('\n')[0].slice(0, 120) || t.working_directory || t.id,
    deviceId: t.node_id,
    folder: t.working_directory,
    agent: t.agent_type === 'shell' ? null : t.agent_type,
    model: t.next_model || t.model,
    projectId: t.project_id || null,
    status: statuses[t.status] ?? 'unknown',
    stop: stopOf(t),
    pending:
      t.status === 'archived'
        ? null
        : t.archive_requested_at
          ? 'archive'
          : t.stop_requested_at && !t.stop_confirmed_at
            ? 'stop'
            : null,
    stopCanceled: canceled.length,
    createdAt: timestamp(t.created_at),
    updatedAt: timestamp(t.last_activity_at),
    runStartedAt: t.current_turn ? timestamp(t.current_turn.started_at) : null,
    unread: false,
    earlier: Boolean(t.native_session_id),
  }
}

const outputByteLimit = 256 * 1024
function appendOutput(previous: LiveOutput['chunks'], result: SessionDTO): LiveOutput['chunks'] {
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

const record = (value: unknown): Record<string, unknown> | null =>
  value != null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

function nativeMessages(
  threadId: string,
  agent: string,
  entries: NativeEntry[],
): { messages: Message[]; gap: boolean } {
  let gap = entries.some((entry) => entry.truncated)
  const decoded = entries.flatMap((entry) => {
    let raw: Record<string, unknown> | null = null
    try {
      raw = record(JSON.parse(entry.text))
    } catch {
      gap = true
    }
    if (!raw) {
      gap = true
      return []
    }
    return [{ entry, raw }]
  })
  let active = decoded
  if (agent === 'pi' && decoded.some(({ entry, raw }) => entry.parent_id || raw.parentId)) {
    const byID = new Map(
      decoded.filter(({ raw }) => typeof raw.id === 'string').map((item) => [item.raw.id as string, item]),
    )
    const ids = new Set<string>()
    let leaf = decoded.findLast(({ raw }) => typeof raw.id === 'string' && raw.type !== 'session')
    let complete = true
    while (leaf) {
      const id = leaf.raw.id as string
      if (ids.has(id)) {
        complete = false
        break
      }
      ids.add(id)
      const parent = leaf.entry.parent_id || leaf.raw.parentId
      if (!parent) break
      if (typeof parent !== 'string' || !byID.has(parent)) {
        complete = false
        break
      }
      leaf = byID.get(parent as string)
    }
    if (complete) active = decoded.filter(({ raw }) => ids.has(raw.id as string))
    else gap = true
  }
  if (agent === 'kiro' && entries.length) gap = true
  const messages: Message[] = []
  const ids = new Set<string>()
  for (const { entry, raw } of active) {
    let message: Record<string, unknown> | null = null
    if (agent === 'pi' && raw.type === 'message') message = record(raw.message)
    else if (agent === 'codex' && raw.type === 'response_item') {
      const payload = record(raw.payload)
      if (payload?.type === 'message') message = payload
    }
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue
    let body: string
    if (typeof message.content === 'string') body = message.content
    else if (Array.isArray(message.content)) {
      body = message.content
        .map((block: unknown) => {
          const part = record(block)
          return part &&
            ['text', 'input_text', 'output_text'].includes(String(part.type)) &&
            typeof part.text === 'string'
            ? part.text
            : ''
        })
        .join('')
    } else {
      gap = true
      continue
    }
    if (!body) continue
    const sourceID = entry.id || (typeof raw.id === 'string' ? raw.id : entry.reference)
    const time = raw.timestamp ?? message.timestamp
    const createdAt = typeof time === 'string' || typeof time === 'number' ? timestamp(time) : NaN
    if (!sourceID || !Number.isFinite(createdAt)) {
      gap = true
      continue
    }
    const id = 'history:' + threadId + ':' + encodeURIComponent(sourceID)
    if (ids.has(id)) {
      gap = true
      continue
    }
    ids.add(id)
    messages.push({
      id,
      threadId,
      role: message.role === 'user' ? 'user' : 'agent',
      sender: message.role === 'user' ? 'you' : 'agent',
      body: entry.truncated ? body + '\n\n[History entry truncated]' : body,
      createdAt,
      delivery: 'delivered',
      activity: null,
      attachments: [],
    })
  }
  return { messages, gap }
}

function deliveryOf(m: MessageDTO, t: ThreadDTO): Delivery {
  switch (m.status) {
    case 'accepted':
      return !t.node_online || !t.node_synced ? 'waitingDevice' : 'saved'
    case 'queued':
      return 'queued'
    case 'sent':
      return 'delivered'
    case 'withdrawn':
      return 'withdrawn'
    default:
      return 'unknown'
  }
}

export function createThreadAPI(ctx: HttpContext): ThreadAPI {
  const clientIDs = new Map<string, string>()
  const messages = new Map<string, MessageDTO>()
  const replies = new Map<string, { threadId: string; seq: number }>()
  const output = new Map<string, { seq: number; cursor: string; chunks: LiveOutput['chunks'] }>()
  const outputReads = new Map<string, Promise<LiveOutput>>()
  async function sessionResult<T extends SessionDTO>(path: string): Promise<T> {
    try {
      return await ctx.request<T>(path)
    } catch (error) {
      const code = errorCode(error)
      if (unavailableReason(code)) return { ok: false, code } as T
      throw error
    }
  }
  const uuid = (scope: string, clientId: string) => {
    if (!clientId) throw new ClientError('invalid', 'A client ID is required.')
    const key = JSON.stringify([scope, clientId])
    let id = clientIDs.get(key)
    if (!id) {
      id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)
        ? clientId
        : crypto.randomUUID()
      clientIDs.set(key, id)
    }
    return id
  }
  async function timeline(id: string): Promise<EventDTO[]> {
    const events: EventDTO[] = []
    const cursors = new Set<string>()
    let cursor = ''
    do {
      const query = new URLSearchParams({ limit: '100' })
      if (cursor) query.set('cursor', cursor)
      const page = await ctx.request<{ events: EventDTO[]; next_cursor?: string }>(
        `${threadPath(id)}/timeline?${query}`,
      )
      events.push(...page.events)
      cursor = page.next_cursor ?? ''
      if (cursor && cursors.has(cursor)) unavailable('The timeline cursor did not advance.')
      cursors.add(cursor)
    } while (cursor)
    return events
  }
  const view = (id: string) => ctx.request<ThreadDTO>(threadPath(id))
  async function agentFor(t: Pick<ThreadDTO, 'node_id' | 'agent_type'>, model?: string) {
    const device = (await ctx.devices()).find((device) => device.id === t.node_id)
    const agent = device?.agents.find((agent) => agent.kind === t.agent_type)
    if (!agent || agent.problem)
      throw new ClientError('invalid', 'The device has not reported this agent as available.')
    if (model && !agent.models.includes(model))
      throw new ClientError('invalid', 'The device has not reported this model as available.')
    return agent
  }
  async function roots(deviceId: string) {
    const result = await ctx.request<FileDTO>(`/nodes/${apiPath(deviceId)}/files`)
    return result.roots ?? []
  }
  async function locate(deviceId: string, path: string) {
    const entries = await roots(deviceId)
    const normalized = path.replaceAll('\\', '/')
    return entries
      .map((root) => ({ ...root, normalized: root.path.replaceAll('\\', '/').replace(/\/$/, '') }))
      .sort((a, b) => b.normalized.length - a.normalized.length)
      .find((root) => normalized === root.normalized || normalized.startsWith(`${root.normalized}/`))
  }
  async function browse(deviceId: string, path: string, cursor = '') {
    const root = await locate(deviceId, path)
    if (!root) return null
    const relative = path.replaceAll('\\', '/').slice(root.normalized.length).replace(/^\//, '')
    if (relative.split('/').some((part) => part === '..' || part === '.')) return null
    const query = new URLSearchParams({ root_id: root.id, path: relative })
    if (cursor) query.set('cursor', cursor)
    return ctx.request<FileDTO>(`/nodes/${apiPath(deviceId)}/files?${query}`)
  }
  function attachmentsOf(items: AttachmentDTO[] = []): Attachment[] {
    const result: Attachment[] = []
    for (const item of items) {
      if (item.kind === 'commit' && item.repo && item.sha) {
        result.push({ kind: 'commit', repo: item.repo, sha: item.sha, subject: item.subject ?? '' })
      } else if (item.kind === 'file' && item.node_id && item.absolute_path && item.size != null) {
        result.push({ kind: 'file', deviceId: item.node_id, path: item.absolute_path, size: item.size })
      }
    }
    return result
  }
  function userMessage(m: MessageDTO, t: ThreadDTO): Message {
    messages.set(m.id, m)
    return {
      id: m.id,
      threadId: t.id,
      role: 'user',
      sender: m.sender === 'project_agent' ? 'projectAgent' : 'you',
      body: m.content,
      createdAt: timestamp(m.created_at),
      delivery: deliveryOf(m, t),
      activity: null,
      attachments: [],
    }
  }
  async function readMessages(t: ThreadDTO, events: EventDTO[]): Promise<Message[]> {
    const accepted = new Map<string, MessageDTO>()
    const result: Message[] = []
    const order = new Map<string, number>()
    for (const event of events) {
      if (event.kind === 'message.accepted') {
        const m = event.payload as MessageDTO
        accepted.set(m.client_message_id, { ...m })
        order.set(m.id, event.id)
      } else if (['message.queued', 'message.sent', 'message.withdrawn', 'message.unknown'].includes(event.kind)) {
        const m = accepted.get(event.payload.client_message_id ?? '')
        if (m)
          Object.assign(m, {
            status: event.kind.slice('message.'.length),
            status_reason: event.payload.reason,
            worker_turn_seq: event.payload.worker_turn_seq,
          })
      } else if (event.kind === 'messages.withdrawn') {
        for (const m of accepted.values()) {
          if (m.status === 'accepted' || m.status === 'queued') m.status = 'withdrawn'
        }
      } else if (event.kind === 'reply') {
        const id = `reply:${t.id}:${event.payload.event_id ?? event.id}`
        order.set(id, event.id)
        if (event.payload.worker_turn_seq != null)
          replies.set(id, { threadId: t.id, seq: event.payload.worker_turn_seq })
        result.push({
          id,
          threadId: t.id,
          role: 'agent',
          sender: 'agent',
          body: event.payload.content ?? '',
          createdAt: timestamp(event.created_at),
          delivery: 'delivered',
          activity: event.payload.metadata?.activity ?? null,
          attachments: attachmentsOf(event.payload.attachments),
        })
      }
    }
    for (const m of [...(t.pending_messages ?? []), ...(t.failed_messages ?? [])]) accepted.set(m.client_message_id, m)
    result.push(...[...accepted.values()].map((m) => userMessage(m, t)))
    return result.sort(
      (a, b) => a.createdAt - b.createdAt || (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity),
    )
  }
  function messagePhase(m: MessageDTO, t: ThreadDTO, events: EventDTO[]): Phase {
    if (m.status === 'withdrawn' || m.status === 'unknown')
      return {
        phase: 'failed',
        detail:
          m.status_reason ||
          (m.status === 'unknown' ? 'The device could not confirm delivery.' : 'The message was withdrawn.'),
      }
    if (m.status === 'accepted') return { phase: !t.node_online || !t.node_synced ? 'waitingDevice' : 'saved' }
    if (m.status === 'queued') return { phase: 'queued' }
    const ended = events.find(
      (event) => event.kind === 'turn.ended' && event.payload.worker_turn_seq === m.worker_turn_seq,
    )
    if (ended)
      return {
        phase:
          ended.payload.reason === 'completed' ? 'done' : ended.payload.reason === 'stopped' ? 'stopped' : 'failed',
        detail: ended.payload.reason,
      }
    if (t.status === 'unknown')
      return { phase: 'failed', detail: t.status_reason || 'The device could not confirm execution.' }
    if (t.status === 'stopped')
      return { phase: t.stop_confirmed_at ? 'stopped' : 'failed', detail: t.status_reason || null }
    return { phase: 'running' }
  }
  async function executionPhase(threadId: string, clientMessageId: string): Promise<Phase> {
    const [t, events] = await Promise.all([view(threadId), timeline(threadId)])
    await readMessages(t, events)
    const m = [...messages.values()].find((m) => m.thread_id === threadId && m.client_message_id === clientMessageId)
    if (t.status === 'stopped' && !t.opened_at)
      return { phase: 'failed', detail: t.status_reason || 'The agent could not start.' }
    return m ? messagePhase(m, t, events) : { phase: 'saved' }
  }
  function actionPhase(kind: 'stopThread' | 'archiveThread', t: ThreadDTO): Phase {
    if (kind === 'archiveThread' && t.status === 'archived') return { phase: 'done' }
    if (t.status === 'unknown')
      return { phase: 'failed', detail: t.status_reason || 'The device could not confirm the action.' }
    if (kind === 'stopThread' && t.stop_confirmed_at) return { phase: 'stopped', detail: t.status_reason || null }
    return { phase: !t.node_online || !t.node_synced ? 'waitingDevice' : 'stopping', detail: t.status_reason || null }
  }
  async function action(kind: 'stopThread' | 'archiveThread' | 'resumeThread', threadId: string) {
    const baseline = kind === 'resumeThread' ? ((await timeline(threadId)).at(-1)?.id ?? 0) : 0
    const endpoint = kind === 'stopThread' ? 'stop' : kind === 'archiveThread' ? 'archive' : 'resume'
    const t = await ctx.request<ThreadDTO>(`${threadPath(threadId)}/${endpoint}`, post({}))
    ctx.emit('threads', 'messages', 'operations')
    const phase: Phase =
      kind === 'resumeThread'
        ? { phase: !t.node_online || !t.node_synced ? ('waitingDevice' as const) : ('saved' as const) }
        : actionPhase(kind, t)
    return ctx.operation(kind, threadId, phase.phase, phase.detail, async () => {
      const current = await view(threadId)
      if (kind !== 'resumeThread') return actionPhase(kind, current)
      const reports = (await timeline(threadId)).filter((event) => event.id > baseline)
      const failure = reports.findLast((event) => event.kind === 'thread.stopped' || event.kind === 'thread.unknown')
      if (failure)
        return {
          phase: 'failed',
          detail: failure.payload.reason || current.status_reason || 'The agent could not resume.',
        }
      if (reports.some((event) => event.kind === 'thread.resumed')) return { phase: 'done' }
      return { phase: !current.node_online || !current.node_synced ? 'waitingDevice' : 'saved' }
    })
  }
  function fileReason(error: unknown): Extract<FilePreview, { state: 'unavailable' }>['reason'] | null {
    switch (errorCode(error)) {
      case 'node_offline':
        return 'offline'
      case 'node_syncing':
        return 'syncing'
      case 'root_forbidden':
      case 'path_escaped':
        return 'outsideFolders'
      case 'not_found':
        return 'missing'
      case 'not_text':
        return 'binary'
      default:
        return null
    }
  }
  async function readOutput(threadId: string): Promise<LiveOutput> {
    const t = await view(threadId)
    if (t.status !== 'running' || !t.current_turn) {
      output.delete(threadId)
      return { threadId, chunks: [] }
    }
    let current = output.get(threadId)
    if (!current || current.seq !== t.current_turn.worker_turn_seq)
      current = { seq: t.current_turn.worker_turn_seq, cursor: '', chunks: [] }
    const query = new URLSearchParams()
    if (current.cursor) query.set('cursor', current.cursor)
    const result = await sessionResult<SessionDTO>(`${threadPath(threadId)}/output${query.size ? `?${query}` : ''}`)
    if (!result.ok)
      unavailable(result.code === 'node_offline' ? 'The device is offline.' : 'The device could not read live output.')
    if (result.state && ['idle', 'stopped', 'unknown'].includes(result.state)) {
      output.delete(threadId)
      return { threadId, chunks: [] }
    }
    if (!result.cursor) unavailable('The device returned an incomplete output cursor.')
    const chunks = appendOutput(current.chunks, result)
    output.set(threadId, { seq: current.seq, cursor: result.cursor!, chunks })
    return { threadId, chunks: structuredClone(chunks) }
  }
  const api: ThreadAPI = {
    async listThreads() {
      const all: ThreadDTO[] = []
      const cursors = new Set<string>()
      let cursor = ''
      do {
        const query = new URLSearchParams({ limit: '100' })
        if (cursor) query.set('cursor', cursor)
        const page = await ctx.request<{ threads: ThreadDTO[]; next_cursor?: string }>(`${base}?${query}`)
        all.push(...page.threads)
        cursor = page.next_cursor ?? ''
        if (cursor && cursors.has(cursor)) unavailable('The thread cursor did not advance.')
        cursors.add(cursor)
      } while (cursor)
      return Promise.all(
        all.map(async (t) => {
          const [detail, events] = await Promise.all([view(t.id), timeline(t.id)])
          return mapThread(detail, events)
        }),
      )
    },
    async listMessages(threadId) {
      const [t, events] = await Promise.all([view(threadId), timeline(threadId)])
      return readMessages(t, events)
    },
    async createThread(input) {
      await agentFor({ node_id: input.deviceId, agent_type: input.agent }, input.model)
      const messageId = uuid('create-message', input.clientId)
      const t = await ctx.request<ThreadDTO>(
        base,
        post({
          client_thread_id: uuid('create-thread', input.clientId),
          node_id: input.deviceId,
          agent_type: input.agent,
          model: input.model,
          working_directory: input.folder,
          message: { client_message_id: messageId, content: input.body },
        }),
      )
      const refresh = () => executionPhase(t.id, messageId)
      ctx.emit('threads', 'messages', 'operations')
      const phase: Phase =
        t.status === 'unknown' || (t.status === 'stopped' && !t.opened_at)
          ? { phase: 'failed', detail: t.status_reason || 'The agent could not start.' }
          : { phase: !t.node_online || !t.node_synced ? 'waitingDevice' : 'saved' }
      return ctx.operation('createThread', t.id, phase.phase, phase.detail, refresh)
    },
    async sendMessage(input) {
      const t = await view(input.threadId)
      const agent = await agentFor(t)
      if (input.mode === 'now' && !agent.abilities.steer)
        throw new ClientError('invalid', 'This agent does not support inserting messages.')
      const clientId = uuid(`message:${input.threadId}`, input.clientId)
      const m = await ctx.request<MessageDTO>(
        `${threadPath(input.threadId)}/messages`,
        post({ client_message_id: clientId, content: input.body, mode: input.mode === 'now' ? 'steer' : 'queue' }),
      )
      messages.set(m.id, m)
      const phase = messagePhase(m, t, [])
      ctx.emit('threads', 'messages', 'operations')
      return ctx.operation('sendMessage', m.id, phase.phase, phase.detail, () => executionPhase(t.id, clientId))
    },
    async cancelMessage(messageId) {
      let message = messages.get(messageId)
      if (!message) {
        for (const t of await api.listThreads()) {
          await api.listMessages(t.id)
          message = messages.get(messageId)
          if (message) break
        }
      }
      if (!message) throw new ClientError('notFound', 'The message was not found.')
      await ctx.request(`${threadPath(message.thread_id)}/messages/${apiPath(messageId)}/withdraw`, post({}))
      ctx.emit('threads', 'messages')
      const updated = (await api.listMessages(message.thread_id)).find((item) => item.id === messageId)
      return updated ?? unavailable('The device has not confirmed the message state.')
    },
    async setThreadModel({ threadId, model }) {
      const t = await view(threadId)
      const agent = await agentFor(t, model)
      if (!agent.abilities.switchModel) throw new ClientError('invalid', 'This agent does not support changing models.')
      const updated = await ctx.request<ThreadDTO>(`${threadPath(threadId)}/model`, post({ model }))
      ctx.emit('threads')
      return mapThread(updated, await timeline(threadId))
    },
    stopThread: (id) => action('stopThread', id),
    archiveThread: (id) => action('archiveThread', id),
    async resumeThread(id) {
      const t = await view(id)
      if (!(await agentFor(t)).abilities.resume)
        throw new ClientError('invalid', 'This agent does not support resuming conversations.')
      return action('resumeThread', id)
    },
    async readTrace(messageId): Promise<Trace> {
      let reply = replies.get(messageId)
      if (!reply) {
        const parts = messageId.split(':')
        if (parts[0] === 'reply' && parts[1]) await api.listMessages(parts[1])
        reply = replies.get(messageId)
      }
      if (!reply) throw new ClientError('notFound', 'The reply was not found.')
      const query = new URLSearchParams({ worker_turn_seq: String(reply.seq) })
      const result = await sessionResult<{
        ok: boolean
        code?: string
        steps?: (TraceStep & { truncated?: boolean })[]
      }>(`${threadPath(reply.threadId)}/trace?${query}`)
      if (!result.ok) {
        const reason = unavailableReason(result.code)
        if (reason) return { state: 'unavailable', messageId, reason }
        unavailable('The device could not read this trace.')
      }
      if (!result.steps) unavailable('The device returned an incomplete trace.')
      if (result.steps!.some((step) => step.truncated)) unavailable('The stored trace is incomplete.')
      return { state: 'ready', messageId, steps: result.steps! }
    },
    async readHistory(threadId, before): Promise<HistoryPage> {
      const t = await view(threadId)
      const entries: NativeEntry[] = []
      const cursors = new Set<string>()
      let cursor = ''
      let bytes = 0
      let gap = false
      for (let pageNumber = 0; ; pageNumber += 1) {
        if (pageNumber >= 128 || bytes > 2 * 1024 * 1024)
          unavailable('The native history exceeds the browser reading limit.')
        const query = new URLSearchParams({ limit: '16' })
        if (cursor) query.set('cursor', cursor)
        const response = await sessionResult<HistoryDTO>(`${threadPath(threadId)}/history?${query}`)
        if (!response.ok) {
          const reason = unavailableReason(response.code)
          if (reason) return { state: 'unavailable', threadId, reason }
          unavailable('The device could not read this history.')
        }
        const page = response.history
        if (!page) unavailable('The device returned an incomplete history page.')
        gap ||= Boolean(page!.gap || page!.code)
        entries.push(...page!.entries)
        bytes += page!.entries.reduce((sum, entry) => sum + new TextEncoder().encode(entry.text).byteLength, 0)
        if (!page!.has_more) break
        if (!page!.cursor || cursors.has(page!.cursor)) unavailable('The history cursor did not advance.')
        cursors.add(page!.cursor)
        cursor = page!.cursor
      }
      const parsed = nativeMessages(threadId, t.agent_type, entries)
      const native = parsed.messages
      gap ||= parsed.gap
      let end = native.length
      if (before != null) {
        end = native.findIndex((message) => message.id === before)
        if (end < 0) unavailable('The native history changed. Reload the conversation before reading more.')
      } else {
        const saved = (await readMessages(t, await timeline(threadId))).filter(
          (message) => message.delivery === 'delivered',
        )
        if (saved.length) {
          // 完整且唯一的消息序列确定中心记录的起点，避免依赖两端时钟一致。
          const matches = native.flatMap((_, index) =>
            saved.every(
              (message, offset) =>
                native[index + offset]?.role === message.role && native[index + offset]?.body === message.body,
            )
              ? [index]
              : [],
          )
          if (matches.length === 1) end = matches[0]
          else if (!gap) unavailable('The native history could not be matched to the saved conversation.')
        }
      }
      const start = Math.max(0, end - 16)
      return { state: 'ready', threadId, messages: native.slice(start, end), more: start > 0, gap }
    },
    readOutput(threadId): Promise<LiveOutput> {
      const pending = outputReads.get(threadId)
      if (pending) return pending
      const read = readOutput(threadId).finally(() => {
        outputReads.delete(threadId)
      })
      outputReads.set(threadId, read)
      return read
    },
    async listFolders(deviceId, path): Promise<FolderListing> {
      try {
        const connection = (await ctx.devices()).find((device) => device.id === deviceId)?.connection
        if (connection === 'offline' || connection === 'syncing')
          return { state: 'unavailable', deviceId, path, reason: connection }
        if (path == null)
          return {
            state: 'ready',
            deviceId,
            path,
            folders: (await roots(deviceId)).map((root) => root.path),
            files: [],
          }
        const folders: string[] = []
        const files: { path: string; size: number }[] = []
        const cursors = new Set<string>()
        let cursor = ''
        do {
          const result = await browse(deviceId, path, cursor)
          if (!result) return { state: 'unavailable', deviceId, path, reason: 'outsideFolders' }
          if (result.kind !== 'directory') return { state: 'unavailable', deviceId, path, reason: 'missing' }
          for (const entry of result.entries ?? []) {
            const child = `${path.replace(/[\\/]$/, '')}/${entry.name}`
            if (entry.kind === 'directory') folders.push(child)
            else if (entry.kind === 'file' && entry.size != null) files.push({ path: child, size: entry.size })
          }
          cursor = result.next_cursor ?? ''
          if (cursor && cursors.has(cursor)) unavailable('The folder cursor did not advance.')
          cursors.add(cursor)
          if (result.remainder?.scan_limited && !cursor)
            unavailable('The device could not list the complete directory.')
        } while (cursor)
        return { state: 'ready', deviceId, path, folders, files }
      } catch (error) {
        const reason = fileReason(error)
        if (reason && reason !== 'binary') return { state: 'unavailable', deviceId, path, reason }
        throw error
      }
    },
    async readFile(deviceId, path): Promise<FilePreview> {
      try {
        const connection = (await ctx.devices()).find((device) => device.id === deviceId)?.connection
        if (connection === 'offline' || connection === 'syncing')
          return { state: 'unavailable', deviceId, path, reason: connection, size: null }
        const result = await browse(deviceId, path)
        if (!result) return { state: 'unavailable', deviceId, path, reason: 'outsideFolders', size: null }
        if (result.kind !== 'file')
          return { state: 'unavailable', deviceId, path, reason: 'missing', size: result.size ?? null }
        if (result.size == null || result.content == null)
          unavailable('The device returned an incomplete file preview.')
        return {
          state: 'ready',
          deviceId,
          path,
          size: result.size!,
          content: result.content!,
          truncated: result.truncated,
        }
      } catch (error) {
        const reason = fileReason(error)
        if (reason) return { state: 'unavailable', deviceId, path, reason, size: null }
        throw error
      }
    },
  }
  return api
}
