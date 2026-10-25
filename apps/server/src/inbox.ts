import { randomUUID } from 'node:crypto'
import { Effect, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as P from '@baton/protocol'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import { AppError } from './errors.ts'
import { transaction } from './database.ts'
import { strictDecode } from './project/memory.ts'
import { insertProjectInput } from './project/inputs.ts'

export interface InboxBinding {
  employeeId: string
  projectId: string
  agentId: string
  conversationId: string
}
interface MarkdownNode {
  type: string
  url?: string
  identifier?: string
  children?: readonly MarkdownNode[]
}
const validLink = (url: string) => {
  try {
    const parsed = new URL(url)
    return (
      ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && Boolean(parsed.hostname)) ||
      (parsed.protocol === 'mailto:' && Boolean(parsed.pathname.trim()))
    )
  } catch {
    return false
  }
}
export function validInboxMarkdown(content: string): boolean {
  if (Buffer.byteLength(content) > 32768 || content.includes('\0')) return false
  const root = fromMarkdown(content, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  const definitions = new Map<string, string>()
  const links: string[] = []
  const refs: string[] = []
  const walk = (node: MarkdownNode) => {
    if (node.type === 'definition' && node.identifier && node.url && !definitions.has(node.identifier))
      definitions.set(node.identifier, node.url)
    if (node.type === 'link' && node.url !== undefined) links.push(node.url)
    if (node.type === 'linkReference' && node.identifier) refs.push(node.identifier)
    for (const child of node.children ?? []) walk(child)
  }
  walk(root)
  return links.every(validLink) && refs.every((id) => validLink(definitions.get(id) ?? ''))
}
const validAsk = Effect.fnUntraced(function* (input: unknown) {
  const a = yield* strictDecode(P.InboxAsk, input)
  const options = a.options ?? []
  if (
    !a.title.trim() ||
    (!options.length && !a.allow_text) ||
    options.filter((o) => o.recommended).length > 1 ||
    options.some((o) => !o.label.trim()) ||
    !validInboxMarkdown(a.content)
  )
    return yield* Effect.fail(new AppError(422, 'invalid_inbox_request'))
  return { ...a, options }
})

const readRequest = Effect.fnUntraced(function* (employeeId: string, id: string) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    value: P.AttentionRequest
  }>`SELECT jsonb_strip_nulls(to_jsonb(r)-'employee_id'-'agent_id'-'summary') || jsonb_build_object('project_title',p.title) AS value FROM attention_requests r JOIN projects p ON p.id=r.project_id AND p.employee_id=r.employee_id WHERE r.employee_id=${employeeId} AND r.id=${id}`
  if (!rows.length) return yield* Effect.fail(new AppError(404, 'not_found'))
  return yield* Schema.decodeUnknownEffect(P.AttentionRequest)(rows[0]!.value).pipe(
    Effect.mapError(() => new AppError(503, 'invalid_inbox_record')),
  )
})
export const getAttentionRequest = (employeeId: string, id: string) =>
  transaction(
    Effect.gen(function* () {
      yield* strictDecode(P.UUID, id)
      return yield* readRequest(employeeId, id)
    }),
  )
