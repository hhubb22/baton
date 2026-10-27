import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as P from '@baton/protocol'
import { AppError } from '../../errors.ts'
import { transaction } from '../../database.ts'
import { canonical } from '../../json.ts'
import type { ProjectBinding } from '../store.ts'
import { currentMemorySQL, readProjectMemory } from './read.ts'
import { recall } from './recall.ts'
import {
  estimatedTokens,
  renderMemory,
  SEARCH_VERSION,
  utf8Prefix,
  MEMORY_HEADER,
  excerpt,
  queryTerms,
} from './lexical.ts'
import { hashText } from './sources.ts'

export const lockMemoryState = Effect.fnUntraced(function* (employeeId: string, projectId: string) {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO project_memory_state(employee_id,project_id) VALUES(${employeeId},${projectId}) ON CONFLICT DO NOTHING`
  const [state] = yield* sql<{
    core_epoch: number
  }>`SELECT core_epoch::float8 AS core_epoch FROM project_memory_state WHERE employee_id=${employeeId} AND project_id=${projectId} FOR UPDATE`
  return state!
})
// 返回仍是条目当前版本的引用；条目的任何变更都会产生新版本。
const currentVersions = Effect.fnUntraced(function* (
  employeeId: string,
  projectId: string,
  refs: readonly P.MemoryItemVersion[],
) {
  const sql = yield* SqlClient.SqlClient
  if (!refs.length) return []
  const rows = yield* sql<{
    id: string
    revision: number
  }>`SELECT id,current_revision::float8 AS revision FROM project_memory_items WHERE employee_id=${employeeId} AND project_id=${projectId} AND id=ANY(${[...new Set(refs.map((r) => r.item_id))]}::uuid[])`
  const current = new Map(rows.map((r) => [r.id, r.revision]))
  return refs.filter((r) => current.get(r.item_id) === r.revision)
})
const itemVersions = (refs: readonly (typeof P.MemoryReference.Type)[]): P.MemoryItemVersion[] =>
  refs.flatMap((r) => ('item_id' in r && r.mode === 'current' ? [{ item_id: r.item_id, revision: r.revision }] : []))
export const embeddingQuery = Effect.fn('projectMemoryEmbeddingQuery')(function* (
  b: Pick<ProjectBinding, 'employeeId' | 'projectId' | 'agentId' | 'conversationId' | 'nextSeq'>,
  lastSeq: number,
  inputSeq: number,
  explicitQuery?: string,
) {
  const sql = yield* SqlClient.SqlClient
  if (lastSeq !== b.nextSeq - 1) return yield* Effect.fail(new AppError(409, 'conflict'))
  const [input] = yield* sql<{
    seq: number
  }>`SELECT COALESCE(max(seq),0)::float8 AS seq FROM conversation_events WHERE conversation_id=${b.conversationId} AND kind='input' AND seq<=${lastSeq}`
  if (input!.seq !== inputSeq) return yield* Effect.fail(new AppError(409, 'memory_context_changed'))
  const recent = yield* sql<{
    text: string
  }>`SELECT left(COALESCE((SELECT string_agg(COALESCE(q.payload->>'content',q.payload->>'title',''),E'\n' ORDER BY q.id) FROM project_agent_input_queue q WHERE q.employee_id=${b.employeeId} AND q.agent_id=${b.agentId} AND q.delivered_seq=e.seq),''),4096) AS text FROM conversation_events e WHERE e.conversation_id=${b.conversationId} AND e.kind='input' AND e.seq<=${lastSeq} ORDER BY e.seq DESC LIMIT 3`
  const [project] = yield* sql<{
    goal: string
    memory_embedding: P.MemoryEmbeddingConfig | null
  }>`SELECT goal,memory_embedding FROM projects WHERE employee_id=${b.employeeId} AND id=${b.projectId}`
  const rawQuery = explicitQuery ?? recent.map((r) => r.text).join('\n') + '\n' + project!.goal
  const query = utf8Prefix(rawQuery, 2048)

  return {
    query,
    query_hash: hashText(
      canonical({
        project: b.projectId,
        conversation: b.conversationId,
        last_seq: lastSeq,
        input_seq: inputSeq,
        config_id: project!.memory_embedding?.config_id ?? null,
        query,
      }),
    ),
    last_seq: lastSeq,
    input_seq: inputSeq,
    memory_embedding: project!.memory_embedding,
    query_truncated: rawQuery !== query,
  }
})
export const prepareContext = Effect.fn('prepareProjectMemoryContext')(function* (
  b: ProjectBinding,
  lastSeq: number,
  request: P.PrepareMemoryContext,
) {
  const sql = yield* SqlClient.SqlClient
  if (lastSeq !== b.nextSeq - 1) return yield* Effect.fail(new AppError(409, 'conflict'))
  const state = yield* lockMemoryState(b.employeeId, b.projectId)
  const requestHash = hashText(canonical({ lastSeq, request }))
  const [old] = yield* sql<{
    request_hash: string
    snapshot: P.MemoryContext
  }>`SELECT request_hash,snapshot FROM project_memory_contexts WHERE context_id=${request.context_id} AND employee_id=${b.employeeId} AND project_id=${b.projectId} AND conversation_id=${b.conversationId}`
  if (old) {
    if (old.request_hash !== requestHash) return yield* Effect.fail(new AppError(409, 'operation_conflict'))
    return old.snapshot
  }
  const selection = yield* embeddingQuery(b, lastSeq, request.input_seq)
  const query = selection.query
  const normalizedQuery = queryTerms(query).terms
  const ids = yield* sql<{
    id: string
  }>`SELECT e.id FROM project_memory_items e JOIN project_memory_revisions r ON r.item_id=e.id AND r.revision=e.current_revision WHERE e.employee_id=${b.employeeId} AND e.project_id=${b.projectId} AND r.core AND ${currentMemorySQL(sql)} ORDER BY e.id`
  const core = yield* Effect.forEach(ids, ({ id }) => readProjectMemory(b.employeeId, b.projectId, id))
  const coreText = core.map(renderMemory).join('\n')
  let coreComplete = !core.length || estimatedTokens(MEMORY_HEADER + coreText) + 4 <= request.core_tokens
  const degraded: string[] = []
  const mark = (code: string) => {
    if (!degraded.includes(code)) degraded.push(code)
  }
  if (!coreComplete) mark('core_budget_exceeded')
  if (selection.query_truncated) mark('query_truncated')
  let queryVector = request.query_vector
  if (
    queryVector &&
    (queryVector.config_id !== selection.memory_embedding?.config_id || queryVector.query_hash !== selection.query_hash)
  ) {
    queryVector = undefined
    mark('embedding_query_changed')
  }
  if (selection.memory_embedding && request.embedding_diagnostic) mark(request.embedding_diagnostic)
  const relatedBlocks: { text: string; ref: typeof P.MemoryReference.Type }[] = []
  const snapshot = (): P.MemoryContext => ({
    context_id: request.context_id,
    last_seq: lastSeq,
    input_seq: request.input_seq,
    core_epoch: state.core_epoch,
    budget: { core_tokens: request.core_tokens, related_tokens: request.related_tokens, max_bytes: request.max_bytes },
    expires_at: expiresAt,
    core_complete: coreComplete,
    query,
    algorithm: SEARCH_VERSION,
    degraded: [...degraded],
    content:
      MEMORY_HEADER +
      (coreComplete
        ? coreText
        : '核心要求无法完整容纳，请报告容量不足，并调整上下文容量后再提交依赖这些要求的操作。\n') +
      relatedBlocks.map((b) => b.text).join('') +
      (degraded.length ? '\n记忆上下文状态：' + degraded.join(', ') + '。缺少必需依据时先补查，并说明具体缺口。' : ''),
    memory_refs: [
      ...(coreComplete ? core.map((i) => ({ item_id: i.id, revision: i.revision, mode: 'current' as const })) : []),
      ...relatedBlocks.map((b) => b.ref),
    ],
    view_refs: [],
  })
  // 失效时间在选定相关条目后计算，容量按最长的时间戳文本预留。
  let expiresAt: string | null = '0000-00-00T00:00:00.000000+00:00'
  const fits = () => Buffer.byteLength(JSON.stringify(snapshot(), null, 1)) <= request.max_bytes
  if (!fits()) {
    coreComplete = false
    mark('core_budget_exceeded')
  }
  const related = yield* transaction(
    recall(b.employeeId, b.projectId, { query, max_results: 20, max_bytes: 32768 }, true, lastSeq, queryVector),
  ).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (!related) mark('memory_unavailable')
  else {
    for (const diagnostic of related.degraded) mark(diagnostic)
    if (related.query_truncated) mark('query_truncated')
    if (related.candidate_truncated) mark('candidate_truncated')
    if (related.result_truncated) mark('result_truncated')
    let tokens = 0
    for (const hit of related.entries) {
      if (!hit.item || core.some((i) => i.id === hit.item!.id)) continue
      let snippet = hit.snippet
      let truncated = hit.snippet_truncated
      const render = () =>
        '\n相关知识片段 [' +
        hit.item!.id +
        '@' +
        hit.item!.revision +
        ']：\n' +
        snippet +
        '\n来源：' +
        hit.item!.evidence.map((ref) => `${ref.source_id}:${ref.start_byte}-${ref.end_byte}`).join(', ') +
        '\n' +
        (truncated ? '片段已截断；使用前可用 ' : '完整条件与来源可用 ') +
        'memory.read(item_id=' +
        hit.item!.id +
        ', revision=' +
        hit.item!.revision +
        ') 继续读取。\n'
      let text = render()
      while (tokens + estimatedTokens(text) > request.related_tokens && Buffer.byteLength(snippet) > 64) {
        snippet = excerpt(snippet, normalizedQuery, Math.floor(Buffer.byteLength(snippet) / 2))
        truncated = true
        text = render()
      }
      if (tokens + estimatedTokens(text) > request.related_tokens) {
        mark('related_budget_exceeded')
        continue
      }
      relatedBlocks.push({ text, ref: { item_id: hit.item.id, revision: hit.item.revision, mode: 'current' } })
      while (!fits() && Buffer.byteLength(snippet) > 64) {
        snippet = excerpt(snippet, normalizedQuery, Math.floor(Buffer.byteLength(snippet) / 2))
        truncated = true
        text = render()
        relatedBlocks[relatedBlocks.length - 1]!.text = text
      }
      if (!fits()) {
        relatedBlocks.pop()
        mark('related_budget_exceeded')
        continue
      }
      if (truncated) mark('related_snippet_truncated')
      tokens += estimatedTokens(text)
    }
  }
  while (!fits() && relatedBlocks.length) {
    relatedBlocks.pop()
    mark('related_budget_exceeded')
  }
  if (!fits())
    return yield* Effect.fail(new AppError(422, 'core_budget_exceeded', '请求快照容量不足，无法保存完整核心要求与来源'))
  // 核心集合在时间边界上变化，快照中的相关条目在失效时间到达时退出；新条目生效不影响已有快照。
  const relatedIds = relatedBlocks.flatMap((b) => ('item_id' in b.ref ? [b.ref.item_id] : []))
  const [expiry] = yield* sql<{
    expires_at: string | null
  }>`SELECT to_jsonb(min(t)) AS expires_at FROM project_memory_items e JOIN project_memory_revisions r ON r.item_id=e.id AND r.revision=e.current_revision CROSS JOIN LATERAL (VALUES(CASE WHEN r.core THEN r.valid_from END),(r.valid_until)) boundary(t) WHERE e.employee_id=${b.employeeId} AND e.project_id=${b.projectId} AND e.status IN ('active','superseded') AND (r.core OR e.id=ANY(${relatedIds}::uuid[])) AND t>now()`
  expiresAt = expiry!.expires_at
  const result = {
    ...snapshot(),
    view_refs: yield* currentVersions(b.employeeId, b.projectId, request.view_refs ?? []),
  }
  yield* sql`INSERT INTO project_memory_contexts(context_id,employee_id,project_id,conversation_id,last_seq,input_seq,core_epoch,expires_at,request_hash,snapshot,content_hash) VALUES(${request.context_id},${b.employeeId},${b.projectId},${b.conversationId},${lastSeq},${request.input_seq},${state.core_epoch},${expiresAt}::timestamptz,${requestHash},${JSON.stringify(result)}::jsonb,${hashText(result.content)})`
  return result
})

// 已保存结果和持久执行登记须由调用方先查；只对首次保存/提交检查。
// 快照读到的条目版本、核心集合和时间边界都未变化时仍然有效，其他条目的增改不影响它。
export const checkMemoryContext = Effect.fn('checkProjectMemoryContext')(function* (
  b: Pick<ProjectBinding, 'employeeId' | 'projectId' | 'conversationId'>,
  contextId: string,
  lastSeq?: number,
  requireCore = false,
) {
  const sql = yield* SqlClient.SqlClient
  yield* lockMemoryState(b.employeeId, b.projectId)
  const [context] = yield* sql<{
    snapshot: P.MemoryContext
  }>`SELECT c.snapshot FROM project_memory_contexts c JOIN project_memory_state s ON s.employee_id=c.employee_id AND s.project_id=c.project_id WHERE c.context_id=${contextId} AND c.employee_id=${b.employeeId} AND c.project_id=${b.projectId} AND c.conversation_id=${b.conversationId} AND c.core_epoch=s.core_epoch AND (c.expires_at IS NULL OR c.expires_at>clock_timestamp()) AND (${lastSeq ?? null}::bigint IS NULL OR c.last_seq=${lastSeq ?? null})`
  if (!context) return yield* Effect.fail(new AppError(409, 'memory_context_changed'))
  const read = [...itemVersions(context.snapshot.memory_refs), ...context.snapshot.view_refs]
  if ((yield* currentVersions(b.employeeId, b.projectId, read)).length !== read.length)
    return yield* Effect.fail(new AppError(409, 'memory_context_changed'))
  if (requireCore && !context.snapshot.core_complete)
    return yield* Effect.fail(new AppError(422, 'core_budget_exceeded'))
  return context.snapshot
})
