import { Effect, Predicate, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as P from '@baton/protocol'
import { checkMemoryContext, registerEventSource, saveSource } from './memory/index.ts'
import { canonical } from '../json.ts'
import { registerMemoryJob } from './memory-jobs.ts'
import {
  appendProjectEvent,
  checkPayloadSize,
  eventSelection,
  jsonBytes,
  projectDecode,
  projectError,
  type ProjectBinding,
} from './store.ts'

const objectRest = [Schema.Record(Schema.String, Schema.Json)] as const
const ToolCall = Schema.StructWithRest(
  Schema.Struct({ type: Schema.Literal('toolCall'), id: Schema.String, name: Schema.String, arguments: Schema.Json }),
  objectRest,
)
const Assistant = Schema.StructWithRest(
  Schema.Struct({
    format: Schema.Literal('pi-ai/1'),
    memory_context_id: P.UUID,
    message: Schema.StructWithRest(
      Schema.Struct({ role: Schema.Literal('assistant'), content: Schema.Array(Schema.Json) }),
      objectRest,
    ),
  }),
  objectRest,
)
export const savedToolCalls = Effect.fn('savedProjectToolCalls')(function* (payload: unknown) {
  const value = yield* projectDecode(Assistant, payload)
  const calls: (typeof ToolCall.Type)[] = []
  for (const item of value.message.content) {
    if (Predicate.isObject(item) && 'type' in item && item.type === 'toolCall')
      calls.push(yield* projectDecode(ToolCall, item))
  }
  return calls
})
export const previousClientEvent = Effect.fn('previousProjectClientEvent')(function* (
  binding: ProjectBinding,
  clientId: string,
  kind: string,
  payload: unknown,
) {
  const sql = yield* SqlClient.SqlClient
  if (!clientId || Buffer.byteLength(clientId) > 128 || clientId.includes('\0'))
    return yield* Effect.fail(projectError('invalid', 422))
  const rows = yield* sql<{
    value: unknown
  }>`SELECT ${eventSelection(sql)} AS value FROM conversation_events e WHERE conversation_id=${binding.conversationId} AND client_event_id=${clientId}`
  if (!rows[0]) return undefined
  const event = yield* projectDecode(P.ProjectEvent, rows[0].value)
  if (event.kind !== kind || canonical(event.payload) !== canonical(payload)) return yield* Effect.fail(projectError())
  return event
})
const assertToolsResolved = Effect.fn('assertProjectToolsResolved')(function* (binding: ProjectBinding) {
  const sql = yield* SqlClient.SqlClient
  const unresolved =
    yield* sql`SELECT 1 FROM conversation_events a CROSS JOIN LATERAL jsonb_array_elements(a.payload->'message'->'content') block
 WHERE a.conversation_id=${binding.conversationId} AND a.kind='assistant' AND block->>'type'='toolCall'
 AND NOT EXISTS(SELECT 1 FROM conversation_events r WHERE r.conversation_id=a.conversation_id AND r.kind='tool_result' AND r.tool_call_id=block->>'id') LIMIT 1`
  if (unresolved.length) return yield* Effect.fail(projectError())
})
export const appendAssistant = Effect.fn('appendProjectAssistant')(function* (
  binding: ProjectBinding,
  request: P.ProjectRuntimeRequest,
) {
  const payload = yield* projectDecode(Assistant, request.payload)
  yield* checkPayloadSize(payload)
  const old = yield* previousClientEvent(binding, request.client_event_id ?? '', 'assistant', payload)
  if (old) return old
  if ((request.last_seq ?? 0) !== binding.nextSeq - 1) return yield* Effect.fail(projectError())
  yield* assertToolsResolved(binding)
  yield* checkMemoryContext(binding, payload.memory_context_id, request.last_seq ?? 0)
  const sql = yield* SqlClient.SqlClient,
    calls = yield* savedToolCalls(payload),
    ids = new Set<string>()
  for (const call of calls) {
    if (!call.id || Buffer.byteLength(call.id) > 128 || Buffer.byteLength(call.name) > 128 || ids.has(call.id))
      return yield* Effect.fail(projectError('invalid', 422))
    ids.add(call.id)
    const used =
      yield* sql`SELECT 1 FROM conversation_events e CROSS JOIN LATERAL jsonb_array_elements(e.payload->'message'->'content') block
 WHERE e.conversation_id=${binding.conversationId} AND e.kind='assistant' AND block->>'type'='toolCall' AND block->>'id'=${call.id} LIMIT 1`
    if (used.length) return yield* Effect.fail(projectError())
  }
  const event = yield* appendProjectEvent(binding, 'assistant', payload, request.client_event_id!)
  const text = payload.message.content
    .flatMap((block) =>
      Predicate.isObject(block) &&
      'type' in block &&
      block.type === 'text' &&
      'text' in block &&
      typeof block.text === 'string'
        ? [block.text]
        : [],
    )
    .join('\n')
  if (text.trim())
    yield* saveSource(
      binding.employeeId,
      binding.projectId,
      `assistant:${binding.conversationId}:${event.seq}`,
      'assistant',
      'agent_report',
      text,
      event.seq,
    )
  if (!calls.length && payload.message.stopReason !== 'error' && payload.message.stopReason !== 'aborted')
    yield* registerMemoryJob(binding, event.seq)
  yield* sql`UPDATE conversations SET failure_count=0,next_attempt_at=NULL,attention_reason=NULL WHERE id=${binding.conversationId}`
  yield* sql`UPDATE attention_requests SET state='resolved',version=version+1,resolved_at=clock_timestamp(),updated_at=clock_timestamp() WHERE project_id=${binding.projectId} AND source='system' AND state='open'`
  return event
})
export const readRuntimeEvents = Effect.fn('readProjectRuntimeEvents')(function* (
  binding: ProjectBinding,
  after = 0,
  maxBytes = 128 * 1024,
) {
  if (
    !Number.isSafeInteger(after) ||
    after < 0 ||
    after > binding.nextSeq - 1 ||
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 128 * 1024
  )
    return yield* Effect.fail(projectError('invalid', 422))
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    value: unknown
  }>`SELECT ${eventSelection(sql)} AS value FROM conversation_events e WHERE conversation_id=${binding.conversationId} AND seq>${after} AND seq<${binding.nextSeq} ORDER BY seq LIMIT 100`
  const events: P.ProjectEvent[] = []
  let size = 0
  for (const row of rows) {
    const event = yield* projectDecode(P.ProjectEvent, row.value),
      bytes = jsonBytes(event)
    if (bytes > 192 * 1024 - 2048) return yield* Effect.fail(projectError('too_large', 413))
    if (events.length && size + bytes > maxBytes) break
    events.push(event)
    size += bytes
  }
  const next = events.at(-1)?.seq ?? after
  return { events, last_seq: binding.nextSeq - 1, next_after_seq: next, has_more: next < binding.nextSeq - 1 }
})
export const claimInputs = Effect.fn('claimProjectInputs')(function* (binding: ProjectBinding, lastSeq: number) {
  if (lastSeq !== binding.nextSeq - 1) return yield* Effect.fail(projectError())
  yield* assertToolsResolved(binding)
  const sql = yield* SqlClient.SqlClient
  const active =
    yield* sql`SELECT 1 FROM project_agent_input_queue WHERE agent_id=${binding.agentId} AND delivered_seq IS NULL AND source_type IN ('user_message','attention_answer','turn_ended','thread_message_failed') LIMIT 1`
  if (!active.length) return { payload_bytes: 0, input_count: 0 }
  const rows = yield* sql<{
    value: P.ProjectQueuedInput
    bytes: number
  }>`SELECT jsonb_build_object('id',q.id,'source_type',q.source_type,'source_key',q.source_key,'payload',q.payload) AS value,octet_length(q.payload::text) AS bytes
 FROM project_agent_input_queue q WHERE q.agent_id=${binding.agentId} AND q.delivered_seq IS NULL AND (q.source_type<>'memory_updated' OR NOT EXISTS(
 SELECT 1 FROM project_agent_input_queue newer WHERE newer.agent_id=q.agent_id AND newer.delivered_seq IS NULL AND newer.source_type='memory_updated'
 AND newer.payload->>'entry_id'=q.payload->>'entry_id' AND (newer.payload->>'revision')::bigint>(q.payload->>'revision')::bigint)) ORDER BY q.id LIMIT 20`
  const chosen: P.ProjectQueuedInput[] = [],
    ids: number[] = []
  let size = 0,
    payload: unknown
  for (const row of rows) {
    const item = yield* projectDecode(P.ProjectQueuedInput, row.value),
      bytes = Math.max(row.bytes, jsonBytes(item.payload))
    if (size + bytes > 128 * 1024) break
    const trial = {
      format: 'pi-ai/1',
      message: { role: 'user', content: [{ type: 'text', text: JSON.stringify([...chosen, item]) }], timestamp: 0 },
      input_ids: [...ids, item.id],
    }
    if (jsonBytes(trial) > 160 * 1024) break
    const [fits] = yield* sql<{ ok: boolean }>`SELECT octet_length(${JSON.stringify(trial)}::jsonb::text)<=163840 AS ok`
    if (!fits?.ok) break
    chosen.push(item)
    ids.push(item.id)
    size += bytes
    payload = trial
  }
  if (!chosen.length) return yield* Effect.fail(projectError('too_large', 413))
  const event = yield* appendProjectEvent(binding, 'input', payload)
  yield* sql`UPDATE project_agent_input_queue q SET delivered_seq=${event.seq} WHERE q.agent_id=${binding.agentId} AND q.delivered_seq IS NULL AND
 (q.id=ANY(${ids}::bigint[]) OR (q.source_type='memory_updated' AND EXISTS(SELECT 1 FROM project_agent_input_queue s
 WHERE s.id=ANY(${ids}::bigint[]) AND s.source_type='memory_updated' AND s.payload->>'entry_id'=q.payload->>'entry_id' AND (s.payload->>'revision')::bigint>=(q.payload->>'revision')::bigint)))`
  for (const item of chosen) {
    if (['user_message', 'attention_answer', 'thread_reply', 'turn_ended'].includes(item.source_type))
      yield* registerEventSource(binding.employeeId, binding.projectId, event.seq, event.seq, item.id)
  }
  return { event, payload_bytes: size, input_count: chosen.length }
})
