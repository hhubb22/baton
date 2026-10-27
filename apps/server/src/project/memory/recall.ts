import { Effect } from 'effect'
import { create, insertMultiple, search } from '@orama/orama'
import * as SqlClient from 'effect/sql/SqlClient'
import * as P from '@baton/protocol'
import { transaction } from '../../database.ts'
import { AppError } from '../../errors.ts'
import { resultBytes } from '../tools.ts'
import { readProjectMemory, requireProject, memoryValiditySQL } from './read.ts'
import { sourceSearchState } from './sources.ts'
import { embeddingStatus } from './embeddings.ts'
import { vectorCandidates } from './vectors.ts'
import { queryTerms, SEARCH_VERSION, utf8Prefix, excerpt, type SearchFields } from './lexical.ts'

type Candidate = {
  document_id: string
  item_id: string | null
  source_id: string | null
  start_byte: number
  end_byte: number
  snippet: string
  fields: SearchFields
  created_at: string
}
const corpusSQL = (
  sql: SqlClient.SqlClient,
  employeeId: string,
  projectId: string,
  input: P.MemoryRecallInput,
  knowledgeOnly: boolean,
  throughSeq?: number,
) => sql`
 SELECT d.*
 FROM project_memory_search_documents d
 LEFT JOIN project_memory_items e ON e.employee_id=d.employee_id AND e.project_id=d.project_id AND e.id=d.item_id
 LEFT JOIN project_memory_revisions r ON r.item_id=e.id AND r.revision=e.current_revision
 LEFT JOIN project_memory_sources s ON s.id=d.source_id
 WHERE d.employee_id=${employeeId} AND d.project_id=${projectId} AND (
 (d.item_id IS NOT NULL AND d.revision=e.current_revision AND (${memoryValiditySQL(sql, input)}))
 OR (NOT ${knowledgeOnly} AND d.source_id IS NOT NULL AND (${throughSeq ?? null}::bigint IS NULL OR s.source_seq IS NULL OR s.source_seq<=${throughSeq ?? null})
 AND (${input.mode === 'history'} OR (NOT EXISTS(SELECT 1 FROM project_memory_suppressions x WHERE x.employee_id=d.employee_id AND x.project_id=d.project_id AND x.released_at IS NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(x.evidence) v WHERE v->>'source_id'=d.source_id::text AND (v->>'start_byte')::bigint<d.end_byte AND (v->>'end_byte')::bigint>d.start_byte))
 AND NOT EXISTS(SELECT 1 FROM project_memory_evidence v JOIN project_memory_items old ON old.id=v.item_id JOIN project_memory_revisions oldr ON oldr.item_id=old.id AND oldr.revision=old.current_revision WHERE v.employee_id=d.employee_id AND v.project_id=d.project_id AND v.source_id=d.source_id AND (old.status NOT IN ('active','superseded') OR (oldr.valid_until IS NOT NULL AND oldr.valid_until<=now())))))) )`

