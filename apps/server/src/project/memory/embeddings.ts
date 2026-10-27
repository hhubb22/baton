import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as P from '@baton/protocol'
import { AppError } from '../../errors.ts'
import { canonical } from '../../json.ts'
import { requireProject, memoryValiditySQL } from './read.ts'
import { hashText } from './sources.ts'

export const embeddingText = (item: { title: string; content: string; conditions: string }) =>
  `${item.title}\n${item.content}\n${item.conditions}`
export function embeddingConfiguration(
  previous: P.MemoryEmbeddingConfig | null,
  input: P.MemoryEmbeddingConfigInput | null,
): P.MemoryEmbeddingConfig | null {
  if (input === null) return null
  const value = {
    base_url: new URL(input.base_url).href.replace(/\/+$/, ''),
    model: input.model.trim(),
    ...(input.credential_profile ? { credential_profile: input.credential_profile } : {}),
  }
  if (
    previous &&
    canonical(value) ===
      canonical({
        base_url: previous.base_url,
        model: previous.model,
        ...(previous.credential_profile ? { credential_profile: previous.credential_profile } : {}),
      })
  )
    return previous
  return { ...value, config_id: randomUUID() }
}

// 调用方已持有 Agent / memory_state 锁；与规范修订或配置在同一事务登记。
export const queueEmbeddings = Effect.fn('queueProjectMemoryEmbeddings')(function* (
  employeeId: string,
  projectId: string,
  itemId?: string,
) {
  const sql = yield* SqlClient.SqlClient
  const [project] = yield* sql<{
    memory_embedding: P.MemoryEmbeddingConfig | null
  }>`SELECT memory_embedding FROM projects WHERE employee_id=${employeeId} AND id=${projectId}`
  if (!project?.memory_embedding) return
  const configId = project.memory_embedding.config_id
  const rows = yield* sql<{
    item_id: string
    revision: number
    title: string
    content: string
    conditions: string
  }>`SELECT e.id AS item_id,r.revision::float8 AS revision,r.title,r.content,r.conditions FROM project_memory_items e JOIN project_memory_revisions r ON r.item_id=e.id AND r.revision=e.current_revision WHERE e.employee_id=${employeeId} AND e.project_id=${projectId} AND e.status IN ('active','superseded') AND (${itemId ?? null}::uuid IS NULL OR e.id=${itemId ?? null})`
  for (const item of rows) {
    const textHash = hashText(embeddingText(item))
    yield* sql`INSERT INTO project_memory_embeddings(employee_id,project_id,item_id,revision,config_id,embedding_text_hash,state,dimensions,embedding) SELECT ${employeeId},${projectId},${item.item_id},${item.revision},${configId},${textHash},CASE WHEN prior.embedding IS NULL THEN 'pending' ELSE 'ready' END,prior.dimensions,prior.embedding FROM (SELECT 1) seed LEFT JOIN LATERAL (SELECT dimensions,embedding FROM project_memory_embeddings WHERE employee_id=${employeeId} AND project_id=${projectId} AND item_id=${item.item_id} AND config_id=${configId} AND embedding_text_hash=${textHash} AND state='ready' ORDER BY revision DESC LIMIT 1) prior ON true ON CONFLICT DO NOTHING`
  }
})

// 后台须先核验 claim；这里再拒绝已变化的配置、修订与正文，迟到结果不进入 ready。
export const commitEmbedding = Effect.fn('commitProjectMemoryEmbedding')(function* (
  employeeId: string,
  projectId: string,
  input: P.MemoryEmbeddingCommit,
) {
  const sql = yield* SqlClient.SqlClient
  const binding = yield* requireProject(employeeId, projectId, true)
  if (binding.status !== 'active') return { accepted: false }
  yield* sql`SELECT 1 FROM project_memory_state WHERE employee_id=${employeeId} AND project_id=${projectId} FOR UPDATE`
  const [current] = yield* sql<{
    matches: boolean
  }>`SELECT true AS matches FROM project_memory_embeddings v JOIN projects p ON p.employee_id=v.employee_id AND p.id=v.project_id JOIN project_memory_items e ON e.employee_id=v.employee_id AND e.project_id=v.project_id AND e.id=v.item_id WHERE v.employee_id=${employeeId} AND v.project_id=${projectId} AND v.item_id=${input.item_id} AND v.revision=${input.revision} AND v.config_id=${input.config_id} AND v.embedding_text_hash=${input.embedding_text_hash} AND p.memory_embedding->>'config_id'=${input.config_id} AND e.current_revision=v.revision AND e.status IN ('active','superseded')`
  if (!current) return { accepted: false }
  const dimensions = input.vector.length,
    embedding = JSON.stringify(input.vector)
  const other =
    yield* sql`SELECT 1 FROM project_memory_embeddings WHERE employee_id=${employeeId} AND project_id=${projectId} AND config_id=${input.config_id} AND state='ready' AND dimensions<>${dimensions} LIMIT 1`
  if (other.length) return yield* Effect.fail(new AppError(422, 'embedding_dimension_mismatch'))
  const changed =
    yield* sql`UPDATE project_memory_embeddings SET state='ready',dimensions=${dimensions},embedding=${embedding}::vector,diagnostic='',updated_at=clock_timestamp() WHERE employee_id=${employeeId} AND project_id=${projectId} AND item_id=${input.item_id} AND revision=${input.revision} AND config_id=${input.config_id} AND embedding_text_hash=${input.embedding_text_hash} AND (state<>'ready' OR embedding IS DISTINCT FROM ${embedding}::vector) RETURNING item_id`
  if (changed.length)
    yield* sql`UPDATE project_memory_state SET search_generation=search_generation+1 WHERE employee_id=${employeeId} AND project_id=${projectId}`
  return { accepted: true }
})

