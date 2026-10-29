import type { ProjectMemory, MemoryRevision, MemoryWorkStatus, ProjectMessageReference } from '@baton/protocol'
import { ClientError, type BatonClient } from '../client'
import { shortenExcerpt } from '../derive'
import type { InboxItem, MemoryNote, ProcessStep, Project, ProjectEntry, Reference } from '../types'
import { apiPath, timestamp, type HttpContext } from './context'
import { HttpError } from './transport'

type ProjectAPI = Pick<
  BatonClient,
  | 'listProjects'
  | 'getProject'
  | 'listProjectEntries'
  | 'readProjectTimeline'
  | 'listProjectMemory'
  | 'getMemoryStatus'
  | 'createProject'
  | 'sendProjectMessage'
  | 'updateProject'
  | 'setProjectStatus'
  | 'saveMemory'
  | 'changeMemory'
  | 'memorySources'
  | 'stopProjectRun'
  | 'retryProject'
  | 'listInbox'
  | 'handleItem'
>

interface ProjectDTO {
  id: string
  title: string
  emoji?: string
  goal: string
  status: Project['status']
  created_at: string
  updated_at: string
  agent: { provider: string; model: string; source_node_id?: string }
  memory_embedding: Project['memoryEmbedding']
  conversation: { id: string; state: string; last_seq: number }
}
interface StatusDTO {
  state: string
  waiting_reason?: string
  last_error?: string | null
  last_seq: number
  pending_inputs: number
  run?: {
    id?: string
    state?: string
    node_id: string
    effective: boolean
    end_reason?: string
    stop_acked_at?: string
  }
  preview?: { after_seq: number; text: string; truncated?: boolean }
}
interface MessageDTO {
  id: number
  client_message_id: string
  content: string
  reference?: ProjectMessageReference | null
  created_at: string
}
interface Block {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  arguments?: Record<string, unknown>
}
interface EventDTO {
  conversation_id: string
  seq: number
  kind: string
  run_id?: string | null
  tool_call_id?: string
  created_at: string
  payload: {
    format?: string
    summary?: string
    message?: {
      content: Block[] | string
      toolCallId?: string
      toolName?: string
      isError?: boolean
    }
  }
}
interface InputDTO {
  id: number
  source_type: string
  source_key: string
  payload: Record<string, unknown>
}
type MemoryDTO = ProjectMemory
type MemoryRevisionDTO = MemoryRevision
interface InboxDTO {
  id: string
  project_id: string
  thread_id?: string
  source: 'agent' | 'system'
  title: string
  content: string
  options: { id: string; label: string; recommended?: boolean }[] | null
  allow_text: boolean
  state: 'open' | 'answered' | 'closed' | 'withdrawn' | 'resolved'
  version: number
  resolution?: { client_request_id?: string; employee_id: string; option_label?: string; text?: string }
  resolved_at?: string
  withdraw_reason?: string
  created_at: string
}

const root = '/projects'
const projectPath = (id: string) => `${root}/${apiPath(id)}`
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) })
const subscription = (value: string) => ({ 'openai-codex': 'ChatGPT', xai: 'xAI', anthropic: 'Claude' })[value] ?? value
const projectReasons: Record<string, string> = {
  retry_backoff: '等待重试',
  model_not_configured: '尚未配置模型',
  all_devices_offline: '所有设备已离线',
  waiting_sync: '等待设备同步',
  runtime_missing: '设备未安装项目助手',
  login_required: '需要登录模型账号',
  capacity: '等待设备空闲',
  scheduling: '正在分配设备',
  device_unavailable: '设备不可用',
  model_request_failed: '模型请求失败',
  model_call_budget_exhausted: '模型调用次数已用完',
  start_failed: '助手启动失败',
}
const projectReason = (value: string | null | undefined) =>
  value ? (Object.hasOwn(projectReasons, value) ? projectReasons[value]! : value) : null
