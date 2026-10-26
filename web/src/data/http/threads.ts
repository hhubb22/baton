import type { ThreadTrace } from '@baton/protocol'
import { ClientError, type BatonClient } from '../client'
import { insideFileFolder, joinFilePath, normalizeFilePath } from '../file-paths'
import { previewLimit } from '../types'
import { agentUnavailableReason, canCreateAgent } from '../derive'
import type {
  Attachment,
  Delivery,
  FilePreview,
  FileReadOptions,
  FolderListing,
  FullOutputReference,
  Message,
  OperationPhase,
  Thread,
  ThreadQuestion,
  ThreadStop,
  Trace,
} from '../types'
import { apiPath, timestamp, type HttpContext } from './context'
import { HttpError } from './transport'
import { createOutputAPI } from './output'

type ThreadDTO = {
  title?: string
  stop_canceled?: number
  id: string
  node_id: string
  agent_type: string
  model: string
  execution_timeout_seconds: number
  next_model?: string
  working_directory: string
  project_id?: string
  status: string
  status_reason: string
  created_at: string
  last_activity_at: string
  native_session_id?: string
  opened_at?: string | null
  resume_pending?: boolean
  retry_open_allowed?: boolean
  stop_requested_at?: string
  stop_confirmed_at?: string
  archive_requested_at?: string
  node_online: boolean
  node_synced: boolean
  current_turn?: { worker_turn_seq: number; started_at: string } | null
  question_answers?: import('@baton/protocol').ThreadQuestionAnswer[]
  pending_questions?: ThreadQuestion[]
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
    item_count?: number
    attachments?: AttachmentDTO[]
    metadata?: { activity?: Message['activity']; full_output?: unknown }
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
  offset?: number
  version?: string
  next_offset?: number
  truncated: boolean
  next_cursor?: string
  remainder?: { scan_limited?: boolean }
}
type Phase = { phase: OperationPhase; detail?: string | null }
type ThreadAPI = Pick<
  BatonClient,
  | 'listThreads'
  | 'getThread'
  | 'listMessages'
  | 'createThread'
  | 'sendMessage'
  | 'cancelMessage'
  | 'answerThreadQuestion'
  | 'setThreadModel'
  | 'setThreadExecutionLimit'
  | 'stopThread'
  | 'archiveThread'
  | 'resumeThread'
  | 'readTrace'
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

function fullOutputOf(value: unknown): FullOutputReference | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('id' in value) ||
    typeof value.id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id) ||
    !('storage_generation' in value) ||
    typeof value.storage_generation !== 'string' ||
    value.storage_generation.length === 0 ||
    new TextEncoder().encode(value.storage_generation).length > 256 ||
    /[\p{Cc}]/u.test(value.storage_generation) ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value.storage_generation) ||
    !('total_bytes' in value) ||
    typeof value.total_bytes !== 'number' ||
    !Number.isSafeInteger(value.total_bytes) ||
    value.total_bytes < 0 ||
    !('expires_at' in value) ||
    typeof value.expires_at !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value.expires_at) ||
    !Number.isFinite(Date.parse(value.expires_at))
  )
    return null
  return {
    id: value.id,
    storage_generation: value.storage_generation,
    total_bytes: value.total_bytes,
    expires_at: value.expires_at,
  }
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
  if (
    t.agent_type !== 'pi' &&
    t.agent_type !== 'codex' &&
    t.agent_type !== 'kiro' &&
    t.agent_type !== 'cursor' &&
    t.agent_type !== 'shell'
  ) {
    throw new ClientError('invalid', `Unsupported thread agent: ${t.agent_type}`)
  }
  const latestStop = events.findLastIndex(
    (event) => event.kind === 'stop.requested' || event.kind === 'archive.requested',
  )
  const canceled = latestStop < 0 ? [] : events.slice(latestStop).filter((event) => event.kind === 'message.withdrawn')
  return {
    pendingQuestions: t.pending_questions ?? [],
    questionAnswers: t.question_answers ?? [],
    id: t.id,
    title: t.title || first?.split('\n')[0].slice(0, 120) || t.working_directory || t.id,
    deviceId: t.node_id,
    folder: t.working_directory,
    agent: t.agent_type === 'shell' ? null : t.agent_type,
    model: t.next_model || t.model,
    executionTimeoutSeconds: t.execution_timeout_seconds,
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
    starting: !t.opened_at && !['stopped', 'unknown', 'archived'].includes(t.status),
    resumePending: t.resume_pending,
    retryOpenAllowed: t.retry_open_allowed,
    stopCanceled: t.stop_canceled ?? canceled.length,
    createdAt: timestamp(t.created_at),
    updatedAt: timestamp(t.last_activity_at),
    runStartedAt: t.current_turn ? timestamp(t.current_turn.started_at) : null,
    unread: false,
  }
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

