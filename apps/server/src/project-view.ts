import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { ProjectRunView, UUID, type ProjectStatus, type RuntimeReport } from '@baton/protocol'
import { projectDecode, projectTransaction, readProject, recoveryWorkSQL } from './project-store.ts'
import { readProjectPreview } from './project-preview.ts'

export const projectStatus = Effect.fn('projectStatus')(function* (
  employee: string,
  projectId: string,
  afterSeq?: number,
) {
  return yield* projectTransaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`
      yield* projectDecode(UUID, projectId)
      const p = yield* readProject(employee, projectId)
      const [state] = yield* sql<{
        attention_reason: string | null
        next_attempt_at: Date | null
        backoff: boolean
        pending: string
        work: boolean
      }>`SELECT c.attention_reason,c.next_attempt_at,COALESCE(c.next_attempt_at>clock_timestamp(),false) AS backoff,
 (SELECT count(*) FROM project_agent_input_queue q WHERE q.agent_id=a.id AND q.delivered_seq IS NULL) AS pending,${recoveryWorkSQL(sql)} AS work
 FROM project_agents a JOIN conversations c ON c.agent_id=a.id WHERE a.id=${p.agent.id}`
      const [lastRun] = yield* sql<{
        value: unknown
      }>`SELECT jsonb_strip_nulls(jsonb_build_object('id',r.id,'node_id',r.node_id,'node_name',n.display_name,'state',r.state,
 'effective',COALESCE(a.lease_run_id=r.id AND a.lease_until>clock_timestamp() AND pr.status='active' AND n.revoked_at IS NULL AND np.online AND np.synced,false),
 'placement_reason',r.placement_reason,'end_reason',r.end_reason,'stop_acked_at',r.stop_acked_at)) AS value
 FROM agent_runs r JOIN project_agents a ON a.id=r.agent_id JOIN projects pr ON pr.id=a.project_id JOIN nodes n ON n.id=r.node_id LEFT JOIN node_presence np ON np.node_id=n.id
 WHERE r.agent_id=${p.agent.id} ORDER BY r.started_at DESC,r.id DESC LIMIT 1`
      const run = lastRun ? yield* projectDecode(ProjectRunView, lastRun.value) : undefined
      const out: { -readonly [K in keyof ProjectStatus]: ProjectStatus[K] } = {
        state: 'idle',
        pending_inputs: Number(state!.pending),
        last_seq: p.conversation.last_seq,
        last_error: state!.attention_reason,
        next_attempt_at: state!.next_attempt_at?.toISOString() ?? null,
        ...(run ? { run } : {}),
      }
      if (p.status !== 'active') out.state = p.status
      else if (p.conversation.state === 'needs_attention') out.state = 'needs_attention'
      else if (run?.effective) {
        out.state = run.state
        if (afterSeq === undefined || afterSeq === out.last_seq)
          out.preview = (yield* readProjectPreview(run.id, out.last_seq)) ?? null
      } else if (state!.backoff) {
        out.state = 'waiting'
        out.waiting_reason = 'retry_backoff'
      } else if (!state!.work) out.state = 'idle'
      else if (!p.agent.provider || !p.agent.model) {
        out.state = 'waiting'
        out.waiting_reason = 'model_not_configured'
      } else {
        out.state = 'waiting'
        out.waiting_reason = 'all_devices_offline'
        const nodes = yield* sql<{
          online: boolean
          synced: boolean
          report: RuntimeReport | null
          count: string
        }>`SELECT COALESCE(np.online,false) AS online,COALESCE(np.synced,false) AS synced,rr.report,
 (SELECT count(*) FROM agent_runs r JOIN project_agents pa ON pa.lease_run_id=r.id WHERE r.node_id=n.id AND pa.lease_until>clock_timestamp()) AS count
 FROM nodes n LEFT JOIN node_presence np ON np.node_id=n.id LEFT JOIN node_runtime_reports rr ON rr.node_id=n.id WHERE n.employee_id=${employee} AND n.revoked_at IS NULL`
        const reasons = [
          'all_devices_offline',
          'waiting_sync',
          'runtime_missing',
          'login_required',
          'capacity',
          'scheduling',
        ]
        let rank = 0
        for (const node of nodes) {
          const candidate = !node.online
            ? 0
            : !node.synced
              ? 1
              : !node.report?.project_runtime
                ? 2
                : !node.report.project_runtime.providers?.some(
                      (v) => v.provider === p.agent.provider && v.status === 'available',
                    )
                  ? 3
                  : Number(node.count) >= 4
                    ? 4
                    : 5
          if (candidate > rank) {
            rank = candidate
            out.waiting_reason = reasons[rank]!
          }
        }
      }
      return out
    }),
  )
})