// 调用方提供一致事务；自动上下文在 Agent 和 memory_state 锁下复用此入口。
export const recall = Effect.fn('recallProjectMemory')(function* (
  employeeId: string,
  projectId: string,
  input: P.MemoryRecallInput,
  knowledgeOnly = false,
  throughSeq?: number,
  queryVector?: P.MemoryQueryVector,
) {
  const sql = yield* SqlClient.SqlClient
  yield* requireProject(employeeId, projectId)
  const query = queryTerms(input.query)
  const result: { -readonly [K in keyof typeof P.MemoryRecallResult.Type]: (typeof P.MemoryRecallResult.Type)[K] } = {
    entries: [],
    memory_refs: [],
    derived: true,
    query_truncated: query.truncated,
    candidate_truncated: false,
    result_truncated: false,
    no_match: true,
    degraded: [],
    algorithm: SEARCH_VERSION,
  }
  if (!query.terms.length && !queryVector) return result
  const lexemes = query.terms.map((t) => "'" + t.replaceAll('\\', '\\\\').replaceAll("'", "''") + "'")
  const tsquery = lexemes.join(' | ')
  const corpus = corpusSQL(sql, employeeId, projectId, input, knowledgeOnly, throughSeq)
  const rows =
    yield* sql<Candidate>`WITH eligible AS (${corpus}) SELECT document_id,item_id,source_id,start_byte::float8 AS start_byte,end_byte::float8 AS end_byte,snippet,fields,created_at::text AS created_at FROM eligible d WHERE terms @@ ${tsquery}::tsquery ORDER BY EXISTS(SELECT 1 FROM project_memory_revisions r WHERE r.item_id=d.item_id AND r.revision=d.revision AND (lower(r.topic)=lower(${query.query}) OR lower(r.semantic_key)=lower(${query.query}))) DESC,ts_rank(terms,${tsquery}::tsquery) DESC,created_at DESC,document_id LIMIT 513`
  result.candidate_truncated = rows.length > 512
  const candidates = rows.slice(0, 512)
  const byId = new Map(candidates.map((row) => [row.document_id, row]))
  const searched = yield* Effect.tryPromise({
    try: async () => {
      const index = create({
        schema: { title: 'string', search_terms: 'string', content: 'string' },
        components: {
          tokenizer: {
            language: 'english',
            normalizationCache: new Map(),
            tokenize: (text) => text.split(' ').filter(Boolean),
          },
        },
      })
      await insertMultiple(
        index,
        candidates.map((row) => ({
          id: row.document_id,
          title: row.fields.title.join(' '),
          search_terms: row.fields.search_terms.join(' '),
          content: row.fields.content.join(' '),
        })),
      )
      return await search(index, {
        term: query.terms.join(' '),
        mode: 'fulltext',
        boost: { title: 3, search_terms: 2, content: 1 },
        limit: 512,
      })
    },
    catch: () => new AppError(503, 'memory_unavailable'),
  })
  const lexicalRanked = searched.hits
    .map((hit) => ({ row: byId.get(hit.id)!, score: hit.score }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.row.created_at.localeCompare(a.row.created_at) ||
        a.row.document_id.localeCompare(b.row.document_id),
    )
  const [project] = yield* sql<{
    memory_embedding: P.MemoryEmbeddingConfig | null
  }>`SELECT memory_embedding FROM projects WHERE employee_id=${employeeId} AND id=${projectId}`
  let vectors: { document_id: string; created_at: string; score: number }[] = []
  if (project!.memory_embedding) {
    const status = yield* embeddingStatus(employeeId, projectId, project!.memory_embedding.config_id, input)
    if (status.pending) result.degraded = [...result.degraded, 'embedding_pending']
    if (status.diagnostic) result.degraded = [...result.degraded, status.diagnostic]
    if (!queryVector) result.degraded = [...result.degraded, 'embedding_query_missing']
    else if (queryVector.config_id !== project!.memory_embedding.config_id)
      result.degraded = [...result.degraded, 'embedding_configuration_changed']
    else {
      const vectorResult = yield* transaction(vectorCandidates(employeeId, projectId, queryVector, input)).pipe(
        Effect.catch(() => Effect.succeed({ hits: [], truncated: false, diagnostic: 'embedding_unavailable' })),
      )
      vectors = vectorResult.hits
      if (vectorResult.diagnostic) result.degraded = [...result.degraded, vectorResult.diagnostic]
      if (vectorResult.truncated) result.result_truncated = true
    }
  }
  const merged = new Map<string, { document_id: string; created_at: string; score: number }>()
  const routes = [
    lexicalRanked.map(({ row, score }) => ({ document_id: row.document_id, created_at: row.created_at, score })),
    vectors,
  ]
  for (const route of routes)
    for (const [i, hit] of route.entries()) {
      const previous = merged.get(hit.document_id)
      merged.set(hit.document_id, { ...hit, score: (previous?.score ?? 0) + 1 / (60 + i + 1) })
    }
  const ordered = [...merged.values()].sort(
    (a, b) =>
      b.score - a.score || b.created_at.localeCompare(a.created_at) || a.document_id.localeCompare(b.document_id),
  )
  if (ordered.length > (input.max_results ?? 20)) result.result_truncated = true
  const selected = ordered.slice(0, input.max_results ?? 20)
  const missing = selected.filter((hit) => !byId.has(hit.document_id)).map((hit) => hit.document_id)
  if (missing.length) {
    const documents =
      yield* sql<Candidate>`SELECT document_id,item_id,source_id,start_byte::float8 AS start_byte,end_byte::float8 AS end_byte,snippet,fields,created_at::text AS created_at FROM project_memory_search_documents WHERE employee_id=${employeeId} AND project_id=${projectId} AND document_id=ANY(${missing}::text[])`
    for (const row of documents) byId.set(row.document_id, row)
  }
  const ranked = selected.flatMap((hit) => {
    const row = byId.get(hit.document_id)
    return row ? [{ row, score: hit.score }] : []
  })
  const entries: P.MemoryRecallHit[] = []
  const refs: (typeof P.MemoryReference.Type)[] = []
  for (const { row, score } of ranked) {
    if (entries.length >= (input.max_results ?? 20)) {
      result.result_truncated = true
      break
    }
    let hit: P.MemoryRecallHit = { document_id: row.document_id, snippet: row.snippet, snippet_truncated: false, score }
    if (row.item_id) {
      const item = yield* readProjectMemory(employeeId, projectId, row.item_id)
      const completeText = item.title + '\n' + item.content + (item.conditions ? '\n适用条件：' + item.conditions : '')
      const snippet = excerpt(completeText, query.terms, 2048)
      hit = {
        ...hit,
        snippet,
        snippet_truncated: snippet !== completeText,
        item: {
          id: item.id,
          revision: item.revision,
          status: item.status,
          effective: item.effective,
          retracted: item.retracted,
          evidence: item.evidence.slice(0, 1),
          evidence_count: item.evidence.length,
          read_tool: 'memory.read',
        },
      }
      if (item.evidence.length > 1) result.result_truncated = true
    } else {
      hit = {
        ...hit,
        source: {
          ...(yield* sourceSearchState(employeeId, projectId, row.source_id!)),
          start_byte: row.start_byte,
          end_byte: row.end_byte,
        },
      }
    }
    const trialRefs = (): (typeof P.MemoryReference.Type)[] => [
      ...refs,
      ...(hit.item
        ? [
            {
              item_id: hit.item.id,
              revision: hit.item.revision,
              mode: input.mode ?? 'current',
              ...(input.as_of ? { as_of: input.as_of } : {}),
            } as typeof P.MemoryReference.Type,
          ]
        : hit.source
          ? [
              {
                source_id: hit.source.source_id,
                source_hash: hit.source.source_hash,
                start_byte: hit.source.start_byte,
                end_byte: hit.source.end_byte,
                mode: input.mode ?? 'current',
                ...(input.as_of ? { as_of: input.as_of } : {}),
              } as typeof P.MemoryReference.Type,
            ]
          : []),
    ]
    const fits = () => {
      const value = { ...result, entries: [...entries, hit], memory_refs: trialRefs() }
      return (
        Buffer.byteLength(JSON.stringify(value, null, 1)) <= (input.max_bytes ?? 28000) &&
        resultBytes(value) + Buffer.byteLength(JSON.stringify(value.memory_refs)) < 30000
      )
    }
    while (!fits() && Buffer.byteLength(hit.snippet) > 64) {
      hit = {
        ...hit,
        snippet: utf8Prefix(hit.snippet, Math.floor(Buffer.byteLength(hit.snippet) / 2)),
        snippet_truncated: true,
        ...(hit.source
          ? {
              source: {
                ...hit.source,
                end_byte:
                  hit.source.start_byte +
                  Buffer.byteLength(utf8Prefix(hit.snippet, Math.floor(Buffer.byteLength(hit.snippet) / 2))),
              },
            }
          : {}),
      }
    }
    if (!fits()) {
      result.result_truncated = true
      break
    }
    if (hit.snippet_truncated) result.result_truncated = true
    entries.push(hit)
    refs.splice(0, refs.length, ...trialRefs())
  }
  return { ...result, entries, memory_refs: refs, no_match: ordered.length === 0 }
})
// 历史结果按原序号分页，只搜索已经登记的原文，排除手动编辑和派生工具结果。
export const searchProjectHistory = Effect.fnUntraced(function* (
  employeeId: string,
  projectId: string,
  conversationId: string,
  input: { query?: string; after_seq?: number; through_seq: number },
) {
  const sql = yield* SqlClient.SqlClient
  const query = queryTerms(input.query ?? '')
  const tsquery = query.terms.map((t) => "'" + t.replaceAll('\\', '\\\\').replaceAll("'", "''") + "'").join(' | ')
  const rows = yield* sql<{
    seq: number
    source_id: string
    start_byte: number
    end_byte: number
    snippet: string
  }>`SELECT DISTINCT ON (s.source_seq) s.source_seq::float8 AS seq,d.source_id,
      d.start_byte::float8 AS start_byte,d.end_byte::float8 AS end_byte,d.snippet
    FROM project_memory_search_documents d
    JOIN project_memory_sources s ON s.id=d.source_id AND s.employee_id=d.employee_id AND s.project_id=d.project_id
    JOIN conversation_events e ON e.employee_id=s.employee_id AND e.conversation_id=${conversationId} AND e.seq=s.source_seq
    WHERE d.employee_id=${employeeId} AND d.project_id=${projectId}
      AND s.source_seq>${input.after_seq ?? 0} AND s.source_seq<=${input.through_seq}
      AND (${!input.query?.trim()} OR d.terms @@ ${tsquery}::tsquery)
    ORDER BY s.source_seq,d.document_id LIMIT 21`
  const events = yield* Effect.forEach(
    rows.slice(0, 20),
    Effect.fnUntraced(function* (row) {
      return {
        seq: row.seq,
        snippet: row.snippet,
        source: {
          ...(yield* sourceSearchState(employeeId, projectId, row.source_id)),
          start_byte: row.start_byte,
          end_byte: row.end_byte,
        },
      }
    }),
  )
  return {
    events,
    through_seq: input.through_seq,
    next_after_seq: events.at(-1)?.seq ?? input.after_seq ?? 0,
    has_more: rows.length > 20,
    query_truncated: query.truncated,
    no_match: events.length === 0,
  }
})

export const recallProjectMemory = (employeeId: string, projectId: string, input: P.MemoryRecallInput) =>
  transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`
      return yield* recall(employeeId, projectId, input)
    }),
  ).pipe(
    Effect.catch((error) =>
      error.status >= 500 ? Effect.fail(new AppError(503, 'memory_unavailable')) : Effect.fail(error),
    ),
  )