function provider(value: string): string {
  const id = { ChatGPT: 'openai-codex', xAI: 'xai', Claude: 'anthropic' }[value] ?? value.trim()
  if (!/^[a-z0-9-]{1,64}$/.test(id)) throw new ClientError('invalid', '请输入服务商 ID。')
  return id
}

// UUID v5 的命名空间固定，重试、刷新和队列领取后都得到同一标识。
async function stableId(value: string): Promise<string> {
  if (/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)) return value.toLowerCase()
  const namespace = Uint8Array.from([
    0x6b, 0xa7, 0xb8, 0x11, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0, 0xc0, 0x4f, 0xd4, 0x30, 0xc8,
  ])
  const name = new TextEncoder().encode(`baton:${value}`)
  const bytes = new Uint8Array(namespace.length + name.length)
  bytes.set(namespace)
  bytes.set(name, namespace.length)
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes)).slice(0, 16)
  hash[6] = (hash[6] & 15) | 80
  hash[8] = (hash[8] & 63) | 128
  const hex = Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function parseObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}
function text(content: Block[] | string | undefined): string {
  return typeof content === 'string'
    ? content
    : (content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('\n')
}

function messageReference(reference?: Reference | null): ProjectMessageReference | undefined {
  if (!reference) return undefined
  const shortened = shortenExcerpt(reference.excerpt)
  return { ...reference, excerpt: shortened.excerpt, bytes: Math.max(reference.bytes, shortened.bytes) }
}

export function mapProject(p: ProjectDTO, status: StatusDTO): Project {
  let state: Project['agent']['state'] = 'idle'
  if (p.status === 'archived') state = 'stopped'
  else if (status.state === 'needs_attention' || p.conversation.state === 'needs_attention') state = 'blocked'
  else if (p.status === 'paused') state = 'idle'
  else if (status.run?.end_reason === 'user_stopped' && !status.run.effective && !status.run.stop_acked_at)
    state = 'stopping'
  else if (status.state === 'running' || status.state === 'starting') state = 'running'
  else if (status.state === 'waiting') state = 'waitingDevice'
  else if (status.run?.end_reason === 'user_stopped') state = 'stopped'
  else if (status.last_seq === 0 && status.pending_inputs === 0) state = 'notStarted'
  return {
    id: p.id,
    name: p.title,
    emoji: p.emoji ?? '📁',
    hue: 'slate',
    status: p.status,
    archivedAt: p.status === 'archived' ? timestamp(p.updated_at) : null,
    goal: p.goal,
    subscription: subscription(p.agent.provider),
    sourceNodeId: p.agent.source_node_id ?? null,
    model: p.agent.model,
    memoryEmbedding: p.memory_embedding,
    agent: {
      state,
      deviceId: status.run?.node_id ?? null,
      reason:
        state === 'blocked'
          ? projectReason(status.last_error)
          : state === 'waitingDevice'
            ? p.agent.source_node_id
              ? '等待所选 API 连接'
              : projectReason(status.waiting_reason ?? status.last_error)
            : null,
      activity: null,
      lastSeq: status.last_seq,
      runId: status.run?.id,
      runState: status.run?.state,
      preview:
        state === 'running' && status.preview?.after_seq === status.last_seq && status.preview.text
          ? {
              afterSeq: status.preview.after_seq,
              text: status.preview.text,
              truncated: status.preview.truncated ?? false,
            }
          : null,
    },
    createdAt: timestamp(p.created_at),
  }
}

export function mapInboxItem(item: InboxDTO): InboxItem {
  const recommended = (item.options ?? []).findIndex((option) => option.recommended)
  return {
    id: item.id,
    projectId: item.project_id,
    threadId: item.thread_id || null,
    kind: item.source === 'system' ? 'system' : 'question',
    title: item.title,
    body: item.content,
    options: (item.options ?? []).map((option) => option.label),
    recommended: recommended < 0 ? null : recommended,
    allowText: item.allow_text,
    status: item.state === 'open' ? 'pending' : item.state,
    result:
      item.resolution || item.resolved_at
        ? {
            option: item.resolution?.option_label ?? null,
            note: item.resolution?.text ?? '',
            actor: item.resolution?.employee_id ?? '',
            at: timestamp(item.resolved_at),
            reason: item.withdraw_reason || null,
            inputId: null,
          }
        : null,
    revision: item.version,
    createdAt: timestamp(item.created_at),
  }
}

function mapMemory(projectId: string, note: MemoryDTO, revisions: MemoryRevisionDTO[]): MemoryNote {
  const versions = revisions.map((revision) => ({
    version: revision.revision,
    body: revision.content,
    source: revision.author === 'user' ? ('you' as const) : ('assistant' as const),
    updatedAt: timestamp(revision.updated_at),
    details: {
      action: revision.action,
      reason: revision.reason,
      validFrom: revision.valid_from,
      validUntil: revision.valid_until,
      retracted: revision.retracted,
      evidence: revision.evidence,
    },
  }))
  if (!versions.some((version) => version.version === note.revision))
    versions.push({
      version: note.revision,
      body: note.content,
      source: note.author === 'user' ? 'you' : 'assistant',
      updatedAt: timestamp(note.updated_at),
      details: {
        action: note.action,
        reason: note.reason,
        validFrom: note.valid_from,
        validUntil: note.valid_until,
        retracted: note.retracted,
        evidence: note.evidence,
      },
    })
  versions.sort((a, b) => a.version - b.version)
  return {
    id: note.id,
    projectId,
    ...versions[versions.length - 1],
    versions,
    status: note.status,
    effective: note.effective,
    topic: note.topic,
    suppressionId: note.suppression_id,
    evidence: note.evidence,
  }
}

async function userEntry(
  projectId: string,
  clientId: string,
  content: string,
  createdAt: string,
  delivered: boolean,
  reference?: ProjectMessageReference | null,
): Promise<ProjectEntry> {
  return {
    id: await stableId(`project-message:${projectId}:${clientId}`),
    projectId,
    createdAt: timestamp(createdAt),
    kind: 'user',
    delivery: delivered ? 'delivered' : 'saved',
    body: content,
    reference: reference ?? null,
  }
}

export async function mapProjectEntries(
  projectId: string,
  events: EventDTO[],
  pending: MessageDTO[],
): Promise<ProjectEntry[]> {
  const entries: ProjectEntry[] = []
  const delivered = new Set<string>()
  const calls = new Map<
    string,
    { entry: Extract<ProjectEntry, { kind: 'assistant' }>; block: Block; step: Extract<ProcessStep, { kind: 'tool' }> }
  >()
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    const base = {
      id: await stableId(`project-event:${event.conversation_id}:${event.seq}`),
      projectId,
      createdAt: timestamp(event.created_at),
      sourceSeq: event.seq,
    }
    const message = event.payload.message
    if (event.kind === 'input') {
      let inputs: InputDTO[] = []
      try {
        const value: unknown = JSON.parse(text(message?.content))
        if (Array.isArray(value)) inputs = value
      } catch {
        /* 未识别的输入保留原文。 */
      }
      if (inputs.length === 0 && text(message?.content))
        entries.push({ ...base, kind: 'note', body: text(message?.content) })
      for (const input of inputs) {
        if (input.source_type === 'user_message' && typeof input.payload.content === 'string') {
          const clientId = input.source_key.slice('user:'.length)
          delivered.add(clientId)
          entries.push({
            ...(await userEntry(
              projectId,
              clientId,
              input.payload.content,
              event.created_at,
              true,
              input.payload.reference as ProjectMessageReference | null | undefined,
            )),
            sourceSeq: event.seq,
          })
        } else {
          const inputBase = { ...base, id: await stableId(`project-input:${projectId}:${input.id}`) }
          if (
            (input.source_type === 'thread_reply' ||
              (input.source_type === 'turn_ended' && Number(input.payload.reply_count) > 0)) &&
            typeof input.payload.thread_id === 'string'
          ) {
            entries.push({
              ...inputBase,
              kind: 'assistant',
              body: typeof input.payload.content === 'string' ? input.payload.content : '',
              process: input.payload.command_result
                ? [{ kind: 'note', body: JSON.stringify(input.payload.command_result) }]
                : [],
              threads: { action: 'replies', threadIds: [input.payload.thread_id] },
            })
          } else
            entries.push({ ...inputBase, kind: 'note', body: `${input.source_type}\n${JSON.stringify(input.payload)}` })
        }
      }
    } else if (event.kind === 'assistant' && message) {
      const entry: Extract<ProjectEntry, { kind: 'assistant' }> = {
        ...base,
        kind: 'assistant',
        streamAnchor: event.seq - 1,
        runId: event.run_id ?? undefined,
        body: text(message.content),
        process: [],
        threads: null,
      }
      for (const block of typeof message.content === 'string' ? [] : message.content) {
        if (block.type !== 'toolCall' || !block.id) continue
        const step: Extract<ProcessStep, { kind: 'tool' }> = {
          kind: 'tool',
          name: block.name || '工具',
          input: JSON.stringify(block.arguments ?? {}, null, 2),
          output: null,
          status: 'pending',
        }
        calls.set(block.id, { entry, block, step })
        entry.process.push(step)
      }
      entries.push(entry)
    } else if (event.kind === 'tool_result' && message) {
      const call = calls.get(message.toolCallId ?? event.tool_call_id ?? '')
      const output = text(message.content)
      if (!call) {
        entries.push({ ...base, kind: 'note', body: `${message.toolName ?? ''}\n${output}` })
        continue
      }
      call.step.output = output
      call.step.status = message.isError ? 'failed' : 'completed'
      const result = parseObject(output)
      const name = call.block.name
      if (
        !message.isError &&
        result &&
        typeof result.thread_id === 'string' &&
        (name === 'threads.create' || name === 'threads.send')
      ) {
        const action = name === 'threads.create' ? 'opened' : 'messaged'
        if (!call.entry.threads || call.entry.threads.action === action) {
          call.entry.threads ??= { action, threadIds: [] }
          if (!call.entry.threads.threadIds.includes(result.thread_id))
            call.entry.threads.threadIds.push(result.thread_id)
        } else {
          entries.push({
            ...base,
            kind: 'assistant',
            body: '',
            process: [],
            threads: { action, threadIds: [result.thread_id] },
          })
        }
      }
    } else if (event.kind === 'compaction' && event.payload.summary)
      entries.push({ ...base, kind: 'note', body: event.payload.summary })
  }
  for (const message of pending) {
    if (!delivered.has(message.client_message_id))
      entries.push(
        await userEntry(
          projectId,
          message.client_message_id,
          message.content,
          message.created_at,
          false,
          message.reference,
        ),
      )
  }
  return entries.sort((a, b) => a.createdAt - b.createdAt)
}