export function createThreadAPI(
  ctx: HttpContext,
  output = createOutputAPI(<T>(path: string, init?: RequestInit) => ctx.request<T>(path, init)),
): ThreadAPI {
  const clientIDs = new Map<string, string>()
  const messages = new Map<string, MessageDTO>()
  const replies = new Map<string, { threadId: string; seq: number }>()
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
  async function agentFor(t: Pick<ThreadDTO, 'node_id' | 'agent_type'>) {
    const device = (await ctx.devices()).find((device) => device.id === t.node_id)
    const agent = device?.agents.find((agent) => agent.kind === t.agent_type)
    if (!agent) throw new ClientError('invalid', 'The device has not reported this agent as available.')
    if (agent.status !== 'available' || agent.problem) throw new ClientError('invalid', agentUnavailableReason(agent))
    return agent
  }
  async function roots(deviceId: string) {
    const entries: { id: string; path: string }[] = []
    const cursors = new Set<string>()
    let cursor = ''
    let scanLimited = false
    do {
      const query = cursor ? `?${new URLSearchParams({ cursor })}` : ''
      let result: FileDTO
      try {
        result = await ctx.request<FileDTO>(`/nodes/${apiPath(deviceId)}/files${query}`)
      } catch (error) {
        if (!cursor) throw error
        scanLimited = true
        break
      }
      entries.push(...(result.roots ?? []))
      cursor = result.next_cursor ?? ''
      if (cursor && cursors.has(cursor)) {
        scanLimited = true
        break
      }
      cursors.add(cursor)
      scanLimited ||= result.truncated && !cursor
    } while (cursor)
    return { entries, scanLimited }
  }
  async function locate(deviceId: string, path: string) {
    const result = await roots(deviceId)
    const found = result.entries
      .map((root) => ({ ...root, normalized: normalizeFilePath(root.path).replace(/\/$/, '') }))
      .sort((a, b) => b.normalized.length - a.normalized.length)
      .find((root) => insideFileFolder(path, root.path))
    if (!found && result.scanLimited) unavailable('The device could not list all allowed folders.')
    return found
  }
  async function browse(deviceId: string, path: string, cursor = '', continuation?: FileReadOptions) {
    const root = await locate(deviceId, path)
    if (!root) return null
    const relative = normalizeFilePath(path, root.path).slice(root.normalized.length).replace(/^\//, '')
    if (relative.split('/').some((part) => part === '..' || part === '.')) return null
    const query = new URLSearchParams({ root_id: root.id, path: relative })
    if (cursor) query.set('cursor', cursor)
    if (continuation) {
      query.set('offset', String(continuation.offset))
      query.set('version', continuation.version)
    }
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
    const turnReplies = new Map<number, Message[]>()
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
      } else if (event.kind === 'turn.ended' && event.payload.reason === 'failed') {
        const id = `turn-failed:${t.id}:${event.payload.event_id ?? event.id}`
        order.set(id, event.id)
        result.push({
          id,
          threadId: t.id,
          role: 'failure',
          traceItemCount: 0,
          sender: 'agent',
          body: event.payload.content ?? '',
          createdAt: timestamp(event.created_at),
          delivery: 'delivered',
          activity: null,
          attachments: [],
        })
      } else if (event.kind === 'reply') {
        const id = `reply:${t.id}:${event.payload.event_id ?? event.id}`
        order.set(id, event.id)
        if (event.payload.worker_turn_seq != null)
          replies.set(id, { threadId: t.id, seq: event.payload.worker_turn_seq })
        const reply: Message = {
          id,
          threadId: t.id,
          role: 'agent',
          sender: 'agent',
          body: event.payload.content ?? '',
          createdAt: timestamp(event.created_at),
          delivery: 'delivered',
          activity: event.payload.metadata?.activity ?? null,
          fullOutput: fullOutputOf(event.payload.metadata?.full_output),
          attachments: attachmentsOf(event.payload.attachments),
        }
        result.push(reply)
        const seq = event.payload.worker_turn_seq
        if (seq !== undefined) {
          const group = turnReplies.get(seq) ?? []
          group.push(reply)
          turnReplies.set(seq, group)
        }
      }
    }
    for (const event of events) {
      const { worker_turn_seq: seq, item_count: count } = event.payload
      if (
        event.kind !== 'turn.ended' ||
        seq === undefined ||
        count === undefined ||
        !Number.isSafeInteger(count) ||
        count < 0
      )
        continue
      const group = turnReplies.get(seq) ?? []
      group.forEach((reply, index) => {
        reply.traceItemCount = index === 0 ? count : 0
        if (index > 0) reply.activity = null
      })
      if (group.length || count === 0) continue
      const failureId = `turn-failed:${t.id}:${event.payload.event_id ?? event.id}`
      const failure = result.find((message) => message.id === failureId)
      if (failure) {
        failure.traceItemCount = count
        replies.set(failure.id, { threadId: t.id, seq })
      } else {
        const id = `turn-activity:${t.id}:${event.payload.event_id ?? event.id}`
        order.set(id, event.id)
        result.push({
          id,
          threadId: t.id,
          role: 'activity',
          sender: 'agent',
          body: '',
          createdAt: timestamp(event.created_at),
          delivery: 'delivered',
          activity: null,
          traceItemCount: count,
          attachments: [],
        })
        replies.set(id, { threadId: t.id, seq })
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
        detail:
          ended.payload.reason === 'failed' ? ended.payload.content || ended.payload.reason : ended.payload.reason,
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
      if (current.resume_pending)
        return { phase: !current.node_online || !current.node_synced ? 'waitingDevice' : 'saved' }
      const reports = (await timeline(threadId)).filter((event) => event.id > baseline)
      const failure = reports.findLast((event) => event.kind === 'thread.stopped' || event.kind === 'thread.unknown')
      if (failure)
        return {
          phase: 'failed',
          detail: failure.payload.reason || current.status_reason || 'The agent could not resume.',
        }
      if (current.resume_pending === false) {
        if (current.opened_at && ['idle', 'running'].includes(current.status)) return { phase: 'done' }
        if (['stopped', 'unknown', 'archived'].includes(current.status))
          return { phase: 'failed', detail: current.status_reason || 'The thread did not resume.' }
      }
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
  const api: ThreadAPI = {
    async answerThreadQuestion({ threadId, answer }) {
      const updated = await ctx.request<ThreadDTO>(`${threadPath(threadId)}/answer`, post(answer))
      ctx.emit('threads', 'messages')
      return mapThread(updated, await timeline(threadId))
    },
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
      return all.map((t) => mapThread(t, []))
    },
    async getThread(threadId) {
      const [t, events] = await Promise.all([view(threadId), timeline(threadId)])
      return mapThread(t, events)
    },
    async listMessages(threadId) {
      const [t, events] = await Promise.all([view(threadId), timeline(threadId)])
      return readMessages(t, events)
    },
    async createThread(input) {
      const agent = await agentFor({ node_id: input.deviceId, agent_type: input.agent })
      if (!canCreateAgent(agent)) throw new ClientError('invalid', agentUnavailableReason(agent))
      const messageId = uuid('create-message', input.clientId)
      const t = await ctx.request<ThreadDTO>(
        base,
        post({
          client_thread_id: uuid('create-thread', input.clientId),
          node_id: input.deviceId,
          agent_type: input.agent,
          model: input.model,
          execution_timeout_seconds: input.executionTimeoutSeconds,
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
      const agent = await agentFor(t)
      if (!agent.abilities.switchModel) throw new ClientError('invalid', 'This agent does not support changing models.')
      const updated = await ctx.request<ThreadDTO>(`${threadPath(threadId)}/model`, post({ model }))
      ctx.emit('threads')
      return mapThread(updated, await timeline(threadId))
    },
    async setThreadExecutionLimit({ threadId, executionTimeoutSeconds }) {
      const updated = await ctx.request<ThreadDTO>(`${threadPath(threadId)}/settings`, {
        method: 'PATCH',
        body: JSON.stringify({ execution_timeout_seconds: executionTimeoutSeconds }),
      })
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
    async readTrace(messageId, cursor): Promise<Trace> {
      let reply = replies.get(messageId)
      if (!reply) {
        const parts = messageId.split(':')
        if (['reply', 'turn-activity', 'turn-failed'].includes(parts[0]) && parts[1]) await api.listMessages(parts[1])
        reply = replies.get(messageId)
      }
      if (!reply) throw new ClientError('notFound', 'The reply was not found.')
      const query = new URLSearchParams({ worker_turn_seq: String(reply.seq) })
      if (cursor !== undefined) query.set('cursor', cursor)
      const result = await ctx.request<ThreadTrace>(`${threadPath(reply.threadId)}/trace?${query}`)
      if (!result.ok) {
        if (result.code === 'trace_missing') return { state: 'unavailable', messageId, reason: 'missing' }
        unavailable('Could not load this activity. Try again.')
      }
      const steps = result.steps ?? unavailable('The activity record is incomplete. Try again.')
      if (result.next_cursor !== undefined && (!result.next_cursor || result.next_cursor === cursor))
        unavailable('Could not load the next activity page. Try again.')
      return { state: 'ready', messageId, steps: [...steps], nextCursor: result.next_cursor }
    },
    readOutput: (id) => output.readOutput(id),
    async listFolders(deviceId, path): Promise<FolderListing> {
      try {
        const connection = (await ctx.devices()).find((device) => device.id === deviceId)?.connection
        if (connection === 'offline' || connection === 'syncing')
          return { state: 'unavailable', deviceId, path, reason: connection }
        if (path == null) {
          const result = await roots(deviceId)
          return {
            state: 'ready',
            deviceId,
            path,
            folders: result.entries.map((root) => root.path),
            files: [],
            scanLimited: result.scanLimited,
          }
        }
        const folders: string[] = []
        const files: { path: string; size: number }[] = []
        let scanLimited = false
        const cursors = new Set<string>()
        let cursor = ''
        do {
          let result: FileDTO | null
          try {
            result = await browse(deviceId, path, cursor)
          } catch (error) {
            if (!cursor) throw error
            scanLimited = true
            break
          }
          if (cursor && (!result || result.kind !== 'directory')) {
            scanLimited = true
            break
          }
          if (!result) return { state: 'unavailable', deviceId, path, reason: 'outsideFolders' }
          if (result.kind !== 'directory') return { state: 'unavailable', deviceId, path, reason: 'missing' }
          for (const entry of result.entries ?? []) {
            const child = joinFilePath(path, entry.name)
            if (entry.kind === 'directory') folders.push(child)
            else if (entry.kind === 'file' && entry.size != null) files.push({ path: child, size: entry.size })
          }
          cursor = result.next_cursor ?? ''
          if (cursor && cursors.has(cursor)) {
            scanLimited = true
            break
          }
          cursors.add(cursor)
          scanLimited ||= !cursor && (result.remainder?.scan_limited === true || result.truncated)
        } while (cursor)
        return { state: 'ready', deviceId, path, folders, files, scanLimited }
      } catch (error) {
        const reason = fileReason(error)
        if (reason && reason !== 'binary') return { state: 'unavailable', deviceId, path, reason }
        throw error
      }
    },
    async readFile(deviceId, path, continuation): Promise<FilePreview> {
      try {
        const connection = (await ctx.devices()).find((device) => device.id === deviceId)?.connection
        if (connection === 'offline' || connection === 'syncing')
          return { state: 'unavailable', deviceId, path, reason: connection, size: null }
        if (
          continuation &&
          (!Number.isSafeInteger(continuation.offset) || continuation.offset < 0 || !continuation.version)
        )
          throw new ClientError('invalid', 'Continue reading with a valid offset and file version.')
        const result = await browse(deviceId, path, '', continuation)
        if (!result) return { state: 'unavailable', deviceId, path, reason: 'outsideFolders', size: null }
        if (result.kind !== 'file')
          return { state: 'unavailable', deviceId, path, reason: 'missing', size: result.size ?? null }
        if (result.size == null || result.content == null || result.offset == null || !result.version)
          return unavailable('The device returned an incomplete file preview.')
        if (continuation && result.version !== continuation.version)
          throw new ClientError('conflict', 'The file changed. Reload it to continue reading.')
        const bytes = new TextEncoder().encode(result.content).length
        if (
          result.offset !== (continuation?.offset ?? 0) ||
          bytes > previewLimit ||
          (result.next_offset != null && (bytes === 0 || result.next_offset !== result.offset + bytes))
        )
          return unavailable('The device returned an invalid file fragment.')
        return {
          state: 'ready',
          deviceId,
          path,
          size: result.size,
          content: result.content,
          truncated: result.truncated,
          offset: result.offset,
          version: result.version,
          nextOffset: result.next_offset,
        }
      } catch (error) {
        const reason = fileReason(error)
        if (errorCode(error) === 'file_changed')
          throw new ClientError('conflict', 'The file changed. Reload it to continue reading.')
        if (reason) return { state: 'unavailable', deviceId, path, reason, size: null }
        throw error
      }
    },
  }
  return api
}
