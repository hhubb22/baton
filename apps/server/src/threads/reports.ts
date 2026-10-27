import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as P from '@baton/protocol'
import type { NodeSource } from '../errors.ts'
import { lockNodeSource, recordNodeBusiness, revalidateNodeSource } from '../nodes.ts'
import { notifyProjectThread } from './project-inputs.ts'
import { audit, decode, failure, readThread, uuid, type DB } from './core.ts'
import { canonical, digest } from '../json.ts'
import { transaction } from '../database.ts'
import { reportStopCode } from './stop-code.ts'

const status = (t: P.Thread, next: P.Thread['status'], reason = '', stopCode: P.ThreadStopCode | null = null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    if (
      t.status === 'archived' ||
      (t.status === next && t.status_reason === reason && (t.stop_code ?? null) === stopCode)
    )
      return
    yield* sql`UPDATE threads SET status=${next},status_reason=${reason},stop_code=${stopCode} WHERE id=${t.id}`
    yield* audit(
      t,
      'status.changed',
      { status: next, reason, ...(stopCode ? { stop_code: stopCode } : {}) },
      'device',
      t.node_id,
    )
  })
const noActiveTurn = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql`SELECT id FROM thread_turns WHERE thread_id=${id} AND ended_at IS NULL`
    if (rows.length) return yield* Effect.fail(failure())
  })
const getMessage = (t: P.Thread, id: string | undefined) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{
      value: P.ThreadMessage
    }>`SELECT jsonb_strip_nulls(to_jsonb(m)-'employee_id') AS value FROM thread_messages m WHERE employee_id=${t.employee_id} AND thread_id=${t.id} AND client_message_id=${id || ''}`
    if (!rows.length) return yield* Effect.fail(failure())
    return rows[0]!.value
  })
const getTurn = (t: P.Thread, seq: number | undefined) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{
      value: P.ThreadTurn
    }>`SELECT row_to_json(v) AS value FROM thread_turns v WHERE employee_id=${t.employee_id} AND thread_id=${t.id} AND worker_turn_seq=${seq || 0}`
    if (!rows.length) return yield* Effect.fail(failure())
    return yield* decode(
      P.ThreadTurn,
      Object.fromEntries(
        Object.entries(rows[0]!.value).filter(([key, value]) => value !== null || key === 'token_usage'),
      ),
    )
  })
const finishArchive = (t: P.Thread) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows =
      yield* sql`UPDATE threads SET status='archived',stop_code=NULL,archived_at=clock_timestamp() WHERE id=${t.id}
    AND archive_requested_at IS NOT NULL AND stop_confirmed_at IS NOT NULL AND status IN ('idle','stopped','unknown')
    AND NOT EXISTS(SELECT 1 FROM thread_turns WHERE thread_id=${t.id} AND ended_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM thread_messages WHERE thread_id=${t.id} AND status IN ('accepted','queued')) AND archived_at IS NULL RETURNING id`
    if (rows.length) {
      const [request] = yield* sql<{
        actor: string
        actor_id: string
      }>`SELECT actor,actor_id FROM thread_events WHERE employee_id=${t.employee_id} AND thread_id=${t.id} AND kind='archive.requested' ORDER BY id DESC LIMIT 1`
      yield* audit(t, 'thread.archived', {}, request?.actor ?? 'employee', request?.actor_id ?? t.employee_id)
    }
  })
const auditTurnEnded = Effect.fnUntraced(function* (t: P.Thread, r: P.ThreadReport) {
  const sql = yield* SqlClient.SqlClient
  const [count] = yield* sql<{
    item_count: number
  }>`SELECT count(*)::integer AS item_count FROM thread_turn_items WHERE employee_id=${t.employee_id} AND thread_id=${t.id} AND worker_turn_seq=${r.worker_turn_seq!}`
  const { token_usage: _usage, ...event } = r
  yield* audit(t, 'turn.ended', { ...event, item_count: count!.item_count }, 'device', t.node_id)
})

function boundedReply(content: string, max = 32768): string {
  const bytes = Buffer.from(content)
  if (bytes.length <= max) return content
  let head = bytes.subarray(0, max / 2)
  let tail = bytes.subarray(bytes.length - max / 2)
  while (head.length && (bytes[head.length]! & 0xc0) === 0x80) head = head.subarray(0, head.length - 1)
  while (tail.length && (tail[0]! & 0xc0) === 0x80) tail = tail.subarray(1)
  return head.toString() + tail.toString()
}

