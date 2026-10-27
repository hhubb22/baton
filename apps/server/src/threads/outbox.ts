import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import type { Thread, ThreadCommand, ThreadCommandResult, ThreadAnswerInput } from '@baton/protocol'
import { ThreadCommandResult as ResultSchema } from '@baton/protocol'
import { captureTrace, withTraceSpan, type TraceContext } from '@baton/telemetry'
import type { NodeSource } from '../errors.ts'
import { lockNodeSource, recordNodeBusiness, revalidateNodeSource } from '../nodes.ts'
import { notifyProjectThread } from './project-inputs.ts'
import { audit, decode, failure, readThread, uuid, type DB } from './core.ts'
import { canonical } from '../json.ts'
import { transaction } from '../database.ts'

export interface ClaimedCommand {
  readonly message_id: string
  readonly node_id: string
  readonly employee_id: string
  readonly body: ThreadCommand
}
interface Outbox {
  id: string
  employee_id: string
  thread_id: string
  node_id: string
  message_id: string
  action: ThreadCommand['action']
  trace_context: TraceContext | null
  payload: {
    client_message_id?: string
    model?: string
    execution_timeout_seconds?: number
    answer?: ThreadAnswerInput
    worker_turn_seq?: number
  }
  acked_at: string | null
  completed_at: string | null
  result: ThreadCommandResult | null
}
export const claimCommands = (): DB<ClaimedCommand[]> =>
  transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      // 已结束的问题不再阻塞停止或下一轮；未派发的回答直接取消。
      // 已尝试的回答继续以原命令 ID 核对 Worker 回执，保留迟到的完成报告。
      yield* sql`UPDATE thread_outbox o SET completed_at=clock_timestamp(),
        completion=jsonb_build_object('command_outcome','cancelled','reason','question_closed')
        FROM threads t WHERE o.thread_id=t.id AND o.action='answer' AND o.attempts=0
        AND o.acked_at IS NULL AND o.completed_at IS NULL AND (t.status<>'running' OR t.stop_requested_at IS NOT NULL
          OR t.archive_requested_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM thread_turns v
            WHERE v.thread_id=t.id AND v.worker_turn_seq=(o.payload->>'worker_turn_seq')::bigint AND v.ended_at IS NULL)
          OR EXISTS(SELECT 1 FROM thread_events e WHERE e.thread_id=t.id AND e.kind='question.resolved'
            AND e.payload->>'request_id'=o.payload->'answer'->>'request_id'))`
      const answerDue = (alias: string) => `(${alias}.action<>'answer' OR (eligible.status='running'
        AND eligible.stop_requested_at IS NULL AND eligible.archive_requested_at IS NULL
        AND EXISTS(SELECT 1 FROM thread_turns v WHERE v.thread_id=eligible.id
          AND v.worker_turn_seq=(${alias}.payload->>'worker_turn_seq')::bigint AND v.ended_at IS NULL)
        AND NOT EXISTS(SELECT 1 FROM thread_events e WHERE e.thread_id=eligible.id AND e.kind='question.resolved'
          AND e.payload->>'request_id'=${alias}.payload->'answer'->>'request_id')))`
      // 恢复后冻结的旧行保留补报入口，不占用后续显式操作的派发顺序。
      const due = `o.acked_at IS NULL AND o.completed_at IS NULL AND o.next_attempt_at<=statement_timestamp()
    AND EXISTS(SELECT 1 FROM threads eligible WHERE eligible.id=o.thread_id
      AND (${answerDue('o')} OR (o.action='answer' AND o.attempts>0))
      AND (eligible.status<>'archived' OR o.action IN ('stop','withdraw') OR (o.action='answer' AND o.attempts>0))
      AND (o.action IN ('open','stop') OR (eligible.opened_at IS NOT NULL AND eligible.storage_generation IS NOT NULL))
      AND NOT EXISTS(SELECT 1 FROM thread_outbox older WHERE older.thread_id=o.thread_id AND older.acked_at IS NULL AND older.completed_at IS NULL AND older.next_attempt_at<>'infinity' AND older.id<o.id AND ${answerDue('older')}
        AND (eligible.status<>'archived' OR older.action IN ('stop','withdraw'))
        AND (older.action IN ('open','stop') OR eligible.opened_at IS NOT NULL)))`
      const rows = yield* sql.unsafe<{ command: Outbox; thread: Thread }>(`WITH candidates AS MATERIALIZED (
    SELECT p.node_id FROM node_presence p JOIN nodes n ON n.id=p.node_id AND n.employee_id=p.employee_id
    JOIN node_credentials c ON c.node_id=n.id AND c.employee_id=n.employee_id AND c.version=n.credential_version
      AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp()
    CROSS JOIN LATERAL (SELECT o.id,o.next_attempt_at FROM thread_outbox o WHERE o.node_id=p.node_id AND ${due} ORDER BY o.next_attempt_at,o.id LIMIT 1) first_due
    WHERE p.online AND p.synced AND n.revoked_at IS NULL ORDER BY first_due.next_attempt_at,first_due.id
  ) SELECT command.* FROM candidates p CROSS JOIN LATERAL (
    SELECT to_jsonb(o) AS command,jsonb_strip_nulls(to_jsonb(t)-'request_hash') AS thread
    FROM (SELECT o.* FROM thread_outbox o WHERE o.node_id=p.node_id AND ${due} ORDER BY o.next_attempt_at,o.id FOR UPDATE OF o SKIP LOCKED) o
    CROSS JOIN LATERAL (SELECT t.* FROM threads t WHERE t.id=o.thread_id AND (t.status<>'archived' OR o.action IN ('stop','withdraw') OR (o.action='answer' AND o.attempts>0))
      AND (o.action IN ('open','stop') OR (t.opened_at IS NOT NULL AND t.storage_generation IS NOT NULL)) FOR UPDATE OF t SKIP LOCKED) t LIMIT 4
  ) command LIMIT 32`)
      const commands: ClaimedCommand[] = []
      for (const row of rows) {
        const o = row.command
        const t = row.thread
        const body: ThreadCommand = {
          ...(o.trace_context ? { trace_context: o.trace_context } : {}),
          type: 'thread.command',
          thread_id: t.id,
          action: o.action,
          ...(o.action !== 'open' && t.storage_generation ? { storage_generation: t.storage_generation } : {}),
          ...(o.payload.client_message_id ? { client_message_id: o.payload.client_message_id } : {}),
          ...(o.action === 'answer' ? { answer: o.payload.answer } : {}),
          ...(o.action === 'settings' ? { execution_timeout_seconds: o.payload.execution_timeout_seconds } : {}),
          ...(o.action === 'open'
            ? {
                agent_type: t.agent_type,
                model: o.payload.model || '',
                working_directory: t.working_directory,
                execution_timeout_seconds: o.payload.execution_timeout_seconds,
                ...(t.project_id
                  ? {
                      project_id: t.project_id,
                      origin_conversation_id: t.origin_conversation_id!,
                      origin_tool_call_id: t.origin_tool_call_id!,
                    }
                  : {}),
              }
            : {}),
        }
        if (o.action === 'message') {
          const messages = yield* sql<{
            content: string
            mode: 'queue' | 'steer'
            model: string
          }>`SELECT content,mode,model FROM thread_messages WHERE employee_id=${o.employee_id} AND thread_id=${t.id} AND client_message_id=${o.payload.client_message_id!}`
          if (!messages.length) return yield* Effect.fail(failure())
          Object.assign(body, messages[0]!)
        }
        const dispatchTrace = yield* withTraceSpan(captureTrace, 'baton.command.dispatch', o.trace_context, {
          kind: 'producer',
          attributes: { 'baton.command.id': o.message_id, 'baton.thread.id': t.id },
        })
        if (dispatchTrace) Object.assign(body, { trace_context: dispatchTrace })
        if (
          Buffer.byteLength(
            JSON.stringify({
              kind: 'envelope',
              envelope: {
                version: 1,
                message_id: o.message_id,
                route: { to: o.node_id },
                priority: 'control',
                source: { kind: 'control' },
                body,
              },
            }),
          ) >
          256 * 1024
        )
          return yield* Effect.fail(failure('message_too_large', 413))
        // 新的执行可能开始后，旧的停止确认不能用于归档。
        if (['open', 'resume', 'message'].includes(o.action) && t.stop_confirmed_at)
          yield* sql`UPDATE threads SET stop_requested_at=NULL,stop_confirmed_at=NULL WHERE id=${t.id}`
        yield* sql`UPDATE thread_outbox SET attempts=LEAST(attempts::bigint+1,2147483647)::integer,
      next_attempt_at=clock_timestamp()+make_interval(secs=>LEAST(30.0,power(2.0,LEAST(attempts,5)))*(0.8+random()*0.2)) WHERE id=${o.id}`
        commands.push({ message_id: o.message_id, node_id: o.node_id, employee_id: o.employee_id, body })
      }
      // 核查只在当前连接发起，短期 challenge 与持久业务命令使用独立身份。
      const checks = yield* sql<{ thread: Thread; conn_id: string; worker_turn_seq: number }>`
        SELECT jsonb_strip_nulls(to_jsonb(t)-'request_hash') AS thread,p.conn_id,v.worker_turn_seq::float8 AS worker_turn_seq
        FROM threads t JOIN thread_turns v ON v.thread_id=t.id AND v.ended_at IS NULL
        JOIN nodes n ON n.id=t.node_id AND n.employee_id=t.employee_id AND n.revoked_at IS NULL
        JOIN node_credentials c ON c.node_id=n.id AND c.employee_id=n.employee_id AND c.version=n.credential_version
          AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp()
        JOIN node_presence p ON p.node_id=n.id AND p.employee_id=n.employee_id AND p.online AND p.synced
        WHERE t.status='running' AND t.last_reported_at<clock_timestamp()-interval '30 seconds'
          AND EXISTS(SELECT 1 FROM thread_events e WHERE e.thread_id=t.id AND e.kind='turn.started'
            AND (e.payload->>'worker_turn_seq')::bigint=v.worker_turn_seq AND e.payload->>'execution_id' IS NOT NULL)
          AND NOT EXISTS(SELECT 1 FROM thread_events e WHERE e.thread_id=t.id AND e.kind='turn.activity_check'
            AND e.payload->>'conn_id'=p.conn_id AND e.created_at>clock_timestamp()-interval '30 seconds')
        ORDER BY t.last_reported_at,t.id LIMIT 8 FOR UPDATE OF t SKIP LOCKED`
      for (const { thread: t, conn_id, worker_turn_seq } of checks) {
        const message_id = uuid()
        const [check] = yield* sql<{
          check_seq: number
        }>`INSERT INTO thread_events(employee_id,thread_id,kind,actor,actor_id,payload)
          VALUES(${t.employee_id},${t.id},'turn.activity_check','system',${t.node_id},
            ${JSON.stringify({ command_id: message_id, conn_id, worker_turn_seq })}::jsonb) RETURNING id::float8 AS check_seq`
        commands.push({
          message_id,
          node_id: t.node_id,
          employee_id: t.employee_id,
          body: {
            type: 'thread.command',
            thread_id: t.id,
            action: 'check_activity',
            storage_generation: t.storage_generation!,
            activity_check_seq: check!.check_seq,
          },
        })
      }
      return commands
    }),
  )

