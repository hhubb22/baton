import { Effect, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import type { SqlError } from 'effect/sql/SqlError'
import * as P from '@baton/protocol'
import { AppError } from './errors.ts'
import { strictDecode, readProjectMemory, writeProjectMemoryTx } from './project-memory.ts'
import { createAgentAttention, getAttentionRequest, listProjectAttention, withdrawAttention } from './inbox.ts'
import * as threads from './threads.ts'
import { readThread, transaction, type ProjectThreadSource } from './threads-core.ts'

export interface ProjectToolContext {
  employeeId: string
  projectId: string
  agentId: string
  conversationId: string
  runId: string
  leaseEpoch: number
  assistantSeq: number
  toolCallId: string
}
export interface ProjectToolExecution {
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

function resultBytes(value: unknown, callId = 'x'.repeat(128)) {
  return Buffer.byteLength(
    JSON.stringify({
      format: 'pi-ai/1',
      message: {
        role: 'toolResult',
        toolCallId: callId,
        toolName: 'x'.repeat(128),
        content: [{ type: 'text', text: JSON.stringify(value) }],
        isError: false,
        timestamp: 9999999999999,
      },
    }),
  )
}
export function projectToolJSONPage(value: unknown, options: { offset?: number; max_bytes?: number } = {}) {
  const raw = Buffer.from(JSON.stringify(value))
  const offset = options.offset ?? 0
  if (offset > raw.length || (offset < raw.length && (raw[offset]! & 0xc0) === 0x80))
    throw new AppError(422, 'invalid_offset')
  let end = Math.min(raw.length, offset + (options.max_bytes || 16384))
  const make = () => {
    while (end > offset && end < raw.length && (raw[end]! & 0xc0) === 0x80) end--
    return {
      encoding: 'json',
      text: raw.subarray(offset, end).toString(),
      offset,
      total_bytes: raw.length,
      truncated: end < raw.length,
      ...(end < raw.length ? { next_offset: end } : {}),
    }
  }
  let out = make()
  while (resultBytes(out) > 30000 && end > offset) {
    end = offset + Math.floor((end - offset) * 0.75)
    out = make()
  }
  if (end === offset && offset < raw.length) throw new AppError(422, 'max_bytes_too_small')
  return out
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
const ownedThread = Effect.fnUntraced(function* (c: ProjectToolContext, id: string, lock = false) {
  const t = yield* readThread(c.employeeId, id, lock)
  if (t.project_id !== c.projectId) return yield* Effect.fail(new AppError(404, 'not_found'))
  return t
})

export const shellThreadCommandResult = Effect.fnUntraced(function* (employeeId: string, threadId: string) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    content: string
    original_bytes: number
    truncated: boolean
    metadata: Record<string, unknown>
  }>`SELECT content,original_bytes::float8 AS original_bytes,truncated,metadata FROM thread_replies WHERE employee_id=${employeeId} AND thread_id=${threadId} AND worker_turn_seq=1 ORDER BY worker_seq`
  if (!rows.length) return undefined
  return {
    output: rows.map((r) => r.content).join(''),
    total_bytes: rows.reduce((n, r) => n + r.original_bytes, 0),
    truncated: rows.some((r) => r.truncated),
    ...(rows.some((r) => r.metadata.encoding === 'base64') ? { encoding: 'base64' as const } : {}),
    ...Object.fromEntries(rows.flatMap((r) => Object.entries(r.metadata).filter(([k]) => k === 'exit_code'))),
  }
})
const pendingExec = Effect.fnUntraced(function* (c: ProjectToolContext) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    id: string
    version: number
    status: string
    status_reason: string
    remaining: number
    ended: boolean
  }>`SELECT id,version::float8 AS version,status,status_reason,GREATEST(0,FLOOR(EXTRACT(EPOCH FROM(exec_wait_until-clock_timestamp()))*1000))::float8 AS remaining,EXISTS(SELECT 1 FROM thread_turns v WHERE v.thread_id=t.id AND v.ended_at IS NOT NULL) AS ended FROM threads t WHERE employee_id=${c.employeeId} AND project_id=${c.projectId} AND origin_conversation_id=${c.conversationId} AND origin_tool_call_id=${c.toolCallId} AND agent_type='shell'`
  if (!rows.length) return yield* Effect.fail(new AppError(404, 'not_found'))
  return rows[0]!
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
      yield* ownedThread(c, a.thread_id, true)
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
    case 'threads.stop':
    case 'threads.archive': {
      const a = yield* strictDecode(schemas[name], args)
      yield* ownedThread(c, a.thread_id, true)
      const t = yield* (name === 'threads.stop' ? threads.stop : threads.archive)(c.employeeId, a.thread_id, source(c))
      return { value: { thread_id: t.id, status: t.status, read_tool: 'threads.get' } }
    }
    case 'threads.list': {
      const a = yield* strictDecode(schemas[name], args)
      const rows = yield* sql<{
        id: string
        value: unknown
      }>`SELECT id,jsonb_build_object('thread_id',id,'node_id',node_id,'agent_type',agent_type,'working_directory',working_directory,'status',status,'last_activity_at',last_activity_at) AS value FROM threads WHERE employee_id=${c.employeeId} AND project_id=${c.projectId} AND (${a.after_id ?? null}::uuid IS NULL OR id>${a.after_id ?? null}) AND (${a.status ?? null}::text IS NULL OR status=${a.status ?? null}) ORDER BY id LIMIT 20`
      return { value: yield* page({ threads: rows.map((r) => r.value), next_after_id: rows.at(-1)?.id ?? '' }, a) }
    }
    case 'threads.get': {
      const a = yield* strictDecode(schemas[name], args)
      yield* ownedThread(c, a.thread_id)
      return { value: yield* page(yield* threads.view(c.employeeId, a.thread_id), a) }
    }
    case 'threads.read': {
      const a = yield* strictDecode(schemas[name], args)
      yield* ownedThread(c, a.thread_id)
      const max = yield* sql<{
        seq: number
      }>`SELECT COALESCE(max(worker_turn_seq),0)::integer AS seq FROM thread_turns WHERE employee_id=${c.employeeId} AND thread_id=${a.thread_id}`
      const through = a.through_turn ?? max[0]!.seq
      if ((a.after_turn ?? 0) > through) return yield* Effect.fail(new AppError(422, 'invalid_range'))
      const turns = yield* sql<{
        value: unknown
        worker_turn_seq: number
      }>`SELECT to_jsonb(t)-'employee_id' || jsonb_build_object('messages',(SELECT COALESCE(jsonb_agg(to_jsonb(m)-'employee_id' ORDER BY m.created_at,m.id),'[]'::jsonb) FROM thread_messages m WHERE m.employee_id=${c.employeeId} AND m.thread_id=t.thread_id AND m.worker_turn_seq=t.worker_turn_seq),'replies',(SELECT COALESCE(jsonb_agg(to_jsonb(r)-'employee_id' ORDER BY r.worker_seq),'[]'::jsonb) FROM thread_replies r WHERE r.employee_id=${c.employeeId} AND r.thread_id=t.thread_id AND r.worker_turn_seq=t.worker_turn_seq)) AS value,worker_turn_seq::float8 AS worker_turn_seq FROM thread_turns t WHERE employee_id=${c.employeeId} AND thread_id=${a.thread_id} AND worker_turn_seq>${a.after_turn ?? 0} AND worker_turn_seq<=${through} ORDER BY worker_turn_seq LIMIT 20`
      return {
        value: yield* page(
          {
            thread_id: a.thread_id,
            turns: turns.map((r) => r.value),
            through_turn: through,
            next_after_turn: turns.at(-1)?.worker_turn_seq ?? a.after_turn ?? 0,
          },
          a,
        ),
      }
    }
    case 'nodes.exec': {
      const a = yield* strictDecode(schemas[name], args)
      const existing =
        yield* sql`SELECT id FROM threads WHERE employee_id=${c.employeeId} AND project_id=${c.projectId} AND origin_conversation_id=${c.conversationId} AND origin_tool_call_id=${c.toolCallId} AND agent_type='shell'`
      if (!existing.length)
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
export const executeProjectTool = (context: ProjectToolContext, name: string, args: unknown) =>
  toolTransaction(executeBusiness(context, name, args))
export const waitProjectTool = (c: ProjectToolContext, finishWait = false) =>
  toolTransaction(
    Effect.gen(function* () {
      let r = yield* pendingExec(c)
      if (!r.ended && !['stopped', 'unknown', 'archived'].includes(r.status) && r.remaining > 0 && !finishWait)
        return pendingValue(r)
      yield* ownedThread(c, r.id, true)
      r = yield* pendingExec(c)
      const terminal = r.ended || ['stopped', 'unknown', 'archived'].includes(r.status)
      const command = terminal ? yield* shellThreadCommandResult(c.employeeId, r.id) : undefined
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
            command.encoding === 'base64' ? boundedBase64(output, length) : boundedProjectText(output, length)
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
export const consumeProjectExecInputs = (c: ProjectToolContext, threadId: string, resultSeq: number) =>
  transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* ownedThread(c, threadId)
      yield* sql`UPDATE project_agent_input_queue SET delivered_seq=${resultSeq},wake_required=false WHERE employee_id=${c.employeeId} AND agent_id=${c.agentId} AND delivered_seq IS NULL AND payload->>'thread_id'=${threadId} AND ((source_type='turn_ended' AND source_key=${`thread:${threadId}:turn:1`}) OR (source_type='thread_reply' AND payload->>'worker_turn_seq'='1') OR (source_type='thread_message_failed' AND source_key=${`thread:${threadId}:message:unknown`}))`
    }),
  )
export function boundedBase64(text: string, maxBytes: number) {
  const bytes = Buffer.from(text, 'base64')
  const half = Math.floor((Math.floor(maxBytes / 4) * 3) / 2)
  return bytes.length <= half * 2
    ? text
    : Buffer.concat([bytes.subarray(0, half), bytes.subarray(bytes.length - half)]).toString('base64')
}
export function boundedProjectText(text: string, maxBytes: number) {
  const bytes = Buffer.from(text)
  if (bytes.length <= maxBytes) return text
  let head = Math.floor(maxBytes / 2),
    tail = bytes.length - Math.floor(maxBytes / 2)
  while (head > 0 && (bytes[head]! & 0xc0) === 0x80) head--
  while (tail < bytes.length && (bytes[tail]! & 0xc0) === 0x80) tail++
  return bytes.subarray(0, head).toString() + bytes.subarray(tail).toString()
}