const apply = (t: P.Thread, r: P.ThreadReport) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    if (r.model) yield* sql`UPDATE threads SET model=${r.model} WHERE id=${t.id}`
    switch (r.kind) {
      case 'thread.opened': {
        if (t.opened_at || t.status !== 'waiting_device' || !r.storage_generation) return yield* Effect.fail(failure())
        yield* sql`UPDATE threads SET storage_generation=${r.storage_generation},native_session_id=${r.native_session_id || ''},opened_at=clock_timestamp() WHERE id=${t.id}`
        yield* status(t, 'idle')
        break
      }
      case 'thread.open_failed': {
        if (t.opened_at) return yield* Effect.fail(failure())
        yield* noActiveTurn(t.id)
        yield* sql`UPDATE thread_messages SET status='withdrawn',status_reason=${r.reason || ''} WHERE thread_id=${t.id} AND status='accepted'
        AND EXISTS(SELECT 1 FROM thread_outbox o WHERE o.thread_id=${t.id} AND o.action='message' AND o.payload->>'client_message_id'=thread_messages.client_message_id AND o.attempts=0 AND o.acked_at IS NULL)`
        yield* sql`UPDATE thread_outbox SET completed_at=clock_timestamp(),completion=${JSON.stringify({ command_outcome: 'cancelled', reason: r.reason || 'open_failed' })}::jsonb WHERE thread_id=${t.id} AND action='message' AND attempts=0 AND acked_at IS NULL AND completed_at IS NULL`
        yield* status(t, 'stopped', r.reason, reportStopCode(t, r))
        break
      }
      case 'thread.resumed': {
        if (!t.opened_at || !['idle', 'running', 'stopped', 'unknown'].includes(t.status))
          return yield* Effect.fail(failure())
        yield* noActiveTurn(t.id)
        yield* sql`UPDATE threads SET stop_requested_at=NULL,stop_confirmed_at=NULL WHERE id=${t.id} AND stop_confirmed_at IS NOT NULL`
        yield* status(t, 'idle')
        break
      }
      case 'message.queued':
      case 'message.sent':
      case 'message.withdrawn':
      case 'message.unknown': {
        const m = yield* getMessage(t, r.client_message_id)
        const next = r.kind.slice(8)
        // 排队回执保留未知状态，后续执行证据仍沿原报告序号接收。
        if (m.status === 'unknown' && next === 'queued') break
        const valid =
          m.status === next ||
          (m.status === 'accepted' && next === 'queued') ||
          (['accepted', 'queued', 'unknown'].includes(m.status) && ['sent', 'unknown'].includes(next)) ||
          (['accepted', 'queued'].includes(m.status) && next === 'withdrawn')
        if (!valid) return yield* Effect.fail(failure())
        let turn: P.ThreadTurn | undefined
        if (next === 'sent') {
          turn = yield* getTurn(t, r.worker_turn_seq)
          if (turn.ended_at || (m.worker_turn_seq && m.worker_turn_seq !== turn.worker_turn_seq))
            return yield* Effect.fail(failure())
        }
        yield* sql`UPDATE thread_messages SET status=${next},turn_id=COALESCE(${turn?.id ?? null}::uuid,turn_id),worker_turn_seq=COALESCE(${turn?.worker_turn_seq ?? null}::bigint,worker_turn_seq),status_reason=${r.reason || ''} WHERE id=${m.id}`
        if (next === 'unknown') yield* status(t, 'unknown', r.reason, reportStopCode(t, r))
        if (next === 'withdrawn' && r.reason) {
          const active = yield* sql`SELECT id FROM thread_turns WHERE thread_id=${t.id} AND ended_at IS NULL`
          if (!active.length && t.opened_at && !t.stop_requested_at) yield* status(t, 'idle')
        }
        break
      }
      case 'turn.started': {
        if (t.agent_type === 'shell' && r.worker_turn_seq !== 1)
          return yield* Effect.fail(failure('shell_single_turn', 422))
        if (!t.opened_at || !['idle', 'stopped', 'unknown', 'running'].includes(t.status))
          return yield* Effect.fail(failure())
        yield* noActiveTurn(t.id)
        const m = yield* getMessage(t, r.client_message_id)
        if (['sent', 'withdrawn'].includes(m.status) || m.worker_turn_seq) return yield* Effect.fail(failure())
        const next = yield* sql<{
          seq: number
        }>`SELECT (COALESCE(max(worker_turn_seq),0)+1)::integer AS seq FROM thread_turns WHERE thread_id=${t.id}`
        if (r.worker_turn_seq !== next[0]!.seq) return yield* Effect.fail(failure())
        const id = uuid()
        const model = r.model || m.model || t.model
        yield* sql`INSERT INTO thread_turns(id,employee_id,thread_id,worker_turn_seq,initiator,origin_tool_call_id,started_at,model) VALUES(${id},${t.employee_id},${t.id},${r.worker_turn_seq},${m.sender},${m.origin_tool_call_id ?? null},clock_timestamp(),${model})`
        yield* sql`UPDATE thread_messages SET turn_id=${id},worker_turn_seq=${r.worker_turn_seq} WHERE id=${m.id}`
        yield* sql`UPDATE threads SET model=${model} WHERE id=${t.id}`
        yield* sql`UPDATE threads SET stop_requested_at=NULL,stop_confirmed_at=NULL WHERE id=${t.id} AND stop_confirmed_at IS NOT NULL`
        yield* status(t, 'running')
        break
      }
      case 'question.pending': {
        if (!r.question || !r.worker_turn_seq) return yield* Effect.fail(failure('invalid_question', 422))
        const turn = yield* getTurn(t, r.worker_turn_seq)
        if (turn.ended_at) return yield* Effect.fail(failure('question_closed'))
        const old = yield* sql`SELECT id FROM thread_events WHERE thread_id=${t.id} AND kind='question.pending'
          AND payload->'question'->>'request_id'=${r.question.request_id}`
        if (old.length) return yield* Effect.fail(failure('question_conflict'))
        break
      }
      case 'question.resolved': {
        if (!r.request_id) return yield* Effect.fail(failure('invalid_question', 422))
        const old = yield* sql`SELECT id FROM thread_events WHERE thread_id=${t.id} AND kind='question.pending'
          AND payload->'question'->>'request_id'=${r.request_id}`
        if (!old.length) return yield* Effect.fail(failure('question_closed'))
        break
      }
      case 'reply': {
        const turn = yield* getTurn(t, r.worker_turn_seq)
        if (turn.ended_at) return yield* Effect.fail(failure())
        let content = r.content || ''
        let original = Math.max(Buffer.byteLength(content), r.original_bytes || 0)
        if (r.metadata?.encoding === 'base64') {
          const bytes = Buffer.from(content, 'base64')
          if (bytes.length > 32768 || bytes.toString('base64') !== content)
            return yield* Effect.fail(failure('invalid_reply', 422))
          original = Math.max(bytes.length, r.original_bytes || 0)
        } else content = boundedReply(content)
        const truncated = Boolean(
          r.truncated ||
          original >
            (r.metadata?.encoding === 'base64' ? Buffer.from(content, 'base64').length : Buffer.byteLength(content)),
        )
        const attachments = r.attachments ?? []
        yield* sql`INSERT INTO thread_replies(id,employee_id,thread_id,worker_seq,turn_id,worker_turn_seq,content,truncated,original_bytes,attachments,metadata)
        VALUES(${uuid()},${t.employee_id},${t.id},${r.worker_seq},${turn.id},${turn.worker_turn_seq},${content},${truncated},${original},${JSON.stringify(attachments)}::jsonb,${JSON.stringify(r.metadata || {})}::jsonb)`
        // 时间线只保存中心的有界回复。
        yield* audit(
          t,
          'reply',
          { ...r, content, truncated, original_bytes: original, attachments },
          'device',
          t.node_id,
        )
        break
      }
      case 'turn.item': {
        if (!r.item) return yield* Effect.fail(failure('invalid_item', 422))
        const turn = yield* getTurn(t, r.worker_turn_seq)
        if (turn.ended_at) return yield* Effect.fail(failure())
        const item = r.item
        if (Buffer.byteLength(JSON.stringify(item)) > 192 * 1024)
          return yield* Effect.fail(failure('invalid_item', 422))
        const fullOutput =
          r.metadata?.full_output === undefined
            ? undefined
            : yield* decode(P.FullOutputReference, r.metadata.full_output)
        if (fullOutput && fullOutput.storage_generation !== t.storage_generation)
          return yield* Effect.fail(failure('storage_generation_mismatch'))
        yield* sql`INSERT INTO thread_turn_items(employee_id,thread_id,worker_turn_seq,item_id,worker_seq,ordinal,parent_id,type,status,title,started_at,completed_at,data,truncated,original_bytes,full_output)
          VALUES(${t.employee_id},${t.id},${turn.worker_turn_seq},${item.id},${r.worker_seq},${item.ordinal},${item.parent_id ?? null},${item.type},${item.status},${item.title ?? null},${item.started_at ?? null}::timestamptz,${item.completed_at ?? null}::timestamptz,${JSON.stringify(item.data)}::json,${r.truncated!},${r.original_bytes!},${fullOutput === undefined ? null : JSON.stringify(fullOutput)}::json)
          ON CONFLICT (employee_id,thread_id,worker_turn_seq,item_id) DO NOTHING`
        break
      }
      case 'turn.ended': {
        const turn = yield* getTurn(t, r.worker_turn_seq)
        if (turn.ended_at || !['completed', 'stopped', 'timeout', 'agent_exited', 'failed'].includes(r.reason || ''))
          return yield* Effect.fail(failure())
        yield* sql`UPDATE thread_turns SET ended_at=clock_timestamp(),end_reason=${r.reason!},model=${r.model || turn.model},token_usage=${r.token_usage === undefined ? null : JSON.stringify(r.token_usage)}::json WHERE id=${turn.id}`
        if (t.stop_requested_at && ['stopped', 'timeout'].includes(r.reason!))
          yield* sql`UPDATE threads SET stop_confirmed_at=clock_timestamp() WHERE id=${t.id}`
        yield* status(
          t,
          t.agent_type === 'shell' ? 'stopped' : r.queue_empty ? 'idle' : 'running',
          '',
          t.agent_type === 'shell'
            ? reportStopCode(t, r, !!t.stop_requested_at && ['stopped', 'timeout'].includes(r.reason!))
            : null,
        )
        break
      }
      case 'thread.stopped':
      case 'thread.unknown': {
        if (r.history_unavailable) {
          const ended = yield* sql<{
            worker_turn_seq: number
            model: string
          }>`UPDATE thread_turns SET ended_at=clock_timestamp(),end_reason='agent_exited'
            WHERE employee_id=${t.employee_id} AND thread_id=${t.id} AND ended_at IS NULL
            RETURNING worker_turn_seq::float8 AS worker_turn_seq,model`
          for (const turn of ended) {
            yield* auditTurnEnded(t, {
              ...r,
              kind: 'turn.ended',
              worker_turn_seq: turn.worker_turn_seq,
              model: turn.model,
              reason: 'agent_exited',
            })
          }
          yield* sql`UPDATE thread_messages m SET status='withdrawn',status_reason='history_unavailable_before_dispatch' WHERE thread_id=${t.id} AND status='accepted' AND worker_turn_seq IS NULL
          AND EXISTS(SELECT 1 FROM thread_outbox o WHERE o.thread_id=m.thread_id AND o.action='message' AND o.payload->>'client_message_id'=m.client_message_id)
          AND NOT EXISTS(SELECT 1 FROM thread_outbox o WHERE o.thread_id=m.thread_id AND o.action='message' AND o.payload->>'client_message_id'=m.client_message_id AND (o.attempts<>0 OR o.acked_at IS NOT NULL))`
          yield* sql`UPDATE thread_messages SET status='unknown',status_reason=${r.reason || 'history_unavailable'} WHERE thread_id=${t.id} AND status IN ('accepted','queued')`
          yield* sql`UPDATE thread_outbox SET completed_at=clock_timestamp(),completion=jsonb_build_object('command_outcome',CASE WHEN attempts=0 AND acked_at IS NULL THEN 'cancelled' ELSE 'unknown' END,'reason',${r.reason || 'history_unavailable'}::text) WHERE thread_id=${t.id} AND completed_at IS NULL`
        } else yield* noActiveTurn(t.id)
        if (!r.history_unavailable && r.kind === 'thread.stopped' && t.stop_requested_at)
          yield* sql`UPDATE threads SET stop_confirmed_at=clock_timestamp() WHERE id=${t.id}`
        yield* status(
          t,
          r.history_unavailable || r.kind === 'thread.unknown' ? 'unknown' : 'stopped',
          r.reason,
          reportStopCode(t, r, r.kind === 'thread.stopped' && !!t.stop_requested_at),
        )
        break
      }
      case 'command.completed': {
        const rows = yield* sql<{
          id: string
          action: string
          completion: P.ThreadReport | null
          completed_at: string | null
        }>`SELECT id,action,completion,completed_at FROM thread_outbox WHERE message_id=${r.command_id!} AND employee_id=${t.employee_id} AND node_id=${t.node_id} AND thread_id=${t.id}`
        if (!rows.length) return yield* Effect.fail(failure('not_found', 404))
        const o = rows[0]!
        if (o.completed_at) {
          if (canonical(o.completion) !== canonical(r)) return yield* Effect.fail(failure())
        } else
          yield* sql`UPDATE thread_outbox SET completed_at=clock_timestamp(),completion=${JSON.stringify(r)}::jsonb WHERE id=${o.id}`
        break
      }
    }
  })

