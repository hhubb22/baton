import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import type { Thread, ThreadReport } from '@baton/protocol'
import { insertProjectInput } from '../project/project-inputs.ts'

function truncate(text: string, bytes: number) {
  const raw = Buffer.from(text)
  if (raw.length <= bytes) return text
  let head = Math.floor(bytes / 2),
    tail = raw.length - Math.floor(bytes / 2)
  while (head && (raw[head]! & 0xc0) === 0x80) head--
  while (tail < raw.length && (raw[tail]! & 0xc0) === 0x80) tail++
  return (
    raw.subarray(0, head).toString() +
    `\n[原文 ${raw.length} 字节，完整内容用 threads.read 读取]\n` +
    raw.subarray(tail).toString()
  )
}
function boundPayload<
  T extends { content?: string; command_result?: { output: string; truncated: boolean; encoding?: unknown } },
>(payload: T, limit: number): T {
  const original = payload.content ?? payload.command_result?.output ?? ''
  let size = Math.min(32768, Buffer.byteLength(original))
  for (;;) {
    if (payload.content !== undefined) payload.content = truncate(original, size)
    if (payload.command_result) {
      if (payload.command_result.encoding === 'base64') {
        const bytes = Buffer.from(original, 'base64')
        const half = Math.floor((Math.floor(size / 4) * 3) / 2)
        payload.command_result.output =
          bytes.length <= half * 2
            ? original
            : Buffer.concat([bytes.subarray(0, half), bytes.subarray(bytes.length - half)]).toString('base64')
      } else payload.command_result.output = truncate(original, size)
      payload.command_result.truncated ||= size < Buffer.byteLength(original)
    }
    if (Buffer.byteLength(JSON.stringify(payload)) * 1.1 + 512 <= limit || size === 0) return payload
    size = Math.floor(size * 0.75)
  }
}

