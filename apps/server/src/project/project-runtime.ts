import { randomUUID } from 'node:crypto'
import { Effect, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as P from '@baton/protocol'
import { AppError, type NodeSource } from '../errors.ts'
import type { SqlError } from 'effect/sql/SqlError'
import { strictDecode, readProjectMemory, writeProjectMemoryTx } from './project-memory.ts'
import { createAgentAttention, getAttentionRequest, listProjectAttention, withdrawAttention } from '../inbox.ts'
import * as threads from '../threads/index.ts'
import { lockNodeSource, revalidateNodeSource } from '../nodes.ts'
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
import { projectToolJSONPage, boundedBase64, resultBytes } from './project-tools.ts'
import { canonical } from '../json.ts'
import { transaction } from '../database.ts'
import type { ProjectThreadSource } from '../threads/index.ts'
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
      const thread = yield* threads.readExec(
        { employeeId: source.employee_id, projectId: binding.project_id },
        { conversationId: binding.conversation_id, toolCallId: id },
      )
      if (!thread || thread.ended || ['stopped', 'unknown', 'archived'].includes(thread.status) || !thread.wait_active)
        return undefined
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

interface ProjectToolContext {
  employeeId: string
  projectId: string
  agentId: string
  conversationId: string
  runId: string
  leaseEpoch: number
  assistantSeq: number
  toolCallId: string
}
interface ProjectToolExecution {
  value: unknown
  isError?: boolean
  pending?: boolean
  consumeThreadId?: string
}
const pageFields = {
  offset: Schema.optionalKey(P.NonNegativeInteger),
  max_bytes: Schema.optionalKey(P.NonNegativeInteger.check(Schema.isLessThanOrEqualTo(32768))),
}
const afterId = { after_id: Schema.optionalKey(P.UUID) }
const historyFields = {
  query: Schema.optionalKey(P.Text),
  after_seq: Schema.optionalKey(P.NonNegativeInteger),
  through_seq: Schema.optionalKey(P.NonNegativeInteger),
  ...pageFields,
}
const schemas = {
  'memory.search': Schema.Struct({ query: Schema.optionalKey(P.Text), ...afterId, ...pageFields }),
  'memory.read': Schema.Struct({ entry_id: P.UUID, revision: Schema.optionalKey(P.PositiveInteger), ...pageFields }),
  'memory.write': Schema.Struct({ entry_id: Schema.optionalKey(P.UUID), ...P.WriteMemoryInput.fields }),
  'history.search': Schema.Struct(historyFields),
  'history.read': Schema.Struct({
    after_seq: historyFields.after_seq,
    through_seq: historyFields.through_seq,
    ...pageFields,
  }),
  'devices.list': Schema.Struct({ ...afterId, ...pageFields }),
  'threads.create': Schema.Struct({
    node_id: P.UUID,
    agent_type: P.AgentType,
    working_directory: P.nonemptyText(4096),
    message: P.MessageContent,
    model: Schema.optionalKey(P.summary(512)),
    execution_timeout_seconds: Schema.optionalKey(P.PositiveInteger.check(Schema.isLessThanOrEqualTo(2147483647))),
  }),
  'threads.send': Schema.Struct({
    thread_id: P.UUID,
    message: P.MessageContent,
    mode: Schema.optionalKey(P.MessageMode),
    model: Schema.optionalKey(P.summary(512)),
  }),
  'threads.withdraw': Schema.Struct({ thread_id: P.UUID, message_id: P.UUID }),
  'threads.resume': Schema.Struct({ thread_id: P.UUID }),
  'threads.stop': Schema.Struct({ thread_id: P.UUID }),
  'threads.archive': Schema.Struct({ thread_id: P.UUID }),
  'threads.list': Schema.Struct({ status: Schema.optionalKey(P.ThreadStatus), ...afterId, ...pageFields }),
  'threads.get': Schema.Struct({ thread_id: P.UUID, ...pageFields }),
  'threads.read': Schema.Struct({
    thread_id: P.UUID,
    after_turn: Schema.optionalKey(P.NonNegativeInteger),
    through_turn: Schema.optionalKey(P.NonNegativeInteger),
    ...pageFields,
  }),
  'nodes.exec': Schema.Struct({
    node_id: P.UUID,
    command: P.MessageContent,
    working_directory: P.nonemptyText(4096),
    wait_seconds: Schema.optionalKey(P.NonNegativeInteger.check(Schema.isLessThanOrEqualTo(600))),
    timeout_seconds: Schema.optionalKey(P.PositiveInteger.check(Schema.isLessThanOrEqualTo(2147483647))),
  }),
  'inbox.ask': P.InboxAsk,
  'inbox.list': Schema.Struct({ ...afterId, ...pageFields }),
  'inbox.get': Schema.Struct({ request_id: P.UUID, ...pageFields }),
  'inbox.withdraw': Schema.Struct({
    request_id: P.UUID,
    reason: P.nonemptyText(800).check(Schema.isMaxCodePoints(200)),
  }),
}

const page = (value: unknown, options: { offset?: number; max_bytes?: number }) =>
  Effect.try({
    try: () => projectToolJSONPage(value, options),
    catch: (error) => (error instanceof AppError ? error : new AppError(503, 'invalid_tool_output')),
  })
const source = (c: ProjectToolContext): ProjectThreadSource => ({
  agentId: c.agentId,
  projectId: c.projectId,
  conversationId: c.conversationId,
  toolCallId: c.toolCallId,
})
const pendingExec = Effect.fnUntraced(function* (c: ProjectToolContext) {
  const thread = yield* threads.readExec(c, c)
  if (!thread) return yield* Effect.fail(new AppError(404, 'not_found'))
  return thread
})
const pendingValue = (row: { id: string; version: number; remaining: number }): ProjectToolExecution => ({
  pending: true,
  value: { pending: true, thread_id: row.id, version: row.version, wait_remaining_ms: row.remaining, wait_protocol: 1 },
})

const executeBusiness = Effect.fnUntraced(function* (
  c: ProjectToolContext,
  name: string,
  args: unknown,
): Effect.fn.Return<ProjectToolExecution, AppError | SqlError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient
  switch (name) {
    case 'memory.search': {
      const a = yield* strictDecode(schemas[name], args)
      const rows = yield* sql<{
        value: unknown
        id: string
      }>`SELECT e.id,jsonb_build_object('entry_id',e.id,'title',e.title,'revision',e.current_revision,'snippet',left(r.content,512)) AS value FROM project_memory_entries e JOIN project_memory_revisions r ON r.employee_id=e.employee_id AND r.entry_id=e.id AND r.revision=e.current_revision WHERE e.employee_id=${c.employeeId} AND e.project_id=${c.projectId} AND (${a.after_id ?? null}::uuid IS NULL OR e.id>${a.after_id ?? null}) AND (${a.query ?? ''}='' OR strpos(lower(e.title||' '||r.content),lower(${a.query ?? ''}))>0) ORDER BY e.id LIMIT 20`
      return { value: yield* page({ entries: rows.map((r) => r.value), next_after_id: rows.at(-1)?.id ?? '' }, a) }
    }
    case 'memory.read': {
      const a = yield* strictDecode(schemas[name], args)
      return { value: yield* page(yield* readProjectMemory(c.employeeId, c.projectId, a.entry_id, a.revision), a) }
    }
    case 'memory.write': {
      const a = yield* strictDecode(schemas[name], args)
      const m = yield* writeProjectMemoryTx(
        c.employeeId,
        c.projectId,
        a.entry_id,
        { title: a.title, content: a.content, expected_revision: a.expected_revision },
        'agent',
        c.assistantSeq,
      )
      return { value: { entry_id: m.id, revision: m.revision, read_tool: 'memory.read' } }
    }
    case 'history.search':
    case 'history.read': {
      const a = yield* strictDecode(schemas['history.search'], args)
      if (name === 'history.read') yield* strictDecode(schemas['history.read'], args)
      const through = a.through_seq ?? c.assistantSeq
      if (through > c.assistantSeq || (a.after_seq ?? 0) > through)
        return yield* Effect.fail(new AppError(422, 'invalid_range'))
      const rows = yield* sql<{
        seq: number
        value: unknown
        snippet: string
      }>`SELECT seq::float8 AS seq,to_jsonb(e)-'employee_id' AS value,left(payload::text,512) AS snippet FROM conversation_events e WHERE employee_id=${c.employeeId} AND conversation_id=${c.conversationId} AND seq>${a.after_seq ?? 0} AND seq<=${through} AND (${a.query ?? ''}='' OR strpos(lower(payload::text),lower(${a.query ?? ''}))>0) ORDER BY seq LIMIT 20`
      return {
        value: yield* page(
          {
            events: rows.map((r) => (name === 'history.search' ? { seq: r.seq, snippet: r.snippet } : r.value)),
            through_seq: through,
            next_after_seq: rows.at(-1)?.seq ?? a.after_seq ?? 0,
          },
          a,
        ),
      }
    }
    case 'devices.list': {
      const a = yield* strictDecode(schemas[name], args)
      const rows = yield* sql<{
        id: string
        value: unknown
      }>`SELECT n.id,jsonb_build_object('node_id',n.id,'display_name',n.display_name,'system_name',n.system_name,'online',COALESCE(p.online,false),'synced',COALESCE(p.synced,false),'report',r.report,'reported_at',r.reported_at) AS value FROM nodes n LEFT JOIN node_presence p ON p.employee_id=n.employee_id AND p.node_id=n.id LEFT JOIN node_runtime_reports r ON r.employee_id=n.employee_id AND r.node_id=n.id WHERE n.employee_id=${c.employeeId} AND n.revoked_at IS NULL AND (${a.after_id ?? null}::uuid IS NULL OR n.id>${a.after_id ?? null}) ORDER BY n.id LIMIT 20`
      return { value: yield* page({ devices: rows.map((r) => r.value), next_after_id: rows.at(-1)?.id ?? '' }, a) }
    }
    case 'threads.create': {
      const a = yield* strictDecode(schemas[name], args)
      if (a.agent_type === 'shell') return yield* Effect.fail(new AppError(422, 'shell_requires_exec'))
      const r = yield* threads.create(
        c.employeeId,
        {
          client_thread_id: `pa:${c.conversationId}:${c.toolCallId}`,
          node_id: a.node_id,
          agent_type: a.agent_type,
          model: a.model ?? '',
          working_directory: a.working_directory,
          message: { client_message_id: `pa:${c.conversationId}:${c.toolCallId}:0`, content: a.message },
        },
        { ...source(c), executionTimeoutSeconds: a.execution_timeout_seconds ?? 7200 },
      )
      return { value: { thread_id: r.thread.id, status: r.thread.status, read_tool: 'threads.get' } }
    }
    case 'threads.send': {
      const a = yield* strictDecode(schemas[name], args)
      const m = yield* threads.addMessage(
        c.employeeId,
        a.thread_id,
        {
          client_message_id: `pa:${c.conversationId}:${c.toolCallId}`,
          content: a.message,
          mode: a.mode ?? 'queue',
          model: a.model ?? '',
        },
        source(c),
      )
      return { value: { thread_id: a.thread_id, message_id: m.id, status: m.status, read_tool: 'threads.get' } }
    }
    case 'threads.withdraw': {
      const a = yield* strictDecode(schemas[name], args)
      const t = yield* threads.withdraw(c.employeeId, a.thread_id, a.message_id, source(c))
      return { value: { thread_id: t.id, message_id: a.message_id, status: t.status, read_tool: 'threads.get' } }
    }
    case 'threads.resume': {
      const a = yield* strictDecode(schemas[name], args)
      const t = yield* threads.resume(c.employeeId, a.thread_id, source(c))
      return { value: { thread_id: t.id, status: t.status, read_tool: 'threads.get' } }
    }
    case 'threads.stop':
    case 'threads.archive': {
      const a = yield* strictDecode(schemas[name], args)
      const t = yield* (name === 'threads.stop' ? threads.stop : threads.archive)(c.employeeId, a.thread_id, source(c))
      return { value: { thread_id: t.id, status: t.status, read_tool: 'threads.get' } }
    }
    case 'threads.list': {
      const a = yield* strictDecode(schemas[name], args)
      const result = yield* threads.listProjectThreads(c, {
        ...(a.after_id ? { afterId: a.after_id } : {}),
        ...(a.status ? { status: a.status } : {}),
      })
      return { value: yield* page(result, a) }
    }
    case 'threads.get': {
      const a = yield* strictDecode(schemas[name], args)
      return { value: yield* page(yield* threads.view(c, a.thread_id), a) }
    }
    case 'threads.read': {
      const a = yield* strictDecode(schemas[name], args)
      const history = yield* threads.readTurns(c, a.thread_id, {
        ...(a.after_turn !== undefined ? { afterTurn: a.after_turn } : {}),
        ...(a.through_turn !== undefined ? { throughTurn: a.through_turn } : {}),
      })
      return { value: yield* page(history, a) }
    }
    case 'nodes.exec': {
      const a = yield* strictDecode(schemas[name], args)
      const existing = yield* threads.readExec(c, c)
      if (!existing)
        yield* threads.create(
          c.employeeId,
          {
            client_thread_id: `pa:${c.conversationId}:${c.toolCallId}`,
            node_id: a.node_id,
            agent_type: 'shell',
            working_directory: a.working_directory,
            message: { client_message_id: `pa:${c.conversationId}:${c.toolCallId}:0`, content: a.command },
          },
          {
            ...source(c),
            shellExec: true,
            executionTimeoutSeconds: a.timeout_seconds ?? 7200,
            waitSeconds: a.wait_seconds ?? 30,
          },
        )
      return pendingValue(yield* pendingExec(c))
    }
    case 'inbox.ask': {
      const a = yield* strictDecode(schemas[name], args)
      const r = yield* createAgentAttention(c, c.toolCallId, a)
      return { value: { request_id: r.id, state: r.state, version: r.version, read_tool: 'inbox.get' } }
    }
    case 'inbox.list': {
      const a = yield* strictDecode(schemas[name], args)
      const r = yield* listProjectAttention(c, a.after_id)
      return {
        value: yield* page(
          {
            ...r,
            requests: r.requests.map(({ id, title, source, state, version, thread_id, created_at, resolution }) => ({
              request_id: id,
              title,
              source,
              state,
              version,
              thread_id,
              created_at,
              resolution,
            })),
          },
          a,
        ),
      }
    }
    case 'inbox.get': {
      const a = yield* strictDecode(schemas[name], args)
      const r = yield* getAttentionRequest(c.employeeId, a.request_id)
      if (r.project_id !== c.projectId) return yield* Effect.fail(new AppError(404, 'not_found'))
      return { value: yield* page(r, a) }
    }
    case 'inbox.withdraw': {
      const a = yield* strictDecode(schemas[name], args)
      const r = yield* withdrawAttention(c, a.request_id, a.reason)
      const value = {
        request_id: r.id,
        state: r.state,
        version: r.version,
        read_tool: 'inbox.get',
        ...(r.resolution ? { resolution: r.resolution } : {}),
      }
      return {
        value:
          resultBytes(value) <= 30000
            ? value
            : { request_id: r.id, state: r.state, version: r.version, read_tool: 'inbox.get', truncated: true },
      }
    }
    default:
      return yield* Effect.fail(new AppError(422, 'unknown_tool'))
  }
})
const rejected = (error: AppError): ProjectToolExecution => {
  let value: unknown = { error: error.message, code: error.code, ...error.details }
  if (resultBytes(value) > 30000)
    value = {
      error: error.message,
      code: error.code,
      current_revision: error.details?.current_revision,
      truncated: true,
      read_tool: 'memory.read',
    }
  return { value, isError: true }
}
const toolTransaction = (body: Effect.Effect<ProjectToolExecution, AppError | SqlError, SqlClient.SqlClient>) =>
  transaction(body).pipe(
    Effect.catch((error) => (error.status < 500 ? Effect.succeed(rejected(error)) : Effect.fail(error))),
  )
