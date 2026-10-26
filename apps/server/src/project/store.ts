import { Effect, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import type { SqlError } from 'effect/sql/SqlError'
import { Project, ProjectEvent } from '@baton/protocol'
import { AppError } from '../errors.ts'
import { dbError, type DatabaseEffect } from '../database.ts'

export const projectError = (code = 'conflict', status = 409) => new AppError(status, code)
export const projectTransaction = <A>(
  body: Effect.Effect<A, AppError | SqlError, SqlClient.SqlClient>,
): DatabaseEffect<A> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(body)
  }).pipe(Effect.mapError(dbError))
export const projectDecode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })(value),
    catch: () => projectError('invalid', 422),
  })
export const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
export const projectSelection = (sql: SqlClient.SqlClient) => sql`jsonb_build_object(
 'id',p.id,'title',p.title,'goal',p.goal,'memory_embedding',p.memory_embedding,'status',p.status,'version',p.version,'created_at',p.created_at,'updated_at',p.updated_at,
 'agent',jsonb_build_object('id',a.id,'provider',a.provider,'model',a.model),
 'conversation',jsonb_build_object('id',c.id,'state',c.state,'last_seq',c.next_seq-1))`
export const readProject = Effect.fn('readProject')(function* (employee: string, id: string) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ value: unknown }>`SELECT ${projectSelection(sql)} AS value FROM projects p
 JOIN project_agents a ON a.project_id=p.id AND a.employee_id=p.employee_id
 JOIN conversations c ON c.agent_id=a.id AND c.employee_id=a.employee_id WHERE p.employee_id=${employee} AND p.id=${id}`
  if (!rows[0]) return yield* Effect.fail(projectError('not_found', 404))
  return yield* projectDecode(Project, rows[0].value)
})
export const lockProjectAgent = Effect.fn('lockProjectAgent')(function* (employee: string, project: string) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    id: string
  }>`SELECT id FROM project_agents WHERE employee_id=${employee} AND project_id=${project} FOR NO KEY UPDATE`
  if (!rows[0]) return yield* Effect.fail(projectError('not_found', 404))
  return rows[0].id
})
export const eventSelection = (sql: SqlClient.SqlClient) => sql`jsonb_strip_nulls(to_jsonb(e)-'employee_id')`
export const readEvent = Effect.fn('readProjectEvent')(function* (conversation: string, seq: number) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    value: unknown
  }>`SELECT ${eventSelection(sql)} AS value FROM conversation_events e WHERE conversation_id=${conversation} AND seq=${seq}`
  if (!rows[0]) return yield* Effect.fail(projectError('not_found', 404))
  return yield* projectDecode(ProjectEvent, rows[0].value)
})
export interface ProjectBinding {
  employeeId: string
  projectId: string
  agentId: string
  conversationId: string
  runId: string
  leaseEpoch: number
  nextSeq: number
  provider: string
  model: string
  promptVersion: string
}
export const checkPayloadSize = Effect.fn('checkProjectPayloadSize')(function* (value: unknown, limit = 160 * 1024) {
  const sql = yield* SqlClient.SqlClient
  const raw = JSON.stringify(value)
  if (Buffer.byteLength(raw) > limit) return yield* Effect.fail(projectError('too_large', 413))
  const [row] = yield* sql<{ fits: boolean }>`SELECT octet_length(${raw}::jsonb::text)<=${limit} AS fits`
  if (!row?.fits) return yield* Effect.fail(projectError('too_large', 413))
})
export const appendProjectEvent = Effect.fn('appendProjectEvent')(function* (
  binding: ProjectBinding,
  kind: 'input' | 'assistant' | 'tool_result' | 'compaction',
  payload: unknown,
  clientEventId: string | null = null,
  toolCallId: string | null = null,
) {
  const sql = yield* SqlClient.SqlClient
  yield* checkPayloadSize(payload)
  yield* sql`INSERT INTO conversation_events(conversation_id,seq,employee_id,kind,client_event_id,tool_call_id,run_id,lease_epoch,payload)
 VALUES(${binding.conversationId},${binding.nextSeq},${binding.employeeId},${kind},${clientEventId},${toolCallId},${binding.runId},${binding.leaseEpoch},${JSON.stringify(payload)}::jsonb)`
  yield* sql`UPDATE conversations SET next_seq=next_seq+1 WHERE id=${binding.conversationId}`
  return yield* readEvent(binding.conversationId, binding.nextSeq)
})
export const releaseProjectRun = Effect.fn('releaseProjectRun')(function* (
  agent: string,
  state: string,
  reason: string,
  graceSeconds = 0,
) {
  const sql = yield* SqlClient.SqlClient
  yield* sql`UPDATE agent_runs r SET state=${state},ended_at=clock_timestamp(),end_reason=${reason},stop_requested_at=clock_timestamp(),
 command_next_at=clock_timestamp()+${graceSeconds}*interval '1 second',command_attempts=0
 FROM project_agents a WHERE a.id=${agent} AND r.id=a.lease_run_id AND r.state IN ('starting','running')`
  yield* sql`UPDATE project_agents SET lease_run_id=NULL,lease_until=NULL WHERE id=${agent}`
})
export const activeInputSQL = (sql: SqlClient.SqlClient) =>
  sql`('user_message','attention_answer','turn_ended','thread_message_failed')`
export const recoveryWorkSQL = (sql: SqlClient.SqlClient) => sql`(
 EXISTS(SELECT 1 FROM project_agent_input_queue q WHERE q.agent_id=a.id AND delivered_seq IS NULL AND source_type IN ${activeInputSQL(sql)})
 OR EXISTS(SELECT 1 FROM conversation_events e WHERE e.conversation_id=c.id
 AND e.seq=(SELECT max(t.seq) FROM conversation_events t WHERE t.conversation_id=c.id AND t.kind<>'compaction')
 AND (e.kind IN ('input','tool_result') OR (e.kind='assistant' AND jsonb_path_exists(e.payload,'$.message.content[*] ? (@.type == "toolCall")')))))`
export const boundedProjectText = (text: string, limit: number): string => {
  const bytes = Buffer.from(text)
  if (bytes.length <= limit) return text
  let head = Math.floor(limit / 2),
    tail = bytes.length - (limit - head)
  while (head > 0 && (bytes[head]! & 0xc0) === 0x80) head--
  while (tail < bytes.length && (bytes[tail]! & 0xc0) === 0x80) tail++
  return bytes.subarray(0, head).toString('utf8') + bytes.subarray(tail).toString('utf8')
}