/** 调用方持有 Thread 锁；输入追加不取得 Agent 锁。 */
export const notifyProjectThread = Effect.fnUntraced(function* (t: Thread, r?: ThreadReport) {
  if (!t.project_id) return
  const sql = yield* SqlClient.SqlClient
  const agents = yield* sql<{
    id: string
  }>`SELECT id FROM project_agents WHERE employee_id=${t.employee_id} AND project_id=${t.project_id}`
  const agentId = agents[0]?.id
  if (!agentId) return
  if (!r || r.history_unavailable || ['message.withdrawn', 'thread.open_failed'].includes(r.kind)) {
    const failed = yield* sql<{
      id: string
      client_message_id: string
      origin_tool_call_id: string
      status_reason: string
    }>`SELECT id,client_message_id,origin_tool_call_id,status_reason FROM thread_messages WHERE employee_id=${t.employee_id} AND thread_id=${t.id} AND sender='project_agent' AND status='withdrawn' AND status_reason<>''`
    for (const m of failed)
      yield* insertProjectInput(
        t.employee_id,
        agentId,
        'thread_message_failed',
        `thread:${t.id}:message:${m.id}:failed`,
        {
          thread_id: t.id,
          client_message_id: m.client_message_id,
          origin_tool_call_id: m.origin_tool_call_id,
          reason: m.status_reason,
          version: t.version + 1,
        },
      )
  }
  if (
    t.agent_type === 'shell' &&
    (r?.kind === 'message.unknown' || r?.kind === 'thread.unknown' || r?.history_unavailable)
  ) {
    const [message] = yield* sql<{
      client_message_id: string
      origin_tool_call_id: string
      status_reason: string
    }>`SELECT m.client_message_id,m.origin_tool_call_id,m.status_reason FROM thread_messages m
 WHERE m.employee_id=${t.employee_id} AND m.thread_id=${t.id} AND m.sender='project_agent' AND m.status='unknown'
 AND NOT EXISTS(SELECT 1 FROM thread_turns v WHERE v.employee_id=m.employee_id AND v.thread_id=m.thread_id)
 ORDER BY m.created_at,m.id LIMIT 1`
    if (message) {
      yield* insertProjectInput(t.employee_id, agentId, 'thread_message_failed', `thread:${t.id}:message:unknown`, {
        thread_id: t.id,
        client_message_id: message.client_message_id,
        origin_tool_call_id: message.origin_tool_call_id,
        status: 'unknown',
        outcome: 'unknown',
        automatic_retry: false,
        reason: message.status_reason || r?.reason || 'execution_outcome_unknown',
        message: '命令可能已经产生副作用，执行结果无法确认。不得自动重发；请读取 Thread 状态并向用户说明。',
        version: t.version + 1,
      })
      // Thread 锁串行化终态工具结果与报告；迟到通知沿用已交付结果的序号。
      yield* sql`UPDATE project_agent_input_queue q SET delivered_seq=e.seq,wake_required=false
 FROM threads origin JOIN conversation_events e ON e.employee_id=origin.employee_id AND e.conversation_id=origin.origin_conversation_id AND e.tool_call_id=origin.origin_tool_call_id
 WHERE origin.employee_id=${t.employee_id} AND origin.id=${t.id} AND e.kind='tool_result'
 AND e.payload->'message'->>'toolName'='nodes.exec' AND e.payload->>'consumed_thread_id'=origin.id::text
 AND q.employee_id=${t.employee_id} AND q.agent_id=${agentId} AND q.source_type='thread_message_failed'
 AND q.source_key=${`thread:${t.id}:message:unknown`} AND q.delivered_seq IS NULL`
    }
  }
  if (r?.kind === 'reply' && t.agent_type !== 'shell') {
    const rows = yield* sql<{
      content: string
      worker_turn_seq: number
      original_bytes: number
      metadata: unknown
      attachments: unknown
    }>`SELECT p.content,p.worker_turn_seq::float8 AS worker_turn_seq,p.original_bytes::float8 AS original_bytes,p.metadata,p.attachments FROM thread_replies p JOIN thread_turns v ON v.id=p.turn_id AND v.employee_id=p.employee_id WHERE p.employee_id=${t.employee_id} AND p.thread_id=${t.id} AND p.worker_seq=${r.worker_seq} AND v.initiator='project_agent'`
    if (rows[0])
      yield* insertProjectInput(
        t.employee_id,
        agentId,
        'thread_reply',
        `thread:${t.id}:reply:${r.worker_seq}`,
        boundPayload({ thread_id: t.id, worker_seq: r.worker_seq, ...rows[0] }, 40960),
      )
  }
  if (r?.kind === 'turn.ended' || r?.history_unavailable) {
    const turns = yield* sql<{
      worker_turn_seq: number
      end_reason: string
      reply_count: number
    }>`SELECT v.worker_turn_seq::float8 AS worker_turn_seq,v.end_reason,(SELECT count(*)::integer FROM thread_replies p WHERE p.employee_id=v.employee_id AND p.turn_id=v.id) AS reply_count FROM thread_turns v WHERE v.employee_id=${t.employee_id} AND v.thread_id=${t.id} AND v.initiator='project_agent' AND v.ended_at IS NOT NULL AND (${r.history_unavailable ?? false} OR v.worker_turn_seq=${r.worker_turn_seq ?? 0}) ORDER BY v.worker_turn_seq`
    for (const turn of turns) {
      const payload = { thread_id: t.id, ...turn, version: t.version + 1 } as {
        thread_id: string
        worker_turn_seq: number
        end_reason: string
        reply_count: number
        version: number
        command_result?: {
          output: string
          total_bytes: number
          truncated: boolean
          exit_code?: unknown
          encoding?: unknown
        }
      }
      if (t.agent_type === 'shell') {
        const replies = yield* sql<{
          content: string
          original_bytes: number
          truncated: boolean
          metadata: Record<string, unknown>
        }>`SELECT content,original_bytes::float8 AS original_bytes,truncated,metadata FROM thread_replies WHERE employee_id=${t.employee_id} AND thread_id=${t.id} AND worker_turn_seq=${turn.worker_turn_seq} ORDER BY worker_seq`
        payload.command_result = {
          output: replies.map((p) => p.content).join(''),
          total_bytes: replies.reduce((n, p) => n + p.original_bytes, 0),
          truncated: replies.some((p) => p.truncated),
          ...Object.fromEntries(
            replies.flatMap((p) => Object.entries(p.metadata).filter(([k]) => k === 'encoding' || k === 'exit_code')),
          ),
        }
      }
      yield* insertProjectInput(
        t.employee_id,
        agentId,
        'turn_ended',
        `thread:${t.id}:turn:${turn.worker_turn_seq}`,
        boundPayload(payload, payload.command_result ? 73728 : 4096),
      )
    }
  }
})
