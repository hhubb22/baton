import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { dbError } from './database.ts'
import { AppError } from './errors.ts'
import { loadSigningKey } from './nodes.ts'

/** 停服恢复后撤销旧授权并保留不确定执行，调用前须完成数据库格式校验。 */
export const finalizeRestore = Effect.fn('finalizeRestore')(function* (signingKeyPath: string) {
  yield* Effect.tryPromise({ try: () => loadSigningKey(signingKeyPath, false), catch: dbError })
  const sql = yield* SqlClient.SqlClient
  const reason = '中心已恢复备份，执行结果需要核对'
  yield* sql
    .withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT pg_advisory_xact_lock(4815162342)`
        yield* sql`UPDATE login_sessions SET revoked_at=clock_timestamp() WHERE revoked_at IS NULL`
        // 保留吊销事实和原签发时间；过期凭据仍可证明原设备身份，不能授权业务。
        yield* sql`UPDATE node_credentials SET expires_at=created_at+interval '1 microsecond' WHERE revoked_at IS NULL`
        const future =
          yield* sql`SELECT id FROM node_credentials WHERE revoked_at IS NULL AND expires_at>clock_timestamp() LIMIT 1`
        if (future.length)
          return yield* Effect.fail(
            new AppError(409, 'conflict', '设备凭据签发时间晚于中心时间，请核对时钟后重试恢复后处理'),
          )
        yield* sql`UPDATE node_enrollments SET used_at=clock_timestamp() WHERE used_at IS NULL`
        yield* sql`UPDATE node_presence SET online=false,synced=false,status_updated_at=clock_timestamp() WHERE online OR synced`

        // 旧快照中的未派发也可能已在备份之后执行，所有待发操作均等待人工核对。
        yield* sql`UPDATE threads t SET status='unknown',status_reason=${reason},stop_code='interrupted',version=version+1
      WHERE t.status<>'archived' AND (t.status<>'unknown' OR t.status_reason<>${reason} OR t.stop_code IS DISTINCT FROM 'interrupted')
        AND (t.status IN ('waiting_device','running')
          OR EXISTS(SELECT 1 FROM thread_outbox o WHERE o.thread_id=t.id AND o.completed_at IS NULL)
          OR EXISTS(SELECT 1 FROM thread_turns v WHERE v.thread_id=t.id AND v.ended_at IS NULL))`
        yield* sql`UPDATE thread_messages m SET status='unknown',status_reason=${reason}
      WHERE m.status IN ('accepted','queued','sent')
        AND NOT EXISTS(SELECT 1 FROM thread_turns v WHERE v.id=m.turn_id AND v.ended_at IS NOT NULL)`
        yield* sql`UPDATE thread_outbox SET next_attempt_at='infinity' WHERE completed_at IS NULL`

        yield* sql`UPDATE projects SET status='paused',version=version+1,updated_at=clock_timestamp() WHERE status='active'`
        yield* sql`UPDATE agent_runs SET state='lost',ended_at=clock_timestamp(),end_reason=${reason},
      stop_requested_at=COALESCE(stop_requested_at,clock_timestamp()),memory_claim_until=NULL
      WHERE state IN ('starting','running')`
        yield* sql`UPDATE project_agents SET lease_run_id=NULL,lease_until=NULL WHERE lease_run_id IS NOT NULL`
        yield* sql`UPDATE project_memory_jobs SET state='pending',attempt_id=NULL,waiting_reason=${reason},updated_at=clock_timestamp()
      WHERE state IN ('claimed','running')`
        yield* sql`UPDATE conversations SET state='needs_attention',attention_reason=${reason}
      WHERE state<>'needs_attention' AND EXISTS(SELECT 1 FROM agent_runs r WHERE r.agent_id=conversations.agent_id AND r.state='lost' AND r.end_reason=${reason})`
      }),
    )
    .pipe(Effect.mapError(dbError))
})
