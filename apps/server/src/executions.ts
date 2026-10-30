import { randomUUID } from 'node:crypto'
import { Context, Effect, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as P from '@baton/protocol'
import { transaction } from './database.ts'
import { AppError, type NodeSource } from './errors.ts'
import { directoryAllowed } from './directories.ts'
import { canonical, digest } from './json.ts'
import { lockNodeSource, revalidateNodeSource, recordNodeBusiness } from './nodes.ts'
import { insertProjectInput } from './project/inputs.ts'
import type { Gateway } from './gateway.ts'

type Scope = { employeeId: string; projectId?: string }
type Origin = { conversationId: string; toolCallId: string }
const invalid = (code = 'execution_conflict', status = 409) => new AppError(status, code)
export const terminal = (status: P.ExecutionStatus) => status !== 'pending' && status !== 'running'
export const ExecutionOutputGateway = Context.Reference<(() => Pick<Gateway, 'request'>) | undefined>(
  'baton/ExecutionOutputGateway',
  { defaultValue: () => undefined },
)

const read = Effect.fnUntraced(function* (scope: Scope, id: string, lock = false) {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{
    value: P.Execution
  }>`SELECT jsonb_strip_nulls(to_jsonb(e)-'request_hash'-'wait_until') AS value
    FROM executions e WHERE employee_id=${scope.employeeId} AND id=${id}
    AND (${scope.projectId ?? null}::uuid IS NULL OR project_id=${scope.projectId ?? null}) ${lock ? sql`FOR UPDATE` : sql``}`
  if (!row) return yield* Effect.fail(invalid('not_found', 404))
  return row.value
})
export const get = (scope: Scope, id: string) => transaction(read(scope, id))
export const list = (scope: Scope & { projectId: string }, cursor?: string) =>
  transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const [project] =
        yield* sql`SELECT id FROM projects WHERE employee_id=${scope.employeeId} AND id=${scope.projectId}`
      if (!project) return yield* Effect.fail(invalid('not_found', 404))
      const rows = yield* sql<{
        value: P.Execution
      }>`SELECT jsonb_strip_nulls(to_jsonb(e)-'request_hash'-'wait_until') AS value
    FROM executions e WHERE employee_id=${scope.employeeId} AND project_id=${scope.projectId}
    AND (${cursor ?? null}::uuid IS NULL OR id>${cursor ?? null}) ORDER BY id LIMIT 21`
      return {
        executions: rows.slice(0, 20).map((row) => row.value),
        ...(rows.length > 20 ? { next_cursor: rows[19]!.value.id } : {}),
      }
    }),
  )

