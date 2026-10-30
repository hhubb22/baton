import { randomUUID } from 'node:crypto'
import { Effect, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import type {
  RuntimeMode,
  RuntimeReport,
  Thread,
  ThreadCommand,
  ThreadMessage,
  ThreadMessageInput,
} from '@baton/protocol'
import { captureTrace, withTraceSpan } from '@baton/telemetry'
import { AppError } from '../errors.ts'

import type { DatabaseEffect } from '../database.ts'
import { recordThreadNotification } from '../desktop-notifications.ts'
import { directoryAllowed } from '../directories.ts'
import { canonical } from '../json.ts'

export type DB<A> = DatabaseEffect<A>
export const failure = (code = 'thread_conflict', status = 409) => new AppError(status, code)
export const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(value),
    catch: () => failure('invalid_request', 422),
  })
export const uuid = randomUUID
export type ThreadScope = { employeeId: string; projectId?: string }
// 停止请求未确认、也没有待发的停止命令时，取最近一条停止命令的原因：设备拒绝或报告失败时用设备给的原因，
// 恢复备份后冻结的命令为 stop_suspended。设备已接受、还在等停止报告时为 NULL。
export const stopFailure = `CASE WHEN t.stop_requested_at IS NOT NULL AND t.stop_confirmed_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM thread_outbox s WHERE s.thread_id=t.id AND s.action='stop'
      AND s.completed_at IS NULL AND s.next_attempt_at<>'infinity')
  THEN (SELECT CASE WHEN s.completed_at IS NULL THEN 'stop_suspended'
      WHEN s.completion->>'command_outcome'='succeeded' THEN NULL
      ELSE COALESCE(NULLIF(s.completion->>'reason',''),'stop_failed') END
    FROM thread_outbox s WHERE s.thread_id=t.id AND s.action='stop' ORDER BY s.id DESC LIMIT 1) END`
export const readThread = (employee: string, id: string, lock = false, projectId?: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    if (lock) {
      const rows =
        yield* sql`SELECT id FROM threads WHERE employee_id=${employee} AND id=${id} AND (${projectId ?? null}::uuid IS NULL OR project_id=${projectId ?? null}) FOR UPDATE`
      if (!rows.length) return yield* Effect.fail(failure('not_found', 404))
    }
    const rows = yield* sql<{
      value: Thread
    }>`SELECT jsonb_strip_nulls(to_jsonb(t)-'request_hash') || jsonb_build_object(
    'node_online',COALESCE(p.online,false),'node_synced',COALESCE(p.synced,false),'node_last_contact_at',p.last_contact_at,
    'stop_failure',${sql.literal(stopFailure)},
    'next_thinking',(SELECT CASE WHEN COALESCE(NULLIF(m.model,''),t.model)=COALESCE(NULLIF(t.next_model,''),t.model) THEN m.thinking END
      FROM thread_messages m WHERE m.thread_id=t.id AND m.mode='queue' ORDER BY m.created_at DESC,m.id DESC LIMIT 1)) AS value
    FROM threads t LEFT JOIN node_presence p ON p.node_id=t.node_id AND p.employee_id=t.employee_id
    WHERE t.employee_id=${employee} AND t.id=${id} AND (${projectId ?? null}::uuid IS NULL OR t.project_id=${projectId ?? null})`
    if (!rows.length) return yield* Effect.fail(failure('not_found', 404))
    return rows[0]!.value
  })
export const audit = (t: Thread, kind: string, payload: unknown, actor = 'employee', actorID = t.employee_id) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [event] = yield* sql<{
      id: string
    }>`INSERT INTO thread_events(employee_id,thread_id,kind,actor,actor_id,payload) VALUES(${t.employee_id},${t.id},${kind},${actor},${actorID},${JSON.stringify(payload)}::jsonb) RETURNING id::text`
    yield* recordThreadNotification(t, `thread-event:${event!.id}`, kind, payload)
  })
