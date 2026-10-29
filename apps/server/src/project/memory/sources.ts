import { createHash, randomUUID } from 'node:crypto'
import { Effect, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as P from '@baton/protocol'
import { AppError } from '../../errors.ts'
import { transaction } from '../../database.ts'
import { strictDecode } from '../../decode.ts'
import { requireProject, currentMemorySQL } from './read.ts'
import { projectSourceDocuments } from './projection.ts'

export const hashText = (text: string) => createHash('sha256').update(text).digest('hex')
export const saveSource = Effect.fnUntraced(function* (
  employeeId: string,
  projectId: string,
  key: string,
  sourceType: string,
  role: string,
  text: string,
  sourceSeq?: number,
  inputId?: number,
) {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{
    id: string
  }>`INSERT INTO project_memory_sources(id,employee_id,project_id,source_key,source_type,role,text,source_hash,source_seq,input_id) VALUES(${randomUUID()},${employeeId},${projectId},${key},${sourceType},${role},${text},${hashText(text)},${sourceSeq ?? null},${inputId ?? null}) ON CONFLICT(employee_id,project_id,source_key) DO NOTHING RETURNING id`
  if (row) {
    yield* projectSourceDocuments(employeeId, projectId, row.id, text)
    return row.id
  }
  const [existing] = yield* sql<{
    id: string
  }>`SELECT id FROM project_memory_sources WHERE employee_id=${employeeId} AND project_id=${projectId} AND source_key=${key}`
  return existing!.id
})
const EventBody = Schema.Struct({
  message: Schema.Struct({
    content: Schema.Union([
      Schema.String,
      Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) })),
    ]),
  }),
})

// 只从已持久保存且前台已读到的原始位置登记来源；角色由中心记录生成。
export const registerEventSource = Effect.fnUntraced(function* (
  employeeId: string,
  projectId: string,
  throughSeq: number,
  seq: number,
  inputId?: number,
) {
  const sql = yield* SqlClient.SqlClient
  const binding = yield* requireProject(employeeId, projectId)
  if (seq > throughSeq) return yield* Effect.fail(new AppError(422, 'invalid_evidence'))
  if (inputId !== undefined) {
    const [row] = yield* sql<{
      source_type: string
      payload: P.ProjectQueuedInput['payload']
    }>`SELECT source_type,payload FROM project_agent_input_queue WHERE employee_id=${employeeId} AND agent_id=${binding.agent_id} AND id=${inputId} AND delivered_seq=${seq}`
    if (!row || !['user_message', 'thread_reply', 'turn_ended'].includes(row.source_type))
      return yield* Effect.fail(new AppError(422, 'invalid_evidence'))
    const payload = yield* strictDecode(Schema.Record(Schema.String, Schema.Json), row.payload)
    const role =
      row.source_type === 'user_message'
        ? 'user'
        : row.source_type === 'turn_ended' && payload.command_result
          ? 'execution'
          : 'agent_report'
    const text =
      typeof payload.content === 'string' && row.source_type === 'user_message' && payload.reference == null
        ? payload.content
        : JSON.stringify(payload)
    return yield* saveSource(employeeId, projectId, `input:${inputId}`, row.source_type, role, text, seq, inputId)
  }
  const [row] = yield* sql<{
    kind: string
    payload: unknown
  }>`SELECT kind,payload FROM conversation_events WHERE employee_id=${employeeId} AND conversation_id=${binding.conversation_id} AND seq=${seq}`
  if (!row || row.kind !== 'assistant') return yield* Effect.fail(new AppError(422, 'invalid_evidence'))
  const body = yield* Schema.decodeUnknownEffect(EventBody)(row.payload).pipe(
    Effect.mapError(() => new AppError(422, 'invalid_evidence')),
  )
  const text =
    typeof body.message.content === 'string'
      ? body.message.content
      : body.message.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join('\n')
  if (!text.trim()) return yield* Effect.fail(new AppError(422, 'invalid_evidence'))
  return yield* saveSource(
    employeeId,
    projectId,
    `assistant:${binding.conversation_id}:${seq}`,
    'assistant',
    'agent_report',
    text,
    seq,
  )
})
export const readSource = Effect.fnUntraced(function* (employeeId: string, projectId: string, sourceId: string) {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{
    value: P.MemorySource
  }>`SELECT (to_jsonb(s)-'employee_id'-'project_id'-'source_key') || jsonb_build_object('suppressed',EXISTS(SELECT 1 FROM project_memory_suppressions x WHERE x.employee_id=s.employee_id AND x.project_id=s.project_id AND x.released_at IS NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(x.evidence) v WHERE v->>'source_id'=s.id::text))) AS value FROM project_memory_sources s WHERE s.employee_id=${employeeId} AND s.project_id=${projectId} AND s.id=${sourceId}`
  if (!row) return yield* Effect.fail(new AppError(404, 'not_found'))
  return row.value
})
// 原始来源的状态由当前规范记录决定，历史检索和记忆召回使用相同标识。
export const sourceSearchState = Effect.fnUntraced(function* (employeeId: string, projectId: string, sourceId: string) {
  const sql = yield* SqlClient.SqlClient
  const [source] = yield* sql<{
    source_hash: string
    source_seq: number | null
    role: string
    suppressed: boolean
  }>`SELECT s.source_hash,s.source_seq::float8 AS source_seq,s.role,EXISTS(SELECT 1 FROM project_memory_suppressions x WHERE x.employee_id=s.employee_id AND x.project_id=s.project_id AND x.released_at IS NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(x.evidence) v WHERE v->>'source_id'=s.id::text)) AS suppressed FROM project_memory_sources s WHERE s.employee_id=${employeeId} AND s.project_id=${projectId} AND s.id=${sourceId}`
  if (!source) return yield* Effect.fail(new AppError(404, 'not_found'))
  const related = yield* sql<{
    item_id: string
    status: P.ProjectMemory['status']
    effective: boolean
  }>`SELECT DISTINCT e.id AS item_id,e.status,(${currentMemorySQL(sql)}) AS effective FROM project_memory_evidence v JOIN project_memory_items e ON e.id=v.item_id JOIN project_memory_revisions r ON r.item_id=e.id AND r.revision=e.current_revision WHERE v.employee_id=${employeeId} AND v.project_id=${projectId} AND v.source_id=${sourceId}`
  return { source_id: sourceId, ...source, related_items: related }
})