function conflict(error: unknown): { payload?: Record<string, unknown> } | null {
  if (error instanceof HttpError) return error.status === 409 ? { payload: error.payload } : null
  const seen = new Set<unknown>()
  let current = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const value = current as { status?: number; payload?: Record<string, unknown>; code?: string; cause?: unknown }
    if (value.status === 409) return { payload: value.payload }
    if (value.cause) current = value.cause
    else return value.code === 'conflict' ? {} : null
  }
  return null
}

export function createProjectAPI(ctx: HttpContext): ProjectAPI {
  const inbox = new Map<string, InboxDTO>()
  const rememberItem = (item: InboxDTO): InboxDTO => {
    const previous = inbox.get(item.id)
    if (previous && previous.version > item.version) return previous
    inbox.set(item.id, item)
    return item
  }
  const enrich = async (p: ProjectDTO) => mapProject(p, await ctx.request<StatusDTO>(`${projectPath(p.id)}/status`))
  async function readMemory(projectId: string, note: MemoryDTO): Promise<MemoryNote> {
    const revisions: MemoryRevisionDTO[] = []
    let after = 0
    do {
      const page = await ctx.request<{ revisions: MemoryRevisionDTO[]; next_after_revision?: number }>(
        `${projectPath(projectId)}/memory/${apiPath(note.id)}/revisions?limit=100&after_revision=${after}`,
      )
      revisions.push(...page.revisions)
      const next = page.next_after_revision ?? 0
      if (next && next <= after) throw new ClientError('unavailable', '记忆版本分页未推进')
      after = next
    } while (after)
    return mapMemory(projectId, note, revisions)
  }
  const readProject = async (id: string) => enrich(await ctx.request<ProjectDTO>(projectPath(id)))
  async function readProjectTimeline(projectId: string) {
    const events: EventDTO[] = []
    let seq = 0
    let more: boolean
    do {
      const page = await ctx.request<{ events: EventDTO[]; next_after_seq: number; has_more: boolean }>(
        `${projectPath(projectId)}/events?limit=100&after_seq=${seq}`,
      )
      events.push(...page.events)
      more = page.has_more
      if (more && page.next_after_seq <= seq) throw new ClientError('unavailable', '事件分页未推进')
      seq = page.next_after_seq
    } while (more)
    const messages: MessageDTO[] = []
    let after = 0
    do {
      const page = await ctx.request<{ messages: MessageDTO[]; next_after_id?: number }>(
        `${projectPath(projectId)}/messages?limit=100&after_id=${after}`,
      )
      messages.push(...page.messages)
      const next = page.next_after_id ?? 0
      if (next && next <= after) throw new ClientError('unavailable', '消息分页未推进')
      after = next
    } while (after)
    return {
      entries: await mapProjectEntries(projectId, events, messages),
      anchors: Object.fromEntries(events.map((event) => [event.seq, timestamp(event.created_at)])),
      lastSeq: seq,
    }
  }
  const emit = () => ctx.emit('projects', 'inbox', 'messages', 'threads')
  async function patch(id: string, body: unknown) {
    const p = await ctx.request<ProjectDTO>(projectPath(id), json('PATCH', body))
    emit()
    return enrich(p)
  }
  async function runAction(id: string, action: 'retry' | 'stop') {
    await ctx.request(`${projectPath(id)}/${action}`, json('POST', {}))
    emit()
    return readProject(id)
  }
  return {
    getProject: readProject,
    async listProjects() {
      const all: ProjectDTO[] = []
      let after = ''
      do {
        const page = await ctx.request<{ projects: ProjectDTO[] | null; next_after_id?: string }>(
          `${root}?limit=100${after ? `&after_id=${apiPath(after)}` : ''}`,
        )
        all.push(...(page.projects ?? []))
        const next = page.next_after_id ?? ''
        if (next && next <= after) throw new ClientError('unavailable', '项目分页未推进')
        after = next
      } while (after)
      return Promise.all(all.map(enrich))
    },
    readProjectTimeline,
    async listProjectEntries(projectId) {
      return (await readProjectTimeline(projectId)).entries
    },
    async listProjectMemory(projectId) {
      const notes: MemoryDTO[] = []
      let after = ''
      do {
        const page = await ctx.request<{ entries: MemoryDTO[] | null; next_after_id?: string }>(
          `${projectPath(projectId)}/memory?include_inactive=true&limit=100${after ? `&after_id=${apiPath(after)}` : ''}`,
        )
        notes.push(...(page.entries ?? []))
        const next = page.next_after_id ?? ''
        if (next && next <= after) throw new ClientError('unavailable', '记忆分页未推进')
        after = next
      } while (after)
      return Promise.all(notes.map((note) => readMemory(projectId, note)))
    },
    async createProject(input) {
      const body = {
        title: input.name,
        ...(input.emoji ? { emoji: input.emoji } : {}),
        goal: input.goal,
        provider: provider(input.subscription),
        ...(input.sourceNodeId ? { source_node_id: input.sourceNodeId } : {}),
        model: input.model,
        client_project_id: await stableId(input.clientId),
      }
      const p = await ctx.request<ProjectDTO>(root, json('POST', body))
      emit()
      return enrich(p)
    },
    async sendProjectMessage(input) {
      const clientId = await stableId(input.clientId)
      const result = await ctx.request<MessageDTO>(
        `${projectPath(input.projectId)}/messages`,
        json('POST', {
          client_message_id: clientId,
          content: input.body,
          reference: messageReference(input.reference),
        }),
      )
      emit()
      return userEntry(
        input.projectId,
        result.client_message_id,
        result.content,
        result.created_at,
        false,
        result.reference,
      )
    },
    updateProject: async ({ projectId, patch: changes }) =>
      patch(projectId, {
        ...(changes.name !== undefined ? { title: changes.name } : {}),
        ...(changes.emoji !== undefined ? { emoji: changes.emoji } : {}),
        ...(changes.goal !== undefined ? { goal: changes.goal } : {}),
        ...(changes.subscription !== undefined ? { provider: provider(changes.subscription) } : {}),
        ...(changes.sourceNodeId !== undefined ? { source_node_id: changes.sourceNodeId } : {}),
        ...(changes.model !== undefined ? { model: changes.model } : {}),
        ...(changes.memoryEmbedding !== undefined
          ? {
              memory_embedding: changes.memoryEmbedding
                ? {
                    base_url: changes.memoryEmbedding.base_url.trim(),
                    model: changes.memoryEmbedding.model.trim(),
                    ...(changes.memoryEmbedding.credential_profile?.trim()
                      ? { credential_profile: changes.memoryEmbedding.credential_profile.trim() }
                      : {}),
                  }
                : null,
            }
          : {}),
      }),
    setProjectStatus: ({ projectId, status }) => patch(projectId, { status }),
    async saveMemory(input) {
      const id = input.noteId ?? (await stableId(`memory:${input.projectId}:${input.clientId}`))
      const path = `${projectPath(input.projectId)}/memory/${apiPath(id)}`
      const current = input.noteId ? await ctx.request<MemoryDTO>(path) : null
      const title =
        current?.title ??
        Array.from(
          input.body
            .trim()
            .split('\n')[0]
            .replace(/\p{Cc}/gu, ' ')
            .trim() || '记忆',
        )
          .slice(0, 200)
          .join('')
      try {
        const note = await ctx.request<MemoryDTO>(
          path,
          json('PUT', {
            title,
            content: input.body,
            expected_revision: input.version ?? 0,
            operation_id: await stableId(input.clientId),
          }),
        )
        ctx.emit('projects')
        return { state: 'saved', note: await readMemory(input.projectId, note) }
      } catch (error) {
        const clash = conflict(error)
        if (!clash) throw error
        const latest = await ctx.request<MemoryDTO>(path)
        ctx.emit('projects')
        return { state: 'conflict', note: await readMemory(input.projectId, latest) }
      }
    },
    async changeMemory(input) {
      const path = `${projectPath(input.projectId)}/memory/${apiPath(input.noteId)}`
      try {
        const note = await ctx.request<MemoryDTO>(
          path + '/changes',
          json('POST', {
            operation_id: await stableId(input.clientId),
            expected_revision: input.version,
            action: input.action,
            ...(input.action === 'restore' ? { suppression_id: input.suppressionId } : {}),
          }),
        )
        ctx.emit('projects')
        return { state: 'saved', note: await readMemory(input.projectId, note) }
      } catch (error) {
        const clash = conflict(error)
        if (!clash || (clash.payload?.code && clash.payload.code !== 'memory_conflict')) throw error
        return { state: 'conflict', note: await readMemory(input.projectId, await ctx.request<MemoryDTO>(path)) }
      }
    },
    getMemoryStatus: (projectId) => ctx.request<MemoryWorkStatus>(`${projectPath(projectId)}/memory/status`),
    async memorySources(projectId, note) {
      const ids = [
        ...new Set(
          [...note.evidence, ...note.versions.flatMap((version) => version.details?.evidence ?? [])].map(
            (ref) => ref.source_id,
          ),
        ),
      ]
      return Promise.all(
        ids.map(async (id) => {
          const path = `${projectPath(projectId)}/memory/sources/${apiPath(id)}`
          let offset = 0
          let text = ''
          let source: import('../types').MemorySourceView
          let more: boolean
          do {
            const page = await ctx.request<
              import('../types').MemorySourceView & { next_offset: number; has_more: boolean }
            >(path + '?offset=' + offset + '&max_bytes=32768')
            source = page
            text += page.text
            more = page.has_more
            if (more && page.next_offset <= offset) throw new ClientError('unavailable', '来源分页未推进')
            offset = page.next_offset
          } while (more)
          return { ...source!, text }
        }),
      )
    },
    stopProjectRun: (id) => runAction(id, 'stop'),
    retryProject: (id) => runAction(id, 'retry'),
    async listInbox() {
      const items: InboxItem[] = []
      let cursor = ''
      const seen = new Set<string>()
      do {
        const page = await ctx.request<{ requests: InboxDTO[]; next_cursor?: string }>(
          `/inbox?state=all${cursor ? `&cursor=${apiPath(cursor)}` : ''}`,
        )
        for (const item of page.requests) items.push(mapInboxItem(rememberItem(item)))
        cursor = page.next_cursor ?? ''
        if (cursor && seen.has(cursor)) throw new ClientError('unavailable', '待处理事项分页未推进')
        seen.add(cursor)
      } while (cursor)
      return items
    },
    async handleItem(input) {
      const path = `/attention-requests/${apiPath(input.itemId)}`
      const item = inbox.get(input.itemId) ?? (await ctx.request<InboxDTO>(path))
      const finish = (value: InboxDTO, phase: 'done' | 'conflict') => {
        const current = rememberItem(value)
        const result = mapInboxItem(current).result
        const detail =
          phase === 'conflict'
            ? [current.state, result?.option, result?.note, result?.actor, result?.reason].filter(Boolean).join(' · ')
            : null
        const operation = ctx.operation('answerItem', input.itemId, phase, detail)
        emit()
        ctx.emit('operations')
        return operation
      }
      const decision = input.decision
      const clientRequestId = await stableId(
        `attention:${input.itemId}:${input.revision}:${JSON.stringify(decision.kind === 'close' ? ['close'] : ['answer', decision.option, decision.note])}`,
      )
      if (item.resolution?.client_request_id === clientRequestId) return finish(item, 'done')
      if (item.version !== input.revision || item.state !== 'open') return finish(item, 'conflict')
      const option =
        decision.kind === 'answer' && decision.option !== null
          ? (item.options ?? []).filter((option) => option.label === decision.option)
          : []
      if (decision.kind === 'answer' && decision.option !== null && option.length !== 1)
        throw new ClientError('invalid', '所选选项不可用或不明确')
      const body = {
        expected_version: input.revision,
        client_request_id: clientRequestId,
        ...(decision.kind === 'answer' ? { option_id: option[0]?.id ?? '', text: decision.note } : {}),
      }
      try {
        return finish(
          await ctx.request<InboxDTO>(`${path}/${decision.kind === 'close' ? 'close' : 'answer'}`, json('POST', body)),
          'done',
        )
      } catch (error) {
        const clash = conflict(error)
        if (!clash) throw error
        const current = clash.payload?.current as InboxDTO | undefined
        return finish(current ?? (await ctx.request<InboxDTO>(path)), 'conflict')
      }
    },
  }
}
