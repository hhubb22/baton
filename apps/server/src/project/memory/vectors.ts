import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as P from '@baton/protocol'
import { memoryValiditySQL } from './read.ts'

const VECTOR_LIMIT = 20

// 在数据库内按余弦距离精确排序，只返回前 20 条有效修订；正文由 recall 在融合后限量读取。
export const vectorCandidates = Effect.fn('projectMemoryVectorCandidates')(function* (
  employeeId: string,
  projectId: string,
  query: P.MemoryQueryVector,
  mode: Pick<P.MemoryRecallInput, 'mode' | 'as_of' | 'include_inactive'>,
) {
  const sql = yield* SqlClient.SqlClient
  const vector = JSON.stringify(query.vector)
  const eligible = sql`project_memory_embeddings v JOIN project_memory_items e ON e.employee_id=v.employee_id AND e.project_id=v.project_id AND e.id=v.item_id JOIN project_memory_revisions r ON r.item_id=e.id AND r.revision=e.current_revision JOIN projects p ON p.employee_id=e.employee_id AND p.id=e.project_id WHERE v.employee_id=${employeeId} AND v.project_id=${projectId} AND v.config_id=${query.config_id} AND p.memory_embedding->>'config_id'=${query.config_id} AND v.state='ready' AND v.revision=e.current_revision AND ${memoryValiditySQL(sql, mode)}`
  const [status] = yield* sql<{
    ready: number
    mismatch: boolean
  }>`SELECT count(*)::float8 AS ready,COALESCE(bool_or(v.dimensions<>${query.vector.length}),false) AS mismatch FROM ${eligible}`
  if (status!.mismatch) return { hits: [], truncated: false, diagnostic: 'embedding_dimension_mismatch' }
  if (!status!.ready) return { hits: [], truncated: false, diagnostic: 'embedding_not_ready' }
  const rows = yield* sql<{
    item_id: string
    created_at: string
    score: number
  }>`SELECT v.item_id,e.updated_at::text AS created_at,1-(v.embedding<=>${vector}::vector) AS score FROM ${eligible} ORDER BY v.embedding<=>${vector}::vector,e.id LIMIT ${VECTOR_LIMIT}`
  return {
    hits: rows.map((row) => ({ document_id: 'item:' + row.item_id, created_at: row.created_at, score: row.score })),
    truncated: status!.ready > VECTOR_LIMIT,
    diagnostic: null,
  }
})