export const touch = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE threads SET version=version+1,last_activity_at=clock_timestamp() WHERE id=${id}`
  })
export const enqueue = (t: Thread, action: ThreadCommand['action'], payload: unknown = {}) =>
  withTraceSpan(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const trace = yield* captureTrace
      yield* sql`INSERT INTO thread_outbox(employee_id,thread_id,node_id,message_id,action,payload,trace_context) VALUES(${t.employee_id},${t.id},${t.node_id},${uuid()},${action},${JSON.stringify(payload)}::jsonb,${trace ? JSON.stringify(trace) : null}::jsonb)`
    }),
    'baton.command.enqueue',
    undefined,
    {
      kind: 'producer',
      attributes: { 'baton.thread.id': t.id, 'baton.command.action': action },
    },
  )
export const admission = (
  employee: string,
  node: string,
  agent: string,
  directory: string,
  model: string,
  operation: 'create' | 'queue' | 'steer' | 'resume',
  runtimeMode: RuntimeMode,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{
      system_name: string
      report: RuntimeReport
    }>`SELECT n.system_name,r.report FROM nodes n LEFT JOIN node_runtime_reports r ON r.node_id=n.id AND r.employee_id=n.employee_id WHERE n.id=${node} AND n.employee_id=${employee} AND n.revoked_at IS NULL`
    if (!rows.length) return yield* Effect.fail(failure('not_found', 404))
    const row = rows[0]!
    if (!directoryAllowed(row.system_name, directory, row.report?.roots))
      return yield* Effect.fail(failure('directory_not_allowed', 422))
    const capability = row.report?.agents?.find((a) => a.agent_type === agent && a.status === 'available')
    if (!capability || !capability.capabilities[operation])
      return yield* Effect.fail(
        failure(
          operation === 'steer'
            ? 'steer_unsupported'
            : operation === 'resume'
              ? 'resume_unsupported'
              : 'agent_unavailable',
          422,
        ),
      )
    const mode = capability.runtime_modes?.find((item) => item.id === runtimeMode)
    if (!mode)
      return yield* Effect.fail(
        new AppError(
          422,
          'runtime_mode_unsupported',
          `Runtime mode ${runtimeMode} is not supported; supported modes: ${capability.runtime_modes?.map((item) => item.id).join(', ') || 'none'}`,
        ),
      )
    if (!mode.available)
      return yield* Effect.fail(
        new AppError(422, 'runtime_mode_unavailable', mode.reason || 'runtime_mode_unavailable'),
      )
    if (operation !== 'create' && model && !capability.capabilities.switch_model)
      return yield* Effect.fail(failure('model_switch_unsupported', 422))
    return model || (operation === 'create' ? capability.default_model : '')
  })
export const normalizeMessage = (input: ThreadMessageInput) =>
  Effect.gen(function* () {
    const mode = input.mode || 'queue'
    const model = input.model || ''
    if (mode === 'steer' && (model || input.thinking)) return yield* Effect.fail(failure('model_with_steer', 422))
    const normalized = {
      client_message_id: input.client_message_id,
      content: input.content,
      mode,
      model,
      ...(input.thinking ? { thinking: input.thinking } : {}),
    } as const
    const body = {
      type: 'thread.command',
      trace_context: { traceparent: `00-${'f'.repeat(32)}-${'f'.repeat(16)}-01`, tracestate: '\\'.repeat(512) },
      thread_id: uuid(),
      action: 'message',
      storage_generation: '\\'.repeat(256),
      ...normalized,
    }
    const frame = {
      kind: 'envelope',
      envelope: {
        version: 1,
        message_id: uuid(),
        route: { to: uuid() },
        priority: 'control',
        source: { kind: 'control' },
        body,
      },
    }
    if (Buffer.byteLength(JSON.stringify(frame)) > 256 * 1024)
      return yield* Effect.fail(failure('message_too_large', 413))
    return normalized
  })
export interface ProjectThreadSource {
  agentId: string
  projectId: string
  conversationId: string
  toolCallId: string
  executionTimeoutSeconds?: number
}

export const insertMessage = (t: Thread, input: ThreadMessageInput, source?: ProjectThreadSource) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const m = yield* normalizeMessage(input)
    const old = yield* sql<{
      value: ThreadMessage
    }>`SELECT jsonb_strip_nulls(to_jsonb(m)-'employee_id') AS value FROM thread_messages m WHERE employee_id=${t.employee_id} AND thread_id=${t.id} AND client_message_id=${m.client_message_id}`
    if (old.length) {
      const saved = old[0]!.value
      if (
        saved.content !== m.content ||
        saved.mode !== m.mode ||
        (saved.requested_model || '') !== m.model ||
        canonical(saved.thinking ?? null) !== canonical(m.thinking ?? null)
      )
        return yield* Effect.fail(failure())
      return saved
    }
    if (t.status === 'archived' || t.archive_requested_at) return yield* Effect.fail(failure('thread_archived'))
    if (t.status === 'stopped' && !t.opened_at) return yield* Effect.fail(failure('thread_not_opened', 422))
    const selected = m.model || t.next_model || ''
    yield* admission(t.employee_id, t.node_id, t.agent_type, t.working_directory, selected, m.mode, t.runtime_mode)
    if (m.thinking) {
      const reports = yield* sql<{ report: RuntimeReport }>`SELECT report FROM node_runtime_reports
        WHERE employee_id=${t.employee_id} AND node_id=${t.node_id}`
      const model = reports[0]?.report.agents
        ?.find((agent) => agent.agent_type === t.agent_type)
        ?.models?.find((item) => item.id === (selected || t.model))
      const capability = model?.thinking
      if (
        !capability ||
        capability.id !== m.thinking.id ||
        !capability.options.some((option) => option.id === m.thinking!.value)
      )
        return yield* Effect.fail(failure('thinking_unavailable', 422))
    }
    const rows = yield* sql<{
      value: ThreadMessage
    }>`INSERT INTO thread_messages(id,employee_id,thread_id,client_message_id,sender,origin_tool_call_id,content,mode,model,requested_model,thinking) VALUES(${uuid()},${t.employee_id},${t.id},${m.client_message_id},${source ? 'project_agent' : 'employee'},${source?.toolCallId ?? null},${m.content},${m.mode},${selected},${m.model},${m.thinking ? JSON.stringify(m.thinking) : null}::jsonb) RETURNING jsonb_strip_nulls(to_jsonb(thread_messages)-'employee_id') AS value`
    yield* enqueue(t, 'message', { client_message_id: m.client_message_id })
    yield* audit(
      t,
      'message.accepted',
      rows[0]!.value,
      source ? 'project_agent' : 'employee',
      source?.agentId ?? t.employee_id,
    )
    yield* touch(t.id)
    return rows[0]!.value
  })
