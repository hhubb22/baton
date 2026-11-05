import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'

export interface GatewayDiagnostics {
  readonly nodes: number
  readonly browsers: number
  readonly pending_rpc: number
  readonly connections: number
  readonly pending_disconnects: number
  readonly received_bytes: number
  readonly sent_bytes: number
  readonly queued_control_messages: number
  readonly queued_control_bytes: number
}

/** Read live PostgreSQL state on demand instead of maintaining a background metrics loop. */
export const readDiagnostics = Effect.fn('readDiagnostics')(function* (
  employeeId: string,
  gateway: GatewayDiagnostics,
) {
  const sql = yield* SqlClient.SqlClient
  const [online] = yield* sql<{
    count: number
  }>`SELECT count(*)::integer AS count FROM node_presence WHERE employee_id=${employeeId}::uuid AND online`
  const outbox = yield* sql<{
    action: 'open' | 'message' | 'withdraw' | 'stop' | 'resume' | 'settings' | 'answer'
    pending: number
    oldest_unacked_seconds: number
  }>`SELECT action,count(*)::integer AS pending,GREATEST(0,extract(epoch FROM clock_timestamp()-min(created_at)))::float8 AS oldest_unacked_seconds FROM thread_outbox WHERE employee_id=${employeeId}::uuid AND acked_at IS NULL AND completed_at IS NULL GROUP BY action ORDER BY action`
  const [active] = yield* sql<{
    count: number
  }>`SELECT count(*)::integer AS count FROM agent_runs WHERE employee_id=${employeeId}::uuid AND state IN ('starting','running')`
  const statuses = yield* sql<{
    status: 'unknown' | 'waiting_device' | 'running' | 'idle' | 'stopped' | 'archived'
    count: number
  }>`SELECT status,count(*)::integer AS count FROM threads WHERE employee_id=${employeeId}::uuid GROUP BY status ORDER BY status`
  const jobs = yield* sql<{
    state: 'pending' | 'claimed' | 'running' | 'completed' | 'cancelled'
    waiting_reason: string
    backoff: boolean
    count: number
    oldest_seconds: number
  }>`SELECT state,waiting_reason,(next_attempt_at>clock_timestamp()) AS backoff,count(*)::integer AS count,GREATEST(0,extract(epoch FROM clock_timestamp()-min(updated_at)))::float8 AS oldest_seconds FROM project_memory_jobs WHERE employee_id=${employeeId}::uuid GROUP BY state,waiting_reason,(next_attempt_at>clock_timestamp()) ORDER BY state,waiting_reason`
  return {
    ...gateway,
    online_devices: online?.count ?? 0,
    outbox,
    active_runs: active?.count ?? 0,
    thread_statuses: statuses,
    memory_jobs: jobs.map((job) => ({
      ...job,
      waiting_reason: job.waiting_reason || null,
    })),
  }
})
