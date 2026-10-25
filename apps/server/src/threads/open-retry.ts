import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import type { Thread } from '@baton/protocol'

// 这些拒绝发生在 daemon 保存 Worker 配置和投递 open 之前。
export const canRetryOpen = Effect.fnUntraced(function* (t: Thread) {
  if (
    t.agent_type === 'shell' ||
    t.opened_at ||
    t.storage_generation ||
    t.last_worker_seq !== 0 ||
    t.status !== 'stopped' ||
    t.archive_requested_at ||
    (t.stop_requested_at && !t.stop_confirmed_at)
  )
    return false
  const sql = yield* SqlClient.SqlClient
  const [facts] = yield* sql<{ safe: boolean }>`SELECT
      EXISTS(SELECT 1 FROM thread_outbox WHERE thread_id=${t.id} AND action='open')
      AND NOT EXISTS(SELECT 1 FROM thread_outbox WHERE thread_id=${t.id} AND action='open' AND (
        acked_at IS NULL OR completed_at IS NULL OR result IS NULL OR result->>'ok' IS DISTINCT FROM 'false'
        OR result->>'storage_generation' IS NOT NULL
        OR COALESCE(result->>'code','') NOT IN ('agent_unavailable','invalid_working_directory','working_directory_forbidden')))
      AND NOT EXISTS(SELECT 1 FROM thread_outbox WHERE thread_id=${t.id} AND action='message' AND (attempts<>0 OR acked_at IS NOT NULL))
      AND NOT EXISTS(SELECT 1 FROM thread_turns WHERE thread_id=${t.id})
      AND NOT EXISTS(SELECT 1 FROM thread_messages WHERE thread_id=${t.id} AND (worker_turn_seq IS NOT NULL OR status<>'withdrawn')) AS safe`
  return facts?.safe ?? false
})
