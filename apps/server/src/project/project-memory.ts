import { randomUUID } from 'node:crypto'
import { Effect, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as P from '@baton/protocol'
import { AppError } from '../errors.ts'
import { transaction } from '../database.ts'
import { insertProjectInput } from './project-inputs.ts'

export const strictDecode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: 'error' }).pipe(
    Effect.mapError(() => new AppError(422, 'invalid')),
  )

const requireProject = Effect.fnUntraced(function* (employeeId: string, projectId: string) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    agent_id: string
    conversation_id: string
  }>`SELECT a.id AS agent_id,c.id AS conversation_id FROM projects p JOIN project_agents a ON a.project_id=p.id AND a.employee_id=p.employee_id JOIN conversations c ON c.agent_id=a.id AND c.employee_id=p.employee_id WHERE p.employee_id=${employeeId} AND p.id=${projectId}`
  if (!rows.length) return yield* Effect.fail(new AppError(404, 'not_found'))
  return rows[0]!
})

export const readProjectMemory = Effect.fnUntraced(function* (
  employeeId: string,
  projectId: string,
  entryId: string,
  revision?: number,
) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    value: P.ProjectMemory
  }>`SELECT jsonb_build_object('id',e.id,'title',COALESCE(r.title,e.title),'content',r.content,'revision',r.revision,'author',r.author,'source_seq',r.source_seq,'updated_at',r.created_at) AS value FROM project_memory_entries e JOIN project_memory_revisions r ON r.employee_id=e.employee_id AND r.entry_id=e.id AND r.revision=COALESCE(${revision ?? null}::bigint,e.current_revision) WHERE e.employee_id=${employeeId} AND e.project_id=${projectId} AND e.id=${entryId}`
  if (!rows.length) return yield* Effect.fail(new AppError(404, 'not_found'))
  return yield* Schema.decodeUnknownEffect(P.ProjectMemory)(rows[0]!.value).pipe(
    Effect.mapError(() => new AppError(503, 'invalid_memory_record')),
  )
})
export const getProjectMemory = (employeeId: string, projectId: string, entryId: string, revision?: number) =>
  transaction(
    Effect.gen(function* () {
      yield* strictDecode(P.UUID, entryId)
      if (revision !== undefined) yield* strictDecode(P.PositiveInteger, revision)
      return yield* readProjectMemory(employeeId, projectId, entryId, revision)
    }),
  )

export const listProjectMemory = (employeeId: string, projectId: string, afterId?: string, limit = 50) =>
  transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* requireProject(employeeId, projectId)
      if (afterId) yield* strictDecode(P.UUID, afterId)
      yield* strictDecode(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })), limit)
      const ids = yield* sql<{
        id: string
      }>`SELECT id FROM project_memory_entries WHERE employee_id=${employeeId} AND project_id=${projectId} AND (${afterId ?? null}::uuid IS NULL OR id>${afterId ?? null}) ORDER BY id LIMIT ${limit + 1}`
      const entries: P.ProjectMemory[] = []
      for (const row of ids.slice(0, limit)) entries.push(yield* readProjectMemory(employeeId, projectId, row.id))
      return { entries, ...(ids.length > limit ? { next_after_id: entries.at(-1)!.id } : {}) }
    }),
  )

export const writeProjectMemoryTx = Effect.fnUntraced(function* (
  employeeId: string,
  projectId: string,
  entryId: string | undefined,
  input: P.WriteMemoryInput,
  author: 'user' | 'agent',
  sourceSeq?: number,
) {
  const sql = yield* SqlClient.SqlClient
  const valid = yield* strictDecode(P.WriteMemoryInput, input)
  if (valid.expected_revision >= Number.MAX_SAFE_INTEGER) return yield* Effect.fail(new AppError(422, 'invalid'))
  const binding = yield* requireProject(employeeId, projectId)
  if (entryId !== undefined) yield* strictDecode(P.UUID, entryId)
  if (sourceSeq !== undefined) {
    const exists =
      yield* sql`SELECT seq FROM conversation_events WHERE employee_id=${employeeId} AND conversation_id=${binding.conversation_id} AND seq=${sourceSeq}`
    if (!exists.length) return yield* Effect.fail(new AppError(422, 'invalid_source_seq'))
  }
  const id = entryId ?? randomUUID()
  let created = false
  if (valid.expected_revision === 0) {
    const inserted =
      yield* sql`INSERT INTO project_memory_entries(id,employee_id,project_id,title,current_revision) VALUES(${id},${employeeId},${projectId},${valid.title},1) ON CONFLICT(id) DO NOTHING RETURNING id`
    created = inserted.length > 0
  }
  if (!created) {
    const rows = yield* sql<{
      current_revision: number
    }>`SELECT current_revision::float8 AS current_revision FROM project_memory_entries WHERE employee_id=${employeeId} AND project_id=${projectId} AND id=${id} FOR UPDATE`
    if (!rows.length) return yield* Effect.fail(new AppError(404, 'not_found'))
    if (rows[0]!.current_revision !== valid.expected_revision) {
      const current = yield* readProjectMemory(employeeId, projectId, id)
      return yield* Effect.fail(
        new AppError(409, 'memory_conflict', '记忆版本已变化', { current, current_revision: current.revision }),
      )
    }
  }
  const revision = valid.expected_revision + 1
  yield* sql`INSERT INTO project_memory_revisions(entry_id,employee_id,revision,title,content,author,source_seq) VALUES(${id},${employeeId},${revision},${valid.title},${valid.content},${author},${sourceSeq ?? null})`
  yield* sql`UPDATE project_memory_entries SET title=${valid.title},current_revision=${revision},updated_at=clock_timestamp() WHERE employee_id=${employeeId} AND project_id=${projectId} AND id=${id}`
  if (author === 'user')
    yield* insertProjectInput(employeeId, binding.agent_id, 'memory_updated', `memory:${id}:rev:${revision}`, {
      entry_id: id,
      title: valid.title,
      revision,
      author,
    })
  return yield* readProjectMemory(employeeId, projectId, id)
})
export const writeProjectMemory = (
  employeeId: string,
  projectId: string,
  entryId: string | undefined,
  input: P.WriteMemoryInput,
) => transaction(writeProjectMemoryTx(employeeId, projectId, entryId, input, 'user'))

export const projectMemoryRevisions = (
  employeeId: string,
  projectId: string,
  entryId: string,
  afterRevision = 0,
  limit = 50,
) =>
  transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* strictDecode(P.NonNegativeInteger, afterRevision)
      yield* strictDecode(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })), limit)
      yield* readProjectMemory(employeeId, projectId, entryId)
      const rows = yield* sql<{
        value: P.MemoryRevision
      }>`SELECT jsonb_build_object('revision',r.revision,'title',r.title,'content',r.content,'author',r.author,'created_at',r.created_at) AS value FROM project_memory_revisions r WHERE r.employee_id=${employeeId} AND r.entry_id=${entryId} AND r.revision>${afterRevision} ORDER BY r.revision LIMIT ${limit + 1}`
      const revisions = rows.slice(0, limit).map((row) => row.value)
      return { revisions, ...(rows.length > limit ? { next_after_revision: revisions.at(-1)!.revision } : {}) }
    }),
  )