const boundary = (bytes: Buffer, n: number) =>
  n >= 0 && n <= bytes.length && (n === bytes.length || (bytes[n]! & 0xc0) !== 0x80)
export const sourcePage = Effect.fnUntraced(function* (
  employeeId: string,
  projectId: string,
  sourceId: string,
  offset = 0,
  maxBytes = 32768,
) {
  const source = yield* readSource(employeeId, projectId, sourceId)
  const bytes = Buffer.from(source.text)
  if (!boundary(bytes, offset)) return yield* Effect.fail(new AppError(422, 'invalid_range'))
  let end = Math.min(bytes.length, offset + maxBytes)
  while (!boundary(bytes, end)) end--
  return {
    ...source,
    text: bytes.subarray(offset, end).toString(),
    offset,
    next_offset: end,
    has_more: end < bytes.length,
  }
})
export const getMemorySource = (
  employeeId: string,
  projectId: string,
  sourceId: string,
  offset?: number,
  maxBytes?: number,
) => transaction(sourcePage(employeeId, projectId, sourceId, offset, maxBytes))

export const validateEvidence = Effect.fnUntraced(function* (
  employeeId: string,
  projectId: string,
  evidence: readonly P.MemoryEvidence[],
  throughSeq?: number,
) {
  if (!evidence.length || evidence.length > 32) return yield* Effect.fail(new AppError(422, 'invalid_evidence'))
  const sources: P.MemorySource[] = []
  for (const ref of evidence) {
    const source = yield* readSource(employeeId, projectId, ref.source_id)
    const bytes = Buffer.from(source.text)
    if (
      source.source_hash !== ref.source_hash ||
      ref.end_byte <= ref.start_byte ||
      !boundary(bytes, ref.start_byte) ||
      !boundary(bytes, ref.end_byte) ||
      (throughSeq !== undefined && (source.source_seq === null || source.source_seq > throughSeq))
    )
      return yield* Effect.fail(new AppError(422, 'invalid_evidence'))
    sources.push(source)
  }
  return sources
})