export const processReport = (source: NodeSource, input: P.ThreadReport): DB<P.ThreadReportResult> =>
  transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const r = yield* decode(P.ThreadReport, input)
      if (r.history_unavailable && !['thread.stopped', 'thread.unknown'].includes(r.kind))
        return yield* Effect.fail(failure('invalid_report', 422))
      yield* lockNodeSource(source)
      const t = yield* readThread(source.employee_id, r.thread_id, true)
      yield* sql`SELECT id FROM thread_outbox WHERE employee_id=${source.employee_id} AND thread_id=${r.thread_id} AND (completed_at IS NULL OR message_id=${r.command_id ?? null}::uuid) ORDER BY id FOR UPDATE`
      if (t.node_id !== source.node_id) return yield* Effect.fail(failure('not_found', 404))
      yield* revalidateNodeSource(source)
      const hash = digest(r)
      const old = yield* sql<{
        payload_hash: Uint8Array
        ack: P.ThreadReportResult
      }>`SELECT payload_hash,ack FROM thread_reports WHERE employee_id=${source.employee_id} AND thread_id=${t.id} AND event_id=${r.event_id}`
      if (old.length) {
        if (!Buffer.from(old[0]!.payload_hash).equals(hash)) return yield* Effect.fail(failure())
        return old[0]!.ack
      }
      const ack: P.ThreadReportResult = {
        type: 'thread.report_result',
        thread_id: t.id,
        event_id: r.event_id,
        worker_seq: r.worker_seq,
        ok: false,
      }
      if (r.worker_seq !== t.last_worker_seq + 1)
        return { ...ack, code: 'worker_sequence_gap', expected_worker_seq: t.last_worker_seq + 1 }
      if (!r.storage_generation) return yield* Effect.fail(failure('storage_generation_required', 422))
      if (t.storage_generation && t.storage_generation !== r.storage_generation)
        return yield* Effect.fail(failure('storage_generation_mismatch'))
      if (!t.storage_generation) {
        const opens =
          yield* sql`SELECT id FROM thread_outbox WHERE thread_id=${t.id} AND node_id=${source.node_id} AND action='open'`
        if (
          !opens.length ||
          !['thread.opened', 'thread.open_failed', 'thread.stopped', 'thread.unknown', 'command.completed'].includes(
            r.kind,
          )
        )
          return yield* Effect.fail(failure())
        if (r.kind === 'command.completed') {
          const open =
            yield* sql`SELECT id FROM thread_outbox WHERE message_id=${r.command_id!} AND thread_id=${t.id} AND action='open'`
          if (!open.length) return yield* Effect.fail(failure())
        }
        yield* sql`UPDATE threads SET storage_generation=${r.storage_generation} WHERE id=${t.id}`
      }
      if (
        t.status === 'archived' &&
        !['command.completed', 'message.withdrawn', 'thread.stopped', 'question.resolved'].includes(r.kind)
      )
        return yield* Effect.fail(failure('thread_archived'))
      yield* apply(t, r)
      if (r.kind !== 'turn.item') yield* notifyProjectThread(t, r)
      yield* finishArchive(t)
      yield* sql`UPDATE threads SET last_worker_seq=${r.worker_seq},last_reported_at=clock_timestamp(),last_activity_at=clock_timestamp(),version=version+1 WHERE id=${t.id}`
      if (r.kind === 'turn.ended') yield* auditTurnEnded(t, r)
      else if (r.kind !== 'reply' && r.kind !== 'turn.item') yield* audit(t, r.kind, r, 'device', source.node_id)
      const savedAck: P.ThreadReportResult = { ...ack, ok: true }
      yield* sql`INSERT INTO thread_reports(employee_id,thread_id,event_id,worker_seq,payload_hash,ack) VALUES(${t.employee_id},${t.id},${r.event_id},${r.worker_seq},${hash},${JSON.stringify(savedAck)}::jsonb)`
      yield* recordNodeBusiness(source)
      return savedAck
    }),
  )