const lockRequest = Effect.fnUntraced(function* (employeeId: string, id: string) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT id FROM attention_requests WHERE employee_id=${employeeId} AND id=${id} FOR UPDATE`
  if (!rows.length) return yield* Effect.fail(new AppError(404, 'not_found'))
  return yield* readRequest(employeeId, id)
})
const createAgentAttentionTx = Effect.fnUntraced(function* (b: InboxBinding, callId: string, input: unknown) {
  const sql = yield* SqlClient.SqlClient
  const a = yield* validAsk(input)
  const binding =
    yield* sql`SELECT a.id FROM project_agents a JOIN conversations c ON c.agent_id=a.id AND c.employee_id=a.employee_id WHERE a.employee_id=${b.employeeId} AND a.project_id=${b.projectId} AND a.id=${b.agentId} AND c.id=${b.conversationId} FOR NO KEY UPDATE OF a`
  if (!binding.length) return yield* Effect.fail(new AppError(404, 'not_found'))
  const old = yield* sql<{
    id: string
  }>`SELECT id FROM attention_requests WHERE employee_id=${b.employeeId} AND project_id=${b.projectId} AND conversation_id=${b.conversationId} AND origin_tool_call_id=${callId}`
  if (old.length) return yield* readRequest(b.employeeId, old[0]!.id)
  if (a.thread_id) {
    const related =
      yield* sql`SELECT id FROM threads WHERE employee_id=${b.employeeId} AND project_id=${b.projectId} AND id=${a.thread_id}`
    if (!related.length) return yield* Effect.fail(new AppError(404, 'not_found'))
  }
  const duplicate = yield* sql<{
    id: string
  }>`SELECT id FROM attention_requests WHERE employee_id=${b.employeeId} AND project_id=${b.projectId} AND source='agent' AND state='open' AND thread_id IS NOT DISTINCT FROM ${a.thread_id ?? null}::uuid AND title=${a.title} AND content=${a.content} AND options=${JSON.stringify(a.options)}::jsonb AND allow_text=${a.allow_text} ORDER BY created_at,id LIMIT 1`
  const existing = duplicate[0]
  if (existing) return yield* readRequest(b.employeeId, existing.id)
  const id = randomUUID()
  yield* sql`INSERT INTO attention_requests(id,employee_id,project_id,agent_id,conversation_id,origin_tool_call_id,source,thread_id,title,content,options,allow_text) VALUES(${id},${b.employeeId},${b.projectId},${b.agentId},${b.conversationId},${callId},'agent',${a.thread_id ?? null},${a.title},${a.content},${JSON.stringify(a.options)}::jsonb,${a.allow_text})`
  return yield* readRequest(b.employeeId, id)
})
export const createAgentAttention = (b: InboxBinding, callId: string, input: unknown) =>
  transaction(createAgentAttentionTx(b, callId, input))
const withdrawAttentionTx = Effect.fnUntraced(function* (b: InboxBinding, id: string, reason: string) {
  const sql = yield* SqlClient.SqlClient
  yield* strictDecode(
    Schema.String.check(
      Schema.isBetweenCodePoints(1, 200),
      Schema.makeFilter((s) => Boolean(s.trim()) && !s.includes('\0')),
    ),
    reason,
  )
  const current = yield* lockRequest(b.employeeId, id)
  if (current.project_id !== b.projectId) return yield* Effect.fail(new AppError(404, 'not_found'))
  if (current.source !== 'agent') return yield* Effect.fail(new AppError(422, 'system_request'))
  if (current.state !== 'open') return current
  yield* sql`UPDATE attention_requests SET state='withdrawn',version=version+1,withdraw_reason=${reason},resolved_at=clock_timestamp(),updated_at=clock_timestamp() WHERE employee_id=${b.employeeId} AND id=${id}`
  return yield* readRequest(b.employeeId, id)
})
export const withdrawAttention = (b: InboxBinding, id: string, reason: string) =>
  transaction(withdrawAttentionTx(b, id, reason))
export const listProjectAttention = Effect.fnUntraced(function* (b: InboxBinding, afterId?: string) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    id: string
  }>`SELECT id FROM attention_requests WHERE employee_id=${b.employeeId} AND project_id=${b.projectId} AND (${afterId ?? null}::uuid IS NULL OR id>${afterId ?? null}) ORDER BY id LIMIT 20`
  const requests: P.AttentionRequest[] = []
  for (const row of rows) requests.push(yield* readRequest(b.employeeId, row.id))
  return { requests, next_after_id: requests.at(-1)?.id ?? '' }
})
export const handleAttentionRequest = (employeeId: string, id: string, input: P.HandleAttentionInput, close = false) =>
  transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* strictDecode(P.UUID, id)
      const h = yield* strictDecode(P.HandleAttentionInput, input)
      yield* strictDecode(P.nonemptyText(512).check(Schema.isMaxCodePoints(128)), h.client_request_id)
      if (!h.client_request_id.trim() || (close && (h.option_id || h.text)))
        return yield* Effect.fail(new AppError(422, 'invalid'))
      const current = yield* lockRequest(employeeId, id)
      if (current.resolution?.client_request_id === h.client_request_id) return current
      if (current.state !== 'open' || current.version !== h.expected_version)
        return yield* Effect.fail(new AppError(409, 'inbox_conflict', '事项已变化', { current }))
      const option = current.options?.find((o) => o.id === h.option_id)
      if (!close && (current.source === 'system' || (h.option_id ? !option : !current.allow_text || !h.text?.trim())))
        return yield* Effect.fail(new AppError(422, 'invalid_inbox_answer'))
      const state = close ? 'closed' : 'answered'
      const resolution: P.InboxResolution = {
        client_request_id: h.client_request_id,
        employee_id: employeeId,
        ...(option ? { option_id: option.id, option_label: option.label } : {}),
        ...(h.text ? { text: h.text } : {}),
      }
      yield* sql`UPDATE attention_requests SET state=${state},resolution=${JSON.stringify(resolution)}::jsonb,version=version+1,resolved_at=clock_timestamp(),updated_at=clock_timestamp() WHERE employee_id=${employeeId} AND id=${id}`
      if (current.source === 'agent') {
        const binding = yield* sql<{
          agent_id: string
        }>`SELECT agent_id FROM attention_requests WHERE employee_id=${employeeId} AND id=${id}`
        yield* insertProjectInput(employeeId, binding[0]!.agent_id, 'attention_answer', `attention:${id}:resolution`, {
          request_id: id,
          title: current.title,
          state,
          resolution,
        })
      }
      return yield* readRequest(employeeId, id)
    }),
  )

const InboxQuery = Schema.Struct({
  state: Schema.optionalKey(Schema.Literals(['open', 'done', 'all'])),
  cursor: Schema.optionalKey(P.Text),
  project_id: Schema.optionalKey(P.UUID),
  thread_id: Schema.optionalKey(P.UUID),
})
const Cursor = Schema.Struct({ at: P.Timestamp, id: P.UUID, scope: Schema.String })
export const listInbox = (employeeId: string, query: typeof InboxQuery.Type = {}) =>
  transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const q = yield* strictDecode(InboxQuery, query)
      const state = q.state ?? 'open'
      const scope = JSON.stringify([employeeId, state, q.project_id, q.thread_id])
      const c = q.cursor
        ? yield* Effect.try({
            try: () => Schema.decodeUnknownSync(Cursor)(JSON.parse(Buffer.from(q.cursor!, 'base64url').toString())),
            catch: () => new AppError(422, 'invalid_cursor'),
          })
        : undefined
      if (c && c.scope !== scope) return yield* Effect.fail(new AppError(422, 'invalid_cursor'))
      const count = yield* sql<{
        count: number
      }>`SELECT count(*)::integer AS count FROM attention_requests WHERE employee_id=${employeeId} AND state='open'`
      const rows = yield* sql<{
        id: string
      }>`SELECT id FROM attention_requests WHERE employee_id=${employeeId} AND (${state}='all' OR (${state}='open' AND state='open') OR (${state}='done' AND state<>'open')) AND (${q.project_id ?? null}::uuid IS NULL OR project_id=${q.project_id ?? null}) AND (${q.thread_id ?? null}::uuid IS NULL OR thread_id=${q.thread_id ?? null}) AND (${c?.id ?? null}::uuid IS NULL OR (created_at,id)<(${c?.at ?? null}::timestamptz,${c?.id ?? null}::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51`
      const requests: P.AttentionRequest[] = []
      for (const row of rows.slice(0, 50)) requests.push(yield* readRequest(employeeId, row.id))
      const last = requests.at(-1)
      return {
        requests,
        open_count: count[0]!.count,
        ...(rows.length > 50 && last
          ? {
              next_cursor: Buffer.from(JSON.stringify({ at: last.created_at, id: last.id, scope })).toString(
                'base64url',
              ),
            }
          : {}),
      }
    }),
  )

export const archiveProjectAttention = Effect.fnUntraced(function* (employeeId: string, projectId: string) {
  const sql = yield* SqlClient.SqlClient
  yield* sql`UPDATE attention_requests SET state='withdrawn',version=version+1,withdraw_reason='Project 已归档',resolved_at=clock_timestamp(),updated_at=clock_timestamp() WHERE employee_id=${employeeId} AND project_id=${projectId} AND state='open'`
})
export const createSystemAttention = Effect.fnUntraced(function* (b: InboxBinding, reason: string) {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO attention_requests(id,employee_id,project_id,agent_id,conversation_id,source,condition_type,condition_object_id,title,content,action_url) VALUES(${randomUUID()},${b.employeeId},${b.projectId},${b.agentId},${b.conversationId},'system','project_needs_attention',${b.projectId},'Project Agent 需要处理',${reason},${'/projects/' + b.projectId}) ON CONFLICT(project_id) WHERE source='system' AND state='open' DO NOTHING`
})
export const resolveSystemAttention = Effect.fnUntraced(function* (employeeId: string, projectId: string) {
  const sql = yield* SqlClient.SqlClient
  yield* sql`UPDATE attention_requests SET state='resolved',version=version+1,resolved_at=clock_timestamp(),updated_at=clock_timestamp() WHERE employee_id=${employeeId} AND project_id=${projectId} AND source='system' AND state='open'`
})