export const processReceipt = (
  source: NodeSource,
  correlationCommandID: string,
  input: ThreadCommandResult,
): DB<void> =>
  transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const result = yield* decode(ResultSchema, input)
      yield* lockNodeSource(source)
      const t = yield* readThread(source.employee_id, result.thread_id, true)
      if (t.node_id !== source.node_id) return yield* Effect.fail(failure('not_found', 404))
      yield* revalidateNodeSource(source)
      if (result.activity_check_seq !== undefined) {
        const [check] = yield* sql<{ payload: { worker_turn_seq: number } }>`SELECT payload FROM thread_events
          WHERE id=${result.activity_check_seq} AND thread_id=${t.id} AND employee_id=${source.employee_id}
            AND kind='turn.activity_check' AND payload->>'command_id'=${correlationCommandID}
            AND payload->>'conn_id'=${source.conn_id} AND created_at>clock_timestamp()-interval '60 seconds'`
        if (!check) return yield* Effect.fail(failure('activity_check_rejected'))
        const [old] = yield* sql<{ payload: ThreadCommandResult }>`SELECT payload FROM thread_events
          WHERE thread_id=${t.id} AND kind='turn.activity_checked'
            AND (payload->>'activity_check_seq')::bigint=${result.activity_check_seq}`
        if (old) {
          if (canonical(old.payload) !== canonical(result)) return yield* Effect.fail(failure())
          return
        }
        const newer = yield* sql`SELECT id FROM thread_events WHERE thread_id=${t.id} AND kind='turn.activity_checked'
          AND (payload->>'activity_check_seq')::bigint>${result.activity_check_seq}`
        if (newer.length) return yield* Effect.fail(failure('activity_check_rejected'))
        if (result.ok) {
          const active = result.active_turn
          if (
            !active ||
            active.worker_turn_seq !== check.payload.worker_turn_seq ||
            result.storage_generation !== t.storage_generation
          )
            return yield* Effect.fail(failure('activity_check_rejected'))
          const turns = yield* sql`SELECT v.id FROM thread_turns v JOIN thread_events e ON e.thread_id=v.thread_id
            AND e.kind='turn.started' AND (e.payload->>'worker_turn_seq')::bigint=v.worker_turn_seq
            AND e.payload->>'execution_id'=${active.execution_id}
            WHERE v.thread_id=${t.id} AND v.worker_turn_seq=${active.worker_turn_seq} AND v.ended_at IS NULL`
          if (!turns.length) return yield* Effect.fail(failure('activity_check_rejected'))
        }
        yield* audit(t, 'turn.activity_checked', result, 'device', source.node_id)
        if (result.ok) yield* recordNodeBusiness(source)
        else yield* revalidateNodeSource(source)
        return
      }
      const rows = yield* sql<{
        value: Outbox
      }>`SELECT to_jsonb(o) AS value FROM thread_outbox o WHERE message_id=${correlationCommandID} AND employee_id=${source.employee_id} AND node_id=${source.node_id} AND thread_id=${result.thread_id} FOR UPDATE`
      if (!rows.length) return yield* Effect.fail(failure('not_found', 404))
      const o = rows[0]!.value
      yield* revalidateNodeSource(source)
      if (o.acked_at) {
        if (canonical(o.result) !== canonical(result)) return yield* Effect.fail(failure())
        return
      }
      if (result.storage_generation && t.storage_generation && result.storage_generation !== t.storage_generation)
        return yield* Effect.fail(failure('storage_generation_mismatch'))
      if (result.ok && o.action === 'open') {
        if (!result.storage_generation) return yield* Effect.fail(failure('storage_generation_required', 422))
        yield* sql`UPDATE threads SET storage_generation=COALESCE(storage_generation,${result.storage_generation}) WHERE id=${t.id}`
      }
      // 迟到的接收回执只补记接收事实，保留已经提交的执行结果。
      yield* sql`UPDATE thread_outbox SET acked_at=clock_timestamp(),result=${JSON.stringify(result)}::jsonb WHERE id=${o.id}`
      if (!result.ok && !o.completed_at) {
        yield* sql`UPDATE thread_outbox SET completed_at=clock_timestamp(),completion=${JSON.stringify({ command_outcome: 'failed', reason: result.code || 'command_rejected' })}::jsonb WHERE id=${o.id}`
        if (o.action === 'message')
          yield* sql`UPDATE thread_messages SET status='withdrawn',status_reason=${result.code || 'command_rejected'} WHERE employee_id=${source.employee_id} AND thread_id=${t.id} AND client_message_id=${o.payload.client_message_id!} AND status IN ('accepted','queued')`
        if (o.action === 'open') {
          yield* sql`UPDATE threads SET status='stopped',status_reason=${result.code || 'open_rejected'},version=version+1 WHERE id=${t.id} AND opened_at IS NULL`
          yield* sql`UPDATE thread_messages SET status='withdrawn',status_reason=${result.code || 'open_rejected'} WHERE thread_id=${t.id} AND status='accepted'
          AND EXISTS(SELECT 1 FROM thread_outbox o WHERE o.thread_id=${t.id} AND o.action='message' AND o.payload->>'client_message_id'=thread_messages.client_message_id AND o.attempts=0 AND o.acked_at IS NULL)`
          yield* sql`UPDATE thread_outbox SET completed_at=clock_timestamp(),completion=${JSON.stringify({ command_outcome: 'cancelled', reason: result.code || 'open_rejected' })}::jsonb WHERE thread_id=${t.id} AND action='message' AND attempts=0 AND acked_at IS NULL AND completed_at IS NULL`
        }
      } else if (result.ok && o.action === 'message' && !o.completed_at) {
        yield* sql`UPDATE thread_messages SET status='queued' WHERE employee_id=${source.employee_id} AND thread_id=${t.id} AND client_message_id=${o.payload.client_message_id!} AND status='accepted'`
      }
      yield* notifyProjectThread(t)
      yield* audit(t, 'command.received', { command_id: correlationCommandID, ...result }, 'device', source.node_id)
      if (result.ok) yield* recordNodeBusiness(source)
      else yield* revalidateNodeSource(source)
    }),
  )
