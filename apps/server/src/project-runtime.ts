import { randomUUID } from 'node:crypto'
import { Effect, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as P from '@baton/protocol'
import type { NodeSource } from './errors.ts'
import { lockNodeSource, revalidateNodeSource } from './nodes.ts'
import {
  appendProjectEvent,
  checkPayloadSize,
  boundedProjectText,
  eventSelection,
  jsonBytes,
  projectDecode,
  projectError,
  projectTransaction,
  readEvent,
  readProject,
  releaseProjectRun,
  type ProjectBinding,
} from './project-store.ts'
import { appendAssistant, claimInputs, readRuntimeEvents, savedToolCalls } from './project-events.ts'
import { commitCompaction, projectMemoryIndex } from './project-compaction.ts'
import {
  consumeProjectExecInputs,
  executeProjectTool,
  waitProjectTool,
  type ProjectToolContext,
} from './project-tools.ts'
import { canonical } from './threads-core.ts'
import { saveProjectPreview } from './project-preview.ts'

const leaseLost = () => projectError('lease_lost')
const checkLease = Effect.fn('checkProjectLease')(function* (b: ProjectBinding) {
  const sql = yield* SqlClient.SqlClient
  const rows =
    yield* sql`SELECT 1 FROM project_agents WHERE id=${b.agentId} AND lease_run_id=${b.runId} AND lease_epoch=${b.leaseEpoch} AND lease_until>clock_timestamp()`
  if (!rows.length) return yield* Effect.fail(leaseLost())
})
const bindRun = Effect.fn('bindProjectRun')(function* (source: NodeSource, request: P.ProjectRuntimeRequest) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    id: string
  }>`SELECT a.id FROM project_agents a JOIN agent_runs r ON r.agent_id=a.id WHERE r.id=${request.run_id} AND r.employee_id=${source.employee_id} AND r.node_id=${source.node_id} FOR NO KEY UPDATE OF a`
  if (!rows[0]) return yield* Effect.fail(leaseLost())
  yield* lockNodeSource(source)
  const [row] = yield* sql<{
    employeeId: string
    projectId: string
    agentId: string
    conversationId: string
    nextSeq: string
    provider: string
    model: string
    promptVersion: string
  }>`SELECT a.employee_id AS "employeeId",a.project_id AS "projectId",a.id AS "agentId",c.id AS "conversationId",c.next_seq AS "nextSeq",r.provider,r.model,a.prompt_version AS "promptVersion"
 FROM project_agents a JOIN agent_runs r ON r.id=a.lease_run_id JOIN projects p ON p.id=a.project_id JOIN conversations c ON c.agent_id=a.id
 WHERE a.id=${rows[0].id} AND r.id=${request.run_id} AND a.lease_epoch=${request.lease_epoch} AND r.lease_epoch=${request.lease_epoch}
 AND a.lease_until>clock_timestamp() AND r.state IN ('starting','running') AND p.status='active' FOR UPDATE OF c`
  if (!row) return yield* Effect.fail(leaseLost())
  yield* sql`SELECT id FROM agent_runs WHERE id=${request.run_id} FOR UPDATE`
  yield* revalidateNodeSource(source)
  const b: ProjectBinding = {
    ...row,
    nextSeq: Number(row.nextSeq),
    runId: request.run_id,
    leaseEpoch: request.lease_epoch,
  }
  yield* checkLease(b)
  return b
})
const stopReceipt = Effect.fn('acknowledgeProjectStop')(function* (
  source: NodeSource,
  request: P.ProjectRuntimeRequest,
) {
  const sql = yield* SqlClient.SqlClient
  yield* lockNodeSource(source)
  const rows =
    yield* sql`SELECT id FROM agent_runs WHERE id=${request.run_id} AND employee_id=${source.employee_id} AND node_id=${source.node_id} AND lease_epoch=${request.lease_epoch} AND state IN ('finished','lost','failed') FOR UPDATE`
  if (!rows.length) return yield* Effect.fail(leaseLost())
  yield* revalidateNodeSource(source)
  yield* sql`UPDATE agent_runs SET stop_acked_at=COALESCE(stop_acked_at,clock_timestamp()) WHERE id=${request.run_id}`
  return {}
})
const bootstrap = Effect.fn('bootstrapProjectRun')(function* (b: ProjectBinding) {
  const sql = yield* SqlClient.SqlClient
  const project = yield* readProject(b.employeeId, b.projectId)
  const [row] = yield* sql<{
    compaction_seq: string | null
  }>`SELECT compaction_seq FROM conversations WHERE id=${b.conversationId}`
  const compaction = row?.compaction_seq ? yield* readEvent(b.conversationId, Number(row.compaction_seq)) : undefined
  const boundary = compaction
    ? yield* projectDecode(
        Schema.StructWithRest(Schema.Struct({ through_seq: Schema.Int }), [Schema.Record(Schema.String, Schema.Json)]),
        compaction.payload,
      )
    : undefined
  const out: { -readonly [K in keyof P.ProjectBootstrap]: P.ProjectBootstrap[K] } = {
    project: { ...project, agent: { ...project.agent, provider: b.provider, model: b.model } },
    prompt_version: b.promptVersion,
    memory_index: yield* projectMemoryIndex(b.projectId),
    after_seq: boundary?.through_seq ?? 0,
    last_seq: b.nextSeq - 1,
    ...(compaction ? { compaction, compaction_seq: compaction.seq } : {}),
  }
  if (jsonBytes(out) > 192 * 1024 - 2048) delete out.compaction
  if (jsonBytes(out) > 192 * 1024 - 2048) {
    out.goal_utf8_base64 = Buffer.from(out.project.goal).toString('base64')
    out.project = { ...out.project, goal: '' }
  }
  return out
})
const toolRequest = Effect.fn('callProjectTool')(function* (b: ProjectBinding, request: P.ProjectRuntimeRequest) {
  const sql = yield* SqlClient.SqlClient,
    id = request.tool_call_id ?? ''
  if (!id) return yield* Effect.fail(projectError('invalid', 422))
  const old = yield* sql<{
    value: unknown
  }>`SELECT ${eventSelection(sql)} AS value FROM conversation_events e WHERE conversation_id=${b.conversationId} AND kind='tool_result' AND tool_call_id=${id}`
  if (old[0]) return yield* projectDecode(P.ProjectEvent, old[0].value)
  if ((request.last_seq ?? 0) !== b.nextSeq - 1) return yield* Effect.fail(projectError())
  const [assistant] = yield* sql<{
    seq: string
    payload: unknown
  }>`SELECT seq,payload FROM conversation_events WHERE conversation_id=${b.conversationId} AND kind='assistant' ORDER BY seq DESC LIMIT 1`
  if (!assistant) return yield* Effect.fail(projectError('invalid', 422))
  const calls = yield* savedToolCalls(assistant.payload),
    index = calls.findIndex((c) => c.id === id)
  if (index < 0) return yield* Effect.fail(projectError('invalid', 422))
  const call = calls[index]!
  if (
    request.operation === 'call_tool' &&
    (call.name !== request.tool_name || canonical(call.arguments) !== canonical(request.arguments))
  )
    return yield* Effect.fail(projectError('invalid', 422))
  for (const before of calls.slice(0, index)) {
    const found =
      yield* sql`SELECT 1 FROM conversation_events WHERE conversation_id=${b.conversationId} AND kind='tool_result' AND tool_call_id=${before.id}`
    if (!found.length) return yield* Effect.fail(projectError())
  }
  const ctx: ProjectToolContext = {
    employeeId: b.employeeId,
    projectId: b.projectId,
    agentId: b.agentId,
    conversationId: b.conversationId,
    runId: b.runId,
    leaseEpoch: b.leaseEpoch,
    assistantSeq: Number(assistant.seq),
    toolCallId: id,
  }
  if (request.operation === 'wait_tool' && call.name !== 'nodes.exec')
    return yield* Effect.fail(projectError('invalid', 422))
  const finish =
    request.operation === 'wait_tool'
      ? yield* projectDecode(Schema.Struct({ finish_wait: Schema.optionalKey(Schema.Boolean) }), request.payload ?? {})
      : { finish_wait: false }
  const result =
    request.operation === 'wait_tool'
      ? yield* waitProjectTool(ctx, finish.finish_wait ?? false)
      : yield* executeProjectTool(ctx, call.name, call.arguments)
  if (result.pending) return result.value
  const payload = {
    format: 'pi-ai/1',
    ...(result.consumeThreadId ? { consumed_thread_id: result.consumeThreadId } : {}),
    message: {
      role: 'toolResult',
      toolCallId: id,
      toolName: call.name,
      content: [{ type: 'text', text: JSON.stringify(result.value) }],
      isError: result.isError ?? false,
      timestamp: 0,
    },
  }
  yield* checkPayloadSize(payload, 32 * 1024)
  const event = yield* appendProjectEvent(b, 'tool_result', payload, null, id)
  if (result.consumeThreadId) yield* consumeProjectExecInputs(ctx, result.consumeThreadId, event.seq)
  return event
})
const readPendingTool = Effect.fn('readPendingProjectTool')(function* (
  source: NodeSource,
  request: P.ProjectRuntimeRequest,
) {
  const finish = yield* projectDecode(
    Schema.Struct({ finish_wait: Schema.optionalKey(Schema.Boolean) }),
    request.payload ?? {},
  )
  if (finish.finish_wait) return undefined
  return yield* projectTransaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`
      yield* revalidateNodeSource(source)
      const [binding] = yield* sql<{
        conversation_id: string
        project_id: string
        next_seq: string
      }>`SELECT c.id AS conversation_id,a.project_id,c.next_seq
 FROM project_agents a JOIN agent_runs r ON r.id=a.lease_run_id JOIN projects p ON p.id=a.project_id JOIN conversations c ON c.agent_id=a.id
 WHERE r.id=${request.run_id} AND r.node_id=${source.node_id} AND r.employee_id=${source.employee_id} AND a.lease_epoch=${request.lease_epoch} AND r.lease_epoch=${request.lease_epoch}
 AND a.lease_until>clock_timestamp() AND r.state IN ('starting','running') AND p.status='active'`
      if (!binding) return yield* Effect.fail(leaseLost())
      if ((request.last_seq ?? 0) !== Number(binding.next_seq) - 1) return undefined
      const id = request.tool_call_id ?? ''
      const [assistant] = yield* sql<{
        payload: unknown
      }>`SELECT payload FROM conversation_events WHERE conversation_id=${binding.conversation_id} AND kind='assistant' ORDER BY seq DESC LIMIT 1`
      if (!assistant) return undefined
      const calls = yield* savedToolCalls(assistant.payload),
        index = calls.findIndex((call) => call.id === id)
      if (index < 0 || calls[index]!.name !== 'nodes.exec') return undefined
      const results = yield* sql<{
        tool_call_id: string
      }>`SELECT tool_call_id FROM conversation_events WHERE conversation_id=${binding.conversation_id} AND kind='tool_result' AND tool_call_id=ANY(${calls.map((call) => call.id)}::text[])`
      const done = new Set(results.map((row) => row.tool_call_id))
      if (done.has(id) || calls.slice(0, index).some((call) => !done.has(call.id))) return undefined
      const [thread] = yield* sql<{
        id: string
        version: string
        remaining: number
      }>`SELECT t.id,t.version,GREATEST(0,FLOOR(EXTRACT(EPOCH FROM(t.exec_wait_until-clock_timestamp()))*1000))::float8 AS remaining
 FROM threads t WHERE t.employee_id=${source.employee_id} AND t.project_id=${binding.project_id} AND t.origin_conversation_id=${binding.conversation_id} AND t.origin_tool_call_id=${id}
 AND t.agent_type='shell' AND t.status NOT IN ('stopped','unknown','archived') AND t.exec_wait_until>clock_timestamp()
 AND NOT EXISTS(SELECT 1 FROM thread_turns v WHERE v.thread_id=t.id AND v.ended_at IS NOT NULL)`
      if (!thread) return undefined
      yield* revalidateNodeSource(source)
      const valid =
        yield* sql`SELECT 1 FROM project_agents a JOIN agent_runs r ON r.id=a.lease_run_id WHERE r.id=${request.run_id} AND a.lease_epoch=${request.lease_epoch} AND a.lease_until>clock_timestamp()`
      if (!valid.length) return yield* Effect.fail(leaseLost())
      return {
        pending: true,
        thread_id: thread.id,
        version: Number(thread.version),
        wait_remaining_ms: thread.remaining,
        wait_protocol: 1,
      }
    }),
  )
})
export const runtimeRequest = Effect.fn('projectRuntimeRequest')(function* (
  source: NodeSource,
  input: P.ProjectRuntimeRequest,
) {
  const request = yield* projectDecode(P.ProjectRuntimeRequest, input)
  if (request.lease_epoch < 1 || request.reason?.includes('\0')) return yield* Effect.fail(projectError('invalid', 422))
  if (request.operation === 'wait_tool') {
    const pending = yield* readPendingTool(source, request).pipe(
      Effect.mapError((error) => (error.code === 'node_source_rejected' ? leaseLost() : error)),
    )
    if (pending) return pending
  }
  const response = yield* projectTransaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      if (request.operation === 'stopped') return yield* stopReceipt(source, request)
      const b = yield* bindRun(source, request)
      let data: unknown,
        released = false
      switch (request.operation) {
        case 'bootstrap':
          data = yield* bootstrap(b)
          break
        case 'read_events':
          data = yield* readRuntimeEvents(b, request.after_seq ?? 0, request.max_bytes ?? 128 * 1024)
          break
        case 'append_event':
          data = yield* appendAssistant(b, request)
          break
        case 'claim_inputs':
          data = yield* claimInputs(b, request.last_seq ?? 0)
          break
        case 'commit_compaction':
          data = yield* commitCompaction(b, request)
          break
        case 'call_tool':
        case 'wait_tool':
          data = yield* toolRequest(b, request)
          break
        case 'started':
        case 'renew':
          yield* checkLease(b)
          if (request.operation === 'started')
            yield* sql`UPDATE agent_runs SET state='running' WHERE id=${b.runId} AND state='starting'`
          const renewed =
            yield* sql`UPDATE project_agents SET lease_until=clock_timestamp()+interval '60 seconds' WHERE id=${b.agentId} AND lease_until>clock_timestamp() RETURNING id`
          if (!renewed.length) return yield* Effect.fail(leaseLost())
          data = { lease_seconds: 60, control_receipts: 1 }
          break
        case 'wake_received': {
          const receipt = yield* projectDecode(Schema.Struct({ input_ids: Schema.Array(Schema.Int) }), request.payload)
          if (
            !receipt.input_ids.length ||
            receipt.input_ids.length > 32 ||
            receipt.input_ids.some((id) => id <= 0) ||
            new Set(receipt.input_ids).size !== receipt.input_ids.length
          )
            return yield* Effect.fail(projectError('invalid', 422))
          yield* sql`UPDATE project_agent_input_queue SET wake_required=false WHERE agent_id=${b.agentId} AND id=ANY(${receipt.input_ids}::bigint[]) AND delivered_seq IS NULL AND wake_required`
          data = {}
          break
        }
        case 'preview':
          if ((request.last_seq ?? 0) !== b.nextSeq - 1) return yield* Effect.fail(projectError())
          data = {}
          break
        case 'finish':
        case 'exited':
        case 'start_failed':
        case 'report_failure': {
          const reason = boundedProjectText(request.reason ?? '', 1024)
          if (request.operation === 'report_failure') {
            const [conversation] = yield* sql<{
              failure_count: number
            }>`UPDATE conversations SET failure_count=LEAST(failure_count::bigint+1,2147483647)::integer,next_attempt_at=clock_timestamp()+CASE WHEN failure_count=0 THEN interval '1 minute' WHEN failure_count=1 THEN interval '5 minutes' ELSE interval '15 minutes' END,
 state='active',attention_reason=${reason} WHERE id=${b.conversationId} RETURNING failure_count`
            if (conversation?.failure_count === 3)
              yield* sql`INSERT INTO attention_requests(id,employee_id,project_id,agent_id,conversation_id,source,condition_type,condition_object_id,title,content)
 VALUES(${randomUUID()},${b.employeeId},${b.projectId},${b.agentId},${b.conversationId},'system','project_needs_attention',${b.projectId},'Project 需要处理',${reason}) ON CONFLICT DO NOTHING`
          }
          yield* checkLease(b)
          yield* releaseProjectRun(
            b.agentId,
            request.operation === 'report_failure' || request.operation === 'start_failed'
              ? 'failed'
              : request.operation === 'exited'
                ? 'lost'
                : 'finished',
            reason,
            request.operation === 'finish' || request.operation === 'report_failure' ? 2 : 0,
          )
          released = true
          data = {}
          break
        }
        default:
          return yield* Effect.fail(projectError('invalid', 422))
      }
      if (!released) yield* checkLease(b)
      yield* revalidateNodeSource(source)
      if (jsonBytes({ type: 'project_runtime.result', ok: true, data }) > 192 * 1024)
        return yield* Effect.fail(projectError('too_large', 413))
      return data
    }),
  ).pipe(Effect.mapError((error) => (error.code === 'node_source_rejected' ? leaseLost() : error)))
  if (request.operation === 'preview') yield* saveProjectPreview(request.run_id, request.last_seq ?? 0, request.payload)
  return response
})