const executeProjectTool = (context: ProjectToolContext, name: string, args: unknown) =>
  toolTransaction(executeBusiness(context, name, args))
const waitProjectTool = (c: ProjectToolContext, finishWait = false) =>
  toolTransaction(
    Effect.gen(function* () {
      const result = yield* threads.waitForExec(c, c, finishWait)
      const r = result.thread
      if (result.pending) return pendingValue(r)
      const { terminal, command } = result
      const value = {
        thread_id: r.id,
        status: r.status,
        status_reason: r.status_reason,
        version: r.version,
        read_tool: 'threads.read',
        ...(command
          ? { command_result: command }
          : {
              message: terminal
                ? `命令已结束，执行结果不可用；请查看 Thread ${r.id}`
                : `仍在执行，Thread ID 为 ${r.id}，结束后输出会作为新输入送回`,
            }),
      }
      if (command) {
        const output = command.output
        let length = Buffer.byteLength(output)
        while (resultBytes(value) > 30000 && length > 0) {
          length = Math.floor(length * 0.75)
          command.output =
            command.encoding === 'base64' ? boundedBase64(output, length) : boundedToolText(output, length)
          command.truncated = true
        }
      }
      return {
        value,
        ...(terminal ? { consumeThreadId: r.id } : {}),
        ...(terminal && (!command || r.status === 'unknown') ? { isError: true } : {}),
      }
    }),
  )
const consumeProjectExecInputs = (c: ProjectToolContext, threadId: string, resultSeq: number) =>
  transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`UPDATE project_agent_input_queue SET delivered_seq=${resultSeq},wake_required=false WHERE employee_id=${c.employeeId} AND agent_id=${c.agentId} AND delivered_seq IS NULL AND payload->>'thread_id'=${threadId} AND ((source_type='turn_ended' AND source_key=${`thread:${threadId}:turn:1`}) OR (source_type='thread_reply' AND payload->>'worker_turn_seq'='1') OR (source_type='thread_message_failed' AND source_key=${`thread:${threadId}:message:unknown`}))`
    }),
  )
function boundedToolText(text: string, maxBytes: number) {
  const bytes = Buffer.from(text)
  if (bytes.length <= maxBytes) return text
  let head = Math.floor(maxBytes / 2),
    tail = bytes.length - Math.floor(maxBytes / 2)
  while (head > 0 && (bytes[head]! & 0xc0) === 0x80) head--
  while (tail < bytes.length && (bytes[tail]! & 0xc0) === 0x80) tail++
  return bytes.subarray(0, head).toString() + bytes.subarray(tail).toString()
}
