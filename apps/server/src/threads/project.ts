import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import type { Thread } from '@baton/protocol'
import { transaction } from '../database.ts'
import { failure, readThread, type ThreadScope } from './core.ts'

type ThreadStatus = Thread['status']
type ExecOrigin = { conversationId: string; toolCallId: string }

const execState = Effect.fnUntraced(function* (scope: ThreadScope, origin: ExecOrigin) {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{
    id: string
    version: number
    status: ThreadStatus
    status_reason: string
    remaining: number
    ended: boolean
    wait_active: boolean
  }>`SELECT id,version::float8 AS version,status,status_reason,exec_wait_until>clock_timestamp() AS wait_active,GREATEST(0,FLOOR(EXTRACT(EPOCH FROM(exec_wait_until-clock_timestamp()))*1000))::float8 AS remaining,EXISTS(SELECT 1 FROM thread_turns v WHERE v.thread_id=t.id AND v.ended_at IS NOT NULL) AS ended FROM threads t WHERE employee_id=${scope.employeeId} AND (${scope.projectId ?? null}::uuid IS NULL OR project_id=${scope.projectId ?? null}) AND origin_conversation_id=${origin.conversationId} AND origin_tool_call_id=${origin.toolCallId} AND agent_type='shell'`
  return row
})

export const readExec = (scope: ThreadScope, origin: ExecOrigin) => transaction(execState(scope, origin))

const commandResult = Effect.fnUntraced(function* (employeeId: string, threadId: string) {
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

export const waitForExec = (scope: ThreadScope, origin: ExecOrigin, finishWait = false) =>
  transaction(
    Effect.gen(function* () {
      let row = yield* execState(scope, origin)
      if (!row) return yield* Effect.fail(failure('not_found', 404))
      if (!row.ended && !['stopped', 'unknown', 'archived'].includes(row.status) && row.remaining > 0 && !finishWait)
        return { thread: row, pending: true as const }
      yield* readThread(scope.employeeId, row.id, true, scope.projectId)
      row = yield* execState(scope, origin)
      if (!row) return yield* Effect.fail(failure('not_found', 404))
      const terminal = row.ended || ['stopped', 'unknown', 'archived'].includes(row.status)
      return {
        thread: row,
        pending: false as const,
        terminal,
        command: terminal ? yield* commandResult(scope.employeeId, row.id) : undefined,
      }
    }),
  )

export const listProjectThreads = (
  scope: ThreadScope & { projectId: string },
  query: { afterId?: string; status?: ThreadStatus } = {},
) =>
  transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{
        id: string
        value: {
          thread_id: string
          node_id: string
          agent_type: string
          runtime_mode: Thread['runtime_mode']
          working_directory: string
          status: ThreadStatus
          last_activity_at: string
        }
      }>`SELECT id,jsonb_build_object('thread_id',id,'node_id',node_id,'agent_type',agent_type,'runtime_mode',runtime_mode,'working_directory',working_directory,'status',status,'last_activity_at',last_activity_at) AS value FROM threads WHERE employee_id=${scope.employeeId} AND project_id=${scope.projectId} AND (${query.afterId ?? null}::uuid IS NULL OR id>${query.afterId ?? null}) AND (${query.status ?? null}::text IS NULL OR status=${query.status ?? null}) ORDER BY id LIMIT 20`
      return { threads: rows.map((r) => r.value), next_after_id: rows.at(-1)?.id ?? '' }
    }),
  )