export const pendingEmbeddings = Effect.fn('pendingProjectMemoryEmbeddings')(function* (
  employeeId: string,
  projectId: string,
  limit = 16,
) {
  const sql = yield* SqlClient.SqlClient
  const binding = yield* requireProject(employeeId, projectId)
  const [project] = yield* sql<{
    memory_embedding: P.MemoryEmbeddingConfig | null
  }>`SELECT memory_embedding FROM projects WHERE employee_id=${employeeId} AND id=${projectId}`
  const config = project!.memory_embedding
  if (!config || binding.status !== 'active') return { memory_embedding: config, entries: [] }
  const entries = yield* sql<{
    item_id: string
    revision: number
    config_id: string
    embedding_text_hash: string
  }>`SELECT v.item_id,v.revision::float8 AS revision,v.config_id,v.embedding_text_hash FROM project_memory_embeddings v JOIN project_memory_items e ON e.employee_id=v.employee_id AND e.project_id=v.project_id AND e.id=v.item_id JOIN project_memory_revisions r ON r.item_id=e.id AND r.revision=e.current_revision WHERE v.employee_id=${employeeId} AND v.project_id=${projectId} AND v.config_id=${config.config_id} AND v.revision=e.current_revision AND v.state='pending' AND v.next_attempt_at<=clock_timestamp() AND e.status IN ('active','superseded') AND (r.valid_until IS NULL OR r.valid_until>clock_timestamp()) ORDER BY v.next_attempt_at,v.item_id LIMIT ${Math.max(1, Math.min(16, limit))}`
  return { memory_embedding: config, entries }
})

export const deferEmbedding = Effect.fn('deferProjectMemoryEmbedding')(function* (
  employeeId: string,
  projectId: string,
  input: Omit<P.MemoryEmbeddingCommit, 'vector'>,
  diagnostic: 'credential_missing' | 'embedding_request_failed' | 'embedding_timeout' | 'embedding_unavailable',
) {
  const sql = yield* SqlClient.SqlClient
  const binding = yield* requireProject(employeeId, projectId, true)
  if (binding.status !== 'active') return
  yield* sql`SELECT 1 FROM project_memory_state WHERE employee_id=${employeeId} AND project_id=${projectId} FOR UPDATE`
  yield* sql`UPDATE project_memory_embeddings v SET diagnostic=${diagnostic},attempts=LEAST(v.attempts::bigint+1,2147483647)::integer,next_attempt_at=clock_timestamp()+CASE WHEN v.attempts=0 THEN interval '1 minute' WHEN v.attempts=1 THEN interval '5 minutes' ELSE interval '15 minutes' END,updated_at=clock_timestamp() FROM projects p,project_memory_items e WHERE p.employee_id=v.employee_id AND p.id=v.project_id AND p.memory_embedding->>'config_id'=${input.config_id} AND e.employee_id=v.employee_id AND e.project_id=v.project_id AND e.id=v.item_id AND e.current_revision=v.revision AND e.status IN ('active','superseded') AND v.employee_id=${employeeId} AND v.project_id=${projectId} AND v.item_id=${input.item_id} AND v.revision=${input.revision} AND v.config_id=${input.config_id} AND v.embedding_text_hash=${input.embedding_text_hash} AND v.state='pending'`
})

export const embeddingStatus = Effect.fnUntraced(function* (
  employeeId: string,
  projectId: string,
  configId: string,
  mode: Pick<P.MemoryRecallInput, 'mode' | 'as_of' | 'include_inactive'> = {},
) {
  const sql = yield* SqlClient.SqlClient
  const [status] = yield* sql<{
    ready: number
    pending: number
    diagnostic: string | null
  }>`SELECT count(*) FILTER(WHERE v.state='ready')::float8 AS ready,count(*) FILTER(WHERE v.state='pending')::float8 AS pending,min(NULLIF(v.diagnostic,'')) AS diagnostic FROM project_memory_embeddings v JOIN project_memory_items e ON e.employee_id=v.employee_id AND e.project_id=v.project_id AND e.id=v.item_id JOIN project_memory_revisions r ON r.item_id=e.id AND r.revision=e.current_revision WHERE v.employee_id=${employeeId} AND v.project_id=${projectId} AND v.config_id=${configId} AND v.revision=e.current_revision AND ${memoryValiditySQL(sql, mode)}`
  return status!
})
