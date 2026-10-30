import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import type { Thread, ThreadReport } from '@baton/protocol'
import { insertProjectInput } from '../project/inputs.ts'

function boundContent<T extends { content: string }>(payload: T): T {
  const raw = Buffer.from(payload.content)
  let size = Math.min(32768, raw.length)
  for (;;) {
    let head = Math.floor(size / 2),
      tail = raw.length - Math.floor(size / 2)
    while (head && (raw[head]! & 0xc0) === 0x80) head--
    while (tail < raw.length && (raw[tail]! & 0xc0) === 0x80) tail++
    payload.content =
      raw.length <= size
        ? raw.toString()
        : raw.subarray(0, head).toString() +
          `\n[原文 ${raw.length} 字节，完整内容用 threads.read 读取]\n` +
          raw.subarray(tail).toString()
    if (Buffer.byteLength(JSON.stringify(payload)) * 1.1 + 512 <= 40960 || size === 0) return payload
    size = Math.floor(size * 0.75)
  }
}

/** 调用方持有 Thread 锁；输入追加不取得 Agent 锁。 */
export const notifyProjectThread = Effect.fnUntraced(function* (t: Thread, r?: ThreadReport) {
  if (!t.project_id) return
  const sql = yield* SqlClient.SqlClient
  const [agent] = yield* sql<{
    id: string
  }>`SELECT id FROM project_agents WHERE employee_id=${t.employee_id} AND project_id=${t.project_id}`
  if (!agent) return
  if (!r || r.history_unavailable || ['message.withdrawn', 'thread.open_failed'].includes(r.kind)) {
    const failed = yield* sql<{
      id: string
      client_message_id: string
      origin_tool_call_id: string
      status_reason: string
    }>`SELECT id,client_message_id,origin_tool_call_id,status_reason
      FROM thread_messages WHERE employee_id=${t.employee_id} AND thread_id=${t.id} AND sender='project_agent' AND status='withdrawn' AND status_reason<>''`
    for (const m of failed)
      yield* insertProjectInput(
        t.employee_id,
        agent.id,
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
  if (r?.kind === 'reply') {
    const [reply] = yield* sql<{
      content: string
      worker_turn_seq: number
      original_bytes: number
      metadata: unknown
      attachments: unknown
    }>`SELECT
      p.content,p.worker_turn_seq::float8 AS worker_turn_seq,p.original_bytes::float8 AS original_bytes,p.metadata,p.attachments
      FROM thread_replies p JOIN thread_turns v ON v.id=p.turn_id AND v.employee_id=p.employee_id
      WHERE p.employee_id=${t.employee_id} AND p.thread_id=${t.id} AND p.worker_seq=${r.worker_seq} AND v.initiator='project_agent'`
    if (reply)
      yield* insertProjectInput(
        t.employee_id,
        agent.id,
        'thread_reply',
        `thread:${t.id}:reply:${r.worker_seq}`,
        boundContent({ thread_id: t.id, worker_seq: r.worker_seq, ...reply }),
      )
  }
  if (r?.kind === 'turn.ended' || r?.history_unavailable) {
    const turns = yield* sql<{
      worker_turn_seq: number
      end_reason: string
      reply_count: number
    }>`SELECT v.worker_turn_seq::float8 AS worker_turn_seq,v.end_reason,
      (SELECT count(*)::integer FROM thread_replies p WHERE p.employee_id=v.employee_id AND p.turn_id=v.id) AS reply_count
      FROM thread_turns v WHERE v.employee_id=${t.employee_id} AND v.thread_id=${t.id} AND v.initiator='project_agent'
      AND v.ended_at IS NOT NULL AND (${r.history_unavailable ?? false} OR v.worker_turn_seq=${r.worker_turn_seq ?? 0}) ORDER BY v.worker_turn_seq`
    for (const turn of turns)
      yield* insertProjectInput(t.employee_id, agent.id, 'turn_ended', `thread:${t.id}:turn:${turn.worker_turn_seq}`, {
        thread_id: t.id,
        ...turn,
        version: t.version + 1,
      })
  }
})