export const create = (
  scope: Scope & Origin & { projectId: string; agentId: string },
  input: {
    node_id: string
    command: string
    working_directory: string
    wait_seconds?: number
    timeout_seconds?: number
  },
) =>
  transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const config = {
        ...input,
        wait_seconds: input.wait_seconds ?? 30,
        timeout_seconds: input.timeout_seconds ?? 7200,
      }
      const hash = digest(config)
      yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`execution:${scope.employeeId}:${scope.conversationId}:${scope.toolCallId}`},0))`
      const [old] = yield* sql<{ id: string; request_hash: Uint8Array }>`SELECT id,request_hash FROM executions
    WHERE employee_id=${scope.employeeId} AND origin_conversation_id=${scope.conversationId} AND origin_tool_call_id=${scope.toolCallId}`
      if (old) {
        if (!Buffer.from(old.request_hash).equals(hash)) return yield* Effect.fail(invalid())
        return yield* read(scope, old.id)
      }
      const [binding] = yield* sql`SELECT c.id FROM conversations c JOIN project_agents a ON a.id=c.agent_id
    JOIN projects p ON p.id=a.project_id WHERE c.id=${scope.conversationId} AND a.id=${scope.agentId}
    AND a.employee_id=${scope.employeeId} AND p.id=${scope.projectId} AND p.status='active' FOR UPDATE OF p`
      if (!binding) return yield* Effect.fail(invalid('not_found', 404))
      const [node] = yield* sql<{
        system_name: string
        report: P.RuntimeReport
      }>`SELECT n.system_name,r.report FROM nodes n
    LEFT JOIN node_runtime_reports r ON r.node_id=n.id WHERE n.id=${input.node_id} AND n.employee_id=${scope.employeeId} AND n.revoked_at IS NULL`
      if (!node) return yield* Effect.fail(invalid('not_found', 404))
      if (!node.report?.exec?.enabled) return yield* Effect.fail(invalid('exec_disabled', 422))
      if (!directoryAllowed(node.system_name, input.working_directory, node.report.roots))
        return yield* Effect.fail(invalid('directory_not_allowed', 422))
      const id = randomUUID()
      yield* sql`INSERT INTO executions(id,employee_id,project_id,node_id,origin_conversation_id,origin_tool_call_id,
    request_hash,command,working_directory,timeout_seconds,storage_generation,wait_until)
    VALUES(${id},${scope.employeeId},${scope.projectId},${input.node_id},${scope.conversationId},${scope.toolCallId},
      ${hash},${input.command},${input.working_directory},${config.timeout_seconds},${randomUUID()},
      clock_timestamp()+${config.wait_seconds}*interval '1 second')`
      yield* sql`INSERT INTO execution_outbox(execution_id,message_id,action) VALUES(${id},${randomUUID()},'start')`
      return yield* read(scope, id)
    }),
  )

export const readByOrigin = Effect.fnUntraced(function* (scope: Scope, origin: Origin) {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{ value: P.Execution; remaining: number; wait_active: boolean }>`SELECT
    jsonb_strip_nulls(to_jsonb(e)-'request_hash'-'wait_until') AS value,
    GREATEST(0,FLOOR(EXTRACT(EPOCH FROM(wait_until-clock_timestamp()))*1000))::float8 AS remaining,
    wait_until>clock_timestamp() AS wait_active FROM executions e WHERE employee_id=${scope.employeeId}
    AND (${scope.projectId ?? null}::uuid IS NULL OR project_id=${scope.projectId ?? null})
    AND origin_conversation_id=${origin.conversationId} AND origin_tool_call_id=${origin.toolCallId}`
  return row ? { ...row.value, remaining: row.remaining, wait_active: row.wait_active } : undefined
})
export const waitForExecution = (scope: Scope, origin: Origin, finishWait = false) =>
  transaction(
    Effect.gen(function* () {
      let execution = yield* readByOrigin(scope, origin)
      if (!execution) return yield* Effect.fail(invalid('not_found', 404))
      if (!terminal(execution.status) && execution.wait_active && !finishWait)
        return { execution, pending: true as const }
      yield* read(scope, execution.id, true)
      execution = yield* readByOrigin(scope, origin)
      if (!execution) return yield* Effect.fail(invalid('not_found', 404))
      return { execution, pending: false as const }
    }),
  )
export const stop = (scope: Scope, id: string) =>
  transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const e = yield* read(scope, id, true)
      if (terminal(e.status)) return e
      if (!e.stop_requested_at) {
        yield* sql`UPDATE executions SET stop_requested_at=clock_timestamp(),version=version+1 WHERE id=${id}`
        yield* sql`INSERT INTO execution_outbox(execution_id,message_id,action) VALUES(${id},${randomUUID()},'stop') ON CONFLICT DO NOTHING`
      }
      return yield* read(scope, id)
    }),
  )

const notifyResult = Effect.fnUntraced(function* (e: P.Execution) {
  if (!terminal(e.status)) return
  const sql = yield* SqlClient.SqlClient
  const [agent] = yield* sql<{
    id: string
  }>`SELECT id FROM project_agents WHERE employee_id=${e.employee_id} AND project_id=${e.project_id}`
  if (!agent) return
  const payload = {
    execution_id: e.id,
    origin_tool_call_id: e.origin_tool_call_id,
    status: e.status,
    version: e.version,
    exit_code: e.exit_code,
    reason: e.reason,
    command_result: {
      output: e.output ?? '',
      total_bytes: e.total_bytes ?? 0,
      truncated: e.truncated ?? false,
      ...(e.encoding ? { encoding: e.encoding } : {}),
      ...(e.exit_code === undefined ? {} : { exit_code: e.exit_code }),
      ...(e.full_output ? { full_output: e.full_output } : {}),
    },
    ...(e.status === 'unknown'
      ? { automatic_retry: false, message: '命令可能已经产生副作用，无法确认结果。不得自动重发。' }
      : {}),
  }
  while (Buffer.byteLength(JSON.stringify(payload)) > 64 * 1024) {
    const length = Math.floor(payload.command_result.output.length / 8) * 4
    payload.command_result.output = payload.command_result.output.slice(0, length)
    payload.command_result.truncated = true
  }
  yield* insertProjectInput(e.employee_id, agent.id, 'execution.finished', `execution:${e.id}:finished`, payload)
  yield* sql`UPDATE project_agent_input_queue q SET delivered_seq=result.seq,wake_required=false
    FROM conversation_events result WHERE result.employee_id=${e.employee_id}
    AND result.conversation_id=${e.origin_conversation_id} AND result.kind='tool_result'
    AND result.tool_call_id=${e.origin_tool_call_id} AND result.payload->>'consumed_execution_id'=${e.id}
    AND q.agent_id=${agent.id} AND q.source_key=${`execution:${e.id}:finished`} AND q.delivered_seq IS NULL`
})

export const claimCommands = () =>
  transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{
        id: string
        message_id: string
        action: 'start' | 'stop'
        execution: P.Execution
      }>`SELECT
    o.id::text,o.message_id,o.action,jsonb_strip_nulls(to_jsonb(e)-'request_hash'-'wait_until') AS execution
    FROM execution_outbox o JOIN executions e ON e.id=o.execution_id JOIN nodes n ON n.id=e.node_id
    JOIN node_presence p ON p.node_id=n.id JOIN node_credentials c ON c.node_id=n.id AND c.version=n.credential_version
    WHERE o.acked_at IS NULL AND o.next_attempt_at<=clock_timestamp() AND p.online AND p.synced
      AND n.revoked_at IS NULL AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp()
      AND e.status IN ('pending','running')
      AND (o.action='stop' OR e.stop_requested_at IS NULL)
      AND (o.action='stop' OR COALESCE((SELECT u.phase IN ('completed','cancelled') FROM node_upgrades u WHERE u.node_id=n.id ORDER BY u.id DESC LIMIT 1),true))
    ORDER BY o.next_attempt_at,o.id LIMIT 32 FOR UPDATE OF o SKIP LOCKED`
      const commands: { message_id: string; employee_id: string; node_id: string; body: P.ExecutionCommand }[] = []
      for (const row of rows) {
        const e = row.execution
        yield* sql`UPDATE execution_outbox SET attempts=attempts+1,next_attempt_at=clock_timestamp()+interval '5 seconds' WHERE id=${row.id}`
        commands.push({
          message_id: row.message_id,
          employee_id: e.employee_id,
          node_id: e.node_id,
          body: {
            type: 'execution.command',
            action: row.action,
            execution_id: e.id,
            storage_generation: e.storage_generation,
            ...(row.action === 'start'
              ? {
                  project_id: e.project_id,
                  command: e.command,
                  working_directory: e.working_directory,
                  timeout_seconds: e.timeout_seconds,
                }
              : {}),
          },
        })
      }
      return commands
    }),
  )

export const processReceipt = (source: NodeSource, commandId: string, input: P.ExecutionCommandResult) =>
  transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const r = yield* Schema.decodeUnknownEffect(P.ExecutionCommandResult)(input).pipe(
        Effect.mapError(() => invalid('invalid', 422)),
      )
      yield* lockNodeSource(source)
      const e = yield* read({ employeeId: source.employee_id }, r.execution_id, true)
      if (e.node_id !== source.node_id) return yield* Effect.fail(invalid('not_found', 404))
      if (e.storage_generation !== r.storage_generation)
        return yield* Effect.fail(invalid('storage_generation_mismatch'))
      const [command] = yield* sql<{
        result: unknown
        acked_at: string | null
        action: string
      }>`SELECT result,acked_at,action FROM execution_outbox
    WHERE execution_id=${e.id} AND message_id=${commandId} FOR UPDATE`
      if (!command) return yield* Effect.fail(invalid('not_found', 404))
      yield* revalidateNodeSource(source)
      if (command.acked_at) {
        if (canonical(command.result) !== canonical(r)) return yield* Effect.fail(invalid())
        return
      }
      yield* sql`UPDATE execution_outbox SET result=${JSON.stringify(r)}::jsonb,acked_at=clock_timestamp() WHERE message_id=${commandId}`
      if (!r.ok && command.action === 'start' && e.status === 'pending') {
        yield* sql`UPDATE executions SET status='failed',reason=${r.reason ?? r.code ?? 'start_failed'},finished_at=clock_timestamp(),version=version+1 WHERE id=${e.id}`
        yield* notifyResult(yield* read({ employeeId: source.employee_id }, e.id))
      }
      if (r.ok) yield* recordNodeBusiness(source)
    }),
  )

export const processReport = (source: NodeSource, input: P.ExecutionReport) =>
  transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const r = yield* Schema.decodeUnknownEffect(P.ExecutionReport)(input).pipe(
        Effect.mapError(() => invalid('invalid', 422)),
      )
      yield* lockNodeSource(source)
      const e = yield* read({ employeeId: source.employee_id }, r.execution_id, true)
      if (e.node_id !== source.node_id) return yield* Effect.fail(invalid('not_found', 404))
      if (
        e.storage_generation !== r.storage_generation ||
        (r.full_output && r.full_output.storage_generation !== e.storage_generation)
      )
        return yield* Effect.fail(invalid('storage_generation_mismatch'))
      yield* revalidateNodeSource(source)
      const hash = digest(r)
      const [old] = yield* sql<{
        payload_hash: Uint8Array
        ack: P.ExecutionReportResult
      }>`SELECT payload_hash,ack FROM execution_reports WHERE execution_id=${e.id} AND event_id=${r.event_id}`
      if (old) {
        if (!Buffer.from(old.payload_hash).equals(hash)) return yield* Effect.fail(invalid())
        return old.ack
      }
      const ack: P.ExecutionReportResult = {
        type: 'execution.report_result',
        execution_id: e.id,
        event_id: r.event_id,
        seq: r.seq,
        ok: false,
      }
      if (r.seq !== e.last_report_seq + 1) return ack
      if (r.status === 'pending' || terminal(e.status) || (r.status === 'completed' && r.exit_code !== 0))
        return yield* Effect.fail(invalid('invalid_execution_transition'))
      yield* sql`UPDATE executions SET status=${r.status},exit_code=${r.exit_code ?? null},reason=${r.reason ?? null},
    output=${r.output ?? null},encoding=${r.encoding ?? null},total_bytes=${r.total_bytes ?? null},truncated=${r.truncated ?? null},
    full_output=${r.full_output ? JSON.stringify(r.full_output) : null}::jsonb,
    started_at=COALESCE(started_at,${r.started_at ?? null}::timestamptz,CASE WHEN ${r.status}='running' THEN clock_timestamp() END),
    finished_at=CASE WHEN ${terminal(r.status)} THEN COALESCE(${r.finished_at ?? null}::timestamptz,clock_timestamp()) ELSE NULL END,
    last_report_seq=${r.seq},version=version+1 WHERE id=${e.id}`
      const accepted = { ...ack, ok: true }
      yield* sql`INSERT INTO execution_reports(execution_id,event_id,seq,payload_hash,ack) VALUES(${e.id},${r.event_id},${r.seq},${hash},${JSON.stringify(accepted)}::jsonb)`
      yield* notifyResult(yield* read({ employeeId: source.employee_id }, e.id))
      yield* recordNodeBusiness(source)
      return accepted
    }),
  )

export const readOutput = Effect.fn('Execution.readOutput')(function* (
  scope: Scope,
  id: string,
  query: {
    output_id: string
    storage_generation: string
    offset?: number
  },
) {
  const e = yield* get(scope, id)
  if (!e.full_output || e.full_output.id !== query.output_id || e.storage_generation !== query.storage_generation)
    return yield* Effect.fail(invalid('not_found', 404))
  const gateway = yield* ExecutionOutputGateway
  if (!gateway) return yield* Effect.fail(invalid('output_unavailable', 503))
  const operationId = randomUUID()
  const r = yield* Effect.tryPromise({
    try: async () =>
      Schema.decodeUnknownSync(P.ExecutionOutputResult)(
        await gateway().request(e.node_id, scope.employeeId, {
          ...query,
          type: 'execution.output_request',
          execution_id: id,
          operation_id: operationId,
        }),
      ),
    catch: (error) => (error instanceof AppError ? error : invalid('output_unavailable', 503)),
  })
  if (r.execution_id !== id || r.operation_id !== operationId)
    return yield* Effect.fail(invalid('output_identity_mismatch', 503))
  if (!r.ok || !r.full_output) return yield* Effect.fail(invalid(r.code ?? 'output_unavailable', 503))
  if (r.full_output.output_id !== query.output_id || r.full_output.storage_generation !== query.storage_generation)
    return yield* Effect.fail(invalid('output_identity_mismatch', 503))
  return r.full_output
})
