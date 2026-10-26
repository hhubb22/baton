import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as P from '@baton/protocol'
import { AppError } from '../../errors.ts'
import { transaction } from '../../database.ts'

export const requireProject = Effect.fnUntraced(function* (employeeId: string, projectId: string, lock = false) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    agent_id: string
    conversation_id: string
    status: string
  }>`SELECT a.id AS agent_id,c.id AS conversation_id,p.status FROM projects p JOIN project_agents a ON a.project_id=p.id AND a.employee_id=p.employee_id JOIN conversations c ON c.agent_id=a.id AND c.employee_id=p.employee_id WHERE p.employee_id=${employeeId} AND p.id=${projectId} ${lock ? sql`FOR NO KEY UPDATE OF a` : sql``}`
  if (!rows[0]) return yield* Effect.fail(new AppError(404, 'not_found'))
  if (lock) {
    const [project] = yield* sql<{
      status: string
    }>`SELECT status FROM projects WHERE employee_id=${employeeId} AND id=${projectId}`
    return { ...rows[0], status: project!.status }
  }
  return rows[0]
})

export const readProjectMemory = Effect.fnUntraced(function* (
  employeeId: string,
  projectId: string,
  itemId: string,
  revision?: number,
) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    value: P.ProjectMemory
  }>`SELECT (to_jsonb(r)-'employee_id'-'project_id'-'item_id'-'created_at') || jsonb_build_object('id',e.id,'updated_at',r.created_at,'effective',(r.revision=e.current_revision AND e.status IN ('active','superseded') AND (r.valid_from IS NULL OR r.valid_from<=now()) AND (r.valid_until IS NULL OR r.valid_until>now())),'status',e.status,'retracted',EXISTS(SELECT 1 FROM project_memory_suppressions x JOIN project_memory_revisions denied ON denied.employee_id=x.employee_id AND denied.project_id=x.project_id AND denied.item_id=x.item_id AND denied.revision=x.revision WHERE x.employee_id=e.employee_id AND x.project_id=e.project_id AND x.item_id=e.id AND x.revision>=r.revision AND x.kind='retracted' AND denied.content=r.content AND denied.conditions=r.conditions AND denied.semantic_key=r.semantic_key AND denied.valid_from IS NOT DISTINCT FROM r.valid_from AND denied.valid_until IS NOT DISTINCT FROM r.valid_until),'successor_id',e.successor_id,'suppression_id',(SELECT COALESCE(s.retirement_id,s.id) FROM project_memory_suppressions s WHERE s.employee_id=e.employee_id AND s.project_id=e.project_id AND s.item_id=e.id AND s.kind='retired' AND s.released_at IS NULL ORDER BY s.created_at DESC LIMIT 1),'evidence',COALESCE((SELECT jsonb_agg(jsonb_build_object('source_id',v.source_id,'start_byte',v.start_byte,'end_byte',v.end_byte,'source_hash',v.source_hash) ORDER BY v.source_id,v.start_byte,v.end_byte) FROM project_memory_evidence v WHERE v.employee_id=e.employee_id AND v.project_id=e.project_id AND v.item_id=e.id AND v.revision=r.revision),'[]'::jsonb)) AS value FROM project_memory_items e JOIN project_memory_revisions r ON r.employee_id=e.employee_id AND r.project_id=e.project_id AND r.item_id=e.id AND r.revision=COALESCE(${revision ?? null}::bigint,e.current_revision) WHERE e.employee_id=${employeeId} AND e.project_id=${projectId} AND e.id=${itemId}`
  if (!rows[0]) return yield* Effect.fail(new AppError(404, 'not_found'))
  return rows[0].value
})
export const getProjectMemory = (employeeId: string, projectId: string, itemId: string, revision?: number) =>
  transaction(readProjectMemory(employeeId, projectId, itemId, revision))

// 时间和状态过滤由规范记录决定，索引与主题不能恢复失效知识。
export const currentMemorySQL = (sql: SqlClient.SqlClient) =>
  sql`e.status IN ('active','superseded') AND (r.valid_from IS NULL OR r.valid_from<=now()) AND (r.valid_until IS NULL OR r.valid_until>now())`

export const memoryValiditySQL = (
  sql: SqlClient.SqlClient,
  input: Pick<P.MemoryRecallInput, 'mode' | 'as_of' | 'include_inactive'>,
) =>
  input.include_inactive
    ? sql`true`
    : input.mode === 'history'
      ? sql`e.status IN ('active','superseded') AND (${input.as_of ?? null}::timestamptz IS NULL OR ((r.valid_from IS NULL OR r.valid_from<=${input.as_of ?? null}::timestamptz) AND (r.valid_until IS NULL OR r.valid_until>${input.as_of ?? null}::timestamptz)))`
      : currentMemorySQL(sql)

export const listProjectMemory = (
  employeeId: string,
  projectId: string,
  afterId?: string,
  limit = 50,
  includeInactive = false,
  query = '',
) =>
  transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* requireProject(employeeId, projectId)
      const ids = yield* sql<{
        id: string
      }>`SELECT e.id FROM project_memory_items e JOIN project_memory_revisions r ON r.employee_id=e.employee_id AND r.project_id=e.project_id AND r.item_id=e.id AND r.revision=e.current_revision WHERE e.employee_id=${employeeId} AND e.project_id=${projectId} AND (${afterId ?? null}::uuid IS NULL OR e.id>${afterId ?? null}) AND (${includeInactive} OR (${currentMemorySQL(sql)})) AND (${query}='' OR strpos(lower(r.title||' '||r.content),lower(${query}))>0) ORDER BY e.id LIMIT ${limit + 1}`
      const entries = yield* Effect.forEach(ids.slice(0, limit), (row) =>
        readProjectMemory(employeeId, projectId, row.id),
      )
      return {
        entries: entries.filter((item) => includeInactive || item.effective),
        ...(ids.length > limit ? { next_after_id: entries.at(-1)!.id } : {}),
      }
    }),
  )

export const projectMemoryRevisions = (
  employeeId: string,
  projectId: string,
  itemId: string,
  afterRevision = 0,
  limit = 50,
) =>
  transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* readProjectMemory(employeeId, projectId, itemId)
      const rows = yield* sql<{
        revision: number
      }>`SELECT revision::float8 AS revision FROM project_memory_revisions WHERE employee_id=${employeeId} AND project_id=${projectId} AND item_id=${itemId} AND revision>${afterRevision} ORDER BY revision LIMIT ${limit + 1}`
      const revisions = yield* Effect.forEach(rows.slice(0, limit), (row) =>
        readProjectMemory(employeeId, projectId, itemId, row.revision),
      )
      return { revisions, ...(rows.length > limit ? { next_after_revision: revisions.at(-1)!.revision } : {}) }
    }),
  )

export const projectMemoryIndex = Effect.fnUntraced(function* (employeeId: string, projectId: string) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    title: string
  }>`SELECT r.title FROM project_memory_items e JOIN project_memory_revisions r ON r.employee_id=e.employee_id AND r.project_id=e.project_id AND r.item_id=e.id AND r.revision=e.current_revision WHERE e.employee_id=${employeeId} AND e.project_id=${projectId} AND ${currentMemorySQL(sql)} ORDER BY e.id LIMIT 129`
  let index = ''
  for (const [i, row] of rows.entries()) {
    const line = '- ' + row.title + '\n'
    if (i === 128 || Buffer.byteLength(index + line) > 2044) return index + '…'
    index += line
  }
  return index
})
