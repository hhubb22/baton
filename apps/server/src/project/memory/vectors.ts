import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { create, insertMultiple, search } from '@orama/orama'
import * as P from '@baton/protocol'
import { AppError } from '../../errors.ts'
import { memoryValiditySQL } from './read.ts'

// 仅读取有效修订的向量元数据；正文由 recall 在融合后限量读取。
export const vectorCandidates = Effect.fn('projectMemoryVectorCandidates')(function* (
  employeeId: string,
  projectId: string,
  query: P.MemoryQueryVector,
  mode: Pick<P.MemoryRecallInput, 'mode' | 'as_of' | 'include_inactive'>,
) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    item_id: string
    dimensions: number
    vector: number[]
    created_at: string
  }>`SELECT v.item_id,v.dimensions,v.vector,e.updated_at::text AS created_at FROM project_memory_embeddings v JOIN project_memory_items e ON e.employee_id=v.employee_id AND e.project_id=v.project_id AND e.id=v.item_id JOIN project_memory_revisions r ON r.item_id=e.id AND r.revision=e.current_revision JOIN projects p ON p.employee_id=e.employee_id AND p.id=e.project_id WHERE v.employee_id=${employeeId} AND v.project_id=${projectId} AND v.config_id=${query.config_id} AND p.memory_embedding->>'config_id'=${query.config_id} AND v.state='ready' AND v.revision=e.current_revision AND ${memoryValiditySQL(sql, mode)} ORDER BY e.updated_at DESC,e.id`
  if (rows.some((row) => row.dimensions !== query.vector.length))
    return { hits: [], truncated: false, diagnostic: 'embedding_dimension_mismatch' }
  if (!rows.length) return { hits: [], truncated: false, diagnostic: 'embedding_not_ready' }
  const ranked = yield* Effect.tryPromise({
    try: async () => {
      const index = create({ schema: { embedding: `vector[${query.vector.length}]` as `vector[${number}]` } })
      await insertMultiple(
        index,
        rows.map((row) => ({ id: row.item_id, embedding: row.vector })),
      )
      return await search(index, {
        mode: 'vector',
        vector: { value: [...query.vector], property: 'embedding' },
        similarity: -1,
        limit: 20,
      })
    },
    catch: () => new AppError(503, 'embedding_unavailable'),
  })
  const metadata = new Map(rows.map((row) => [row.item_id, row]))
  return {
    hits: ranked.hits.map((hit) => ({
      document_id: 'item:' + hit.id,
      created_at: metadata.get(hit.id)!.created_at,
      score: hit.score,
    })),
    truncated: ranked.count > 20,
    diagnostic: null,
  }
})
