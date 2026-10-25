import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import type { ProjectRunCommand, RuntimeReport } from '@baton/protocol'
import { dbError } from '../database.ts'
import { activeInputSQL, projectError, projectTransaction, recoveryWorkSQL, releaseProjectRun } from './store.ts'

const placementCandidate = (sql: SqlClient.SqlClient) => sql`(
 (a.lease_run_id IS NOT NULL AND (a.lease_until<=clock_timestamp() OR p.status<>'active' OR EXISTS(SELECT 1 FROM agent_runs r JOIN nodes n ON n.id=r.node_id WHERE r.id=a.lease_run_id AND n.revoked_at IS NOT NULL)))
 OR (a.lease_run_id IS NULL AND p.status='active' AND c.state='active' AND (c.next_attempt_at IS NULL OR c.next_attempt_at<=clock_timestamp()) AND ${recoveryWorkSQL(sql)}))`
export const listProjectRunCandidates = Effect.fn('listProjectRunCandidates')(function* (afterId = '', limit = 32) {
  const sql = yield* SqlClient.SqlClient
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return yield* Effect.fail(projectError('invalid', 422))
  const rows = yield* sql<{
    id: string
  }>`SELECT a.id FROM project_agents a JOIN projects p ON p.id=a.project_id JOIN conversations c ON c.agent_id=a.id
 WHERE (${afterId || null}::uuid IS NULL OR a.id>${afterId || null}::uuid) AND ${placementCandidate(sql)} ORDER BY a.id LIMIT ${limit}`.pipe(
    Effect.mapError(dbError),
  )
  return rows.map((row) => row.id)
})
export const scheduleProjectRun = Effect.fn('scheduleProjectRun')(function* (agentId: string) {
  yield* projectTransaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const locked = yield* sql`SELECT id FROM project_agents WHERE id=${agentId} FOR NO KEY UPDATE SKIP LOCKED`
      if (!locked.length) return
      const [a] = yield* sql<{
        employee_id: string
        project_id: string
        status: string
        conversation_state: string
        provider: string
        model: string
        lease_run_id: string | null
        lease_epoch: string
        valid: boolean
        ready: boolean
        work: boolean
      }>`SELECT a.employee_id,a.project_id,p.status,c.state AS conversation_state,a.provider,a.model,a.lease_run_id,a.lease_epoch,
 COALESCE(a.lease_until>clock_timestamp(),false) AS valid,c.next_attempt_at IS NULL OR c.next_attempt_at<=clock_timestamp() AS ready,${recoveryWorkSQL(sql)} AS work
 FROM project_agents a JOIN projects p ON p.id=a.project_id JOIN conversations c ON c.agent_id=a.id WHERE a.id=${agentId}`
      if (!a) return
      if (a.lease_run_id) {
        const [run] = yield* sql<{
          revoked: boolean
        }>`SELECT n.revoked_at IS NOT NULL AS revoked FROM agent_runs r JOIN nodes n ON n.id=r.node_id WHERE r.id=${a.lease_run_id}`
        if (a.valid && a.status === 'active' && !run?.revoked) return
        yield* releaseProjectRun(
          agentId,
          a.status === 'active' ? 'lost' : 'finished',
          run?.revoked ? 'node_revoked' : a.status === 'active' ? 'lease_expired' : `project_${a.status}`,
        )
      }
      if (a.status !== 'active' || a.conversation_state !== 'active' || !a.ready || !a.work || !a.provider || !a.model)
        return
      const [settings] = yield* sql<{
        default_device_node_id: string | null
      }>`SELECT default_device_node_id FROM employee_settings WHERE employee_id=${a.employee_id}`
      const preferred = settings?.default_device_node_id ?? null
      const nodes = yield* sql<{
        id: string
        online: boolean
        synced: boolean
        revoked: boolean
        report: RuntimeReport | null
      }>`SELECT n.id,COALESCE(p.online,false) AS online,COALESCE(p.synced,false) AS synced,n.revoked_at IS NOT NULL AS revoked,r.report
 FROM nodes n LEFT JOIN node_presence p ON p.node_id=n.id LEFT JOIN node_runtime_reports r ON r.node_id=n.id WHERE n.employee_id=${a.employee_id}
 ORDER BY CASE WHEN n.id=${preferred}::uuid THEN 0 ELSE 1 END,n.registration_seq`
      let reason = preferred ? 'default_unavailable' : 'default_not_set',
        chosen = ''
      for (const node of nodes) {
        let why = node.revoked
          ? 'revoked'
          : !node.online || !node.synced
            ? 'offline'
            : !node.report?.project_runtime
              ? 'runtime_missing'
              : !node.report.project_runtime.providers?.some(
                    (p) => p.provider === a.provider && p.status !== 'login_required',
                  )
                ? 'login_required'
                : ''
        if (!why) {
          const locked = yield* sql`SELECT id FROM nodes WHERE id=${node.id} FOR UPDATE`
          if (!locked.length) continue
          const [current] = yield* sql<{
            eligible: boolean
            report: RuntimeReport
            count: string
          }>`SELECT n.revoked_at IS NULL AND COALESCE(p.online AND p.synced,false) AS eligible,r.report,
 (SELECT count(*) FROM agent_runs ar WHERE ar.node_id=n.id AND ar.stop_acked_at IS NULL) AS count
 FROM nodes n LEFT JOIN node_presence p ON p.node_id=n.id LEFT JOIN node_runtime_reports r ON r.node_id=n.id WHERE n.id=${node.id}`
          why = !current?.eligible
            ? 'offline'
            : !current.report?.project_runtime
              ? 'runtime_missing'
              : !current.report.project_runtime.providers?.some(
                    (p) => p.provider === a.provider && p.status !== 'login_required',
                  )
                ? 'login_required'
                : Number(current.count) >= (current.report.project_runtime.max_concurrent_projects ?? 4)
                  ? 'capacity'
                  : ''
        }
        if (node.id === preferred) reason = why ? `default_${why}` : 'default_device'
        if (!why) {
          chosen = node.id
          break
        }
      }
      if (!chosen) return
      const runId = randomUUID(),
        epoch = Number(a.lease_epoch) + 1
      yield* sql`UPDATE project_agents SET lease_epoch=${epoch},lease_run_id=${runId},lease_until=clock_timestamp()+interval '60 seconds' WHERE id=${agentId}`
      yield* sql`INSERT INTO agent_runs(id,employee_id,agent_id,node_id,lease_epoch,state,provider,model,placement_reason) VALUES(${runId},${a.employee_id},${agentId},${chosen},${epoch},'starting',${a.provider},${a.model},${reason})`
      yield* sql`UPDATE project_agent_input_queue SET wake_required=true,wake_next_at=clock_timestamp(),wake_attempts=0 WHERE agent_id=${agentId} AND delivered_seq IS NULL AND source_type IN ${activeInputSQL(sql)}`
    }),
  )
})
interface ProjectCommandDelivery {
  employee_id: string
  node_id: string
  conn_id: string
  command: ProjectRunCommand
}
type CommandRow = {
  employee_id: string
  run_id: string
  node_id: string
  conn_id: string
  lease_epoch: string
  provider: string
  model: string
  project_id: string
  conversation_id: string
  command_attempts: number
  agent_id: string
}
const columns = (sql: SqlClient.SqlClient) =>
  sql`r.employee_id,r.id AS run_id,r.node_id,p.conn_id,r.lease_epoch,r.provider,r.model,a.project_id,c.id AS conversation_id,r.command_attempts,a.id AS agent_id`
const command = (kind: ProjectRunCommand['type'], row: CommandRow): ProjectCommandDelivery => ({
  employee_id: row.employee_id,
  node_id: row.node_id,
  conn_id: row.conn_id,
  command: {
    type: kind,
    run_id: row.run_id,
    lease_epoch: Number(row.lease_epoch),
    provider: row.provider,
    model: row.model,
    project_id: row.project_id,
    conversation_id: row.conversation_id,
  },
})
const retrySeconds = (attempts: number, random: () => number) =>
  Math.min(30, Math.pow(2, Math.min(attempts, 5)) * (0.8 + Math.max(0, Math.min(1, random())) * 0.4))
export const claimProjectCommands = Effect.fn('claimProjectCommands')(function* (
  kind: ProjectRunCommand['type'],
  random: () => number = Math.random,
) {
  if (!['project_run_start', 'project_run_stop', 'project_run_wake'].includes(kind))
    return yield* Effect.fail(projectError('invalid', 422))
  return yield* projectTransaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      if (kind === 'project_run_wake') return yield* claimWakes(random)
      const predicate =
        kind === 'project_run_start'
          ? sql`r.state='starting' AND r.stop_requested_at IS NULL AND a.lease_run_id=r.id AND a.lease_epoch=r.lease_epoch AND a.lease_until>clock_timestamp() AND pr.status='active'`
          : sql`r.stop_requested_at IS NOT NULL AND r.stop_acked_at IS NULL`
      const rows = yield* sql<CommandRow>`WITH candidates AS MATERIALIZED(
 SELECT p.node_id,p.conn_id FROM node_presence p JOIN nodes n ON n.id=p.node_id CROSS JOIN LATERAL(
 SELECT r.id,r.command_next_at FROM agent_runs r JOIN project_agents a ON a.id=r.agent_id JOIN projects pr ON pr.id=a.project_id
 WHERE r.node_id=p.node_id AND ${predicate} AND r.command_next_at<=statement_timestamp() ORDER BY r.command_next_at,r.id LIMIT 1) due
 WHERE p.online AND p.synced AND n.revoked_at IS NULL ORDER BY due.command_next_at,due.id)
 SELECT command.* FROM candidates p CROSS JOIN LATERAL(
 SELECT ${columns(sql)} FROM agent_runs r JOIN project_agents a ON a.id=r.agent_id JOIN projects pr ON pr.id=a.project_id JOIN conversations c ON c.agent_id=a.id
 WHERE r.node_id=p.node_id AND ${predicate} AND r.command_next_at<=statement_timestamp() ORDER BY r.command_next_at,r.id LIMIT 2 FOR UPDATE OF r SKIP LOCKED) command LIMIT 32`
      const out: ProjectCommandDelivery[] = []
      for (const row of rows) {
        yield* sql`UPDATE agent_runs SET command_attempts=LEAST(command_attempts::bigint+1,2147483647)::integer,command_next_at=clock_timestamp()+${retrySeconds(row.command_attempts, random)}*interval '1 second' WHERE id=${row.run_id}`
        out.push(command(kind, row))
      }
      return out
    }),
  )
})
const claimWakes = Effect.fn('claimProjectWakes')(function* (random: () => number) {
  const sql = yield* SqlClient.SqlClient
  const eligible = sql`r.state='running' AND r.stop_requested_at IS NULL AND a.lease_until>clock_timestamp() AND pr.status='active'`
  const dueInput = sql`SELECT q.id,q.wake_next_at FROM project_agent_input_queue q WHERE q.agent_id=a.id AND q.delivered_seq IS NULL AND q.wake_required AND q.wake_next_at<=statement_timestamp() ORDER BY q.wake_next_at,q.id LIMIT 1`
  const rows = yield* sql<CommandRow>`WITH candidates AS MATERIALIZED(
 SELECT p.node_id,p.conn_id FROM node_presence p JOIN nodes n ON n.id=p.node_id CROSS JOIN LATERAL(
 SELECT q.wake_next_at,q.id FROM agent_runs r JOIN project_agents a ON a.lease_run_id=r.id AND a.lease_epoch=r.lease_epoch JOIN projects pr ON pr.id=a.project_id
 CROSS JOIN LATERAL(${dueInput}) q WHERE r.node_id=p.node_id AND ${eligible} ORDER BY q.wake_next_at,q.id LIMIT 1) due
 WHERE p.online AND p.synced AND n.revoked_at IS NULL ORDER BY due.wake_next_at,due.id)
 SELECT command.* FROM candidates p CROSS JOIN LATERAL(
 SELECT ${columns(sql)} FROM agent_runs r JOIN project_agents a ON a.lease_run_id=r.id AND a.lease_epoch=r.lease_epoch JOIN projects pr ON pr.id=a.project_id JOIN conversations c ON c.agent_id=a.id
 CROSS JOIN LATERAL(${dueInput}) q WHERE r.node_id=p.node_id AND ${eligible} ORDER BY q.wake_next_at,q.id LIMIT 2 FOR NO KEY UPDATE OF a SKIP LOCKED) command LIMIT 32`
  const out: ProjectCommandDelivery[] = []
  for (const row of rows) {
    const valid =
      yield* sql`SELECT 1 FROM project_agents a JOIN agent_runs r ON r.id=a.lease_run_id JOIN projects pr ON pr.id=a.project_id WHERE a.id=${row.agent_id} AND r.id=${row.run_id} AND a.lease_epoch=${Number(row.lease_epoch)} AND ${eligible}`
    if (!valid.length) continue
    const inputs = yield* sql<{
      id: string
      payload: { thread_id?: string }
      wake_attempts: number
    }>`SELECT id,payload,wake_attempts FROM project_agent_input_queue WHERE agent_id=${row.agent_id} AND delivered_seq IS NULL AND wake_required AND wake_next_at<=statement_timestamp() ORDER BY wake_next_at,id LIMIT 32 FOR UPDATE SKIP LOCKED`
    if (!inputs.length) continue
    const ids = inputs.map((q) => Number(q.id)),
      threadIds = inputs
        .map((q) => q.payload.thread_id)
        .filter((id): id is string => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id))
    const updates = threadIds.length
      ? yield* sql<{
          thread_id: string
          version: string
        }>`SELECT id AS thread_id,version FROM threads WHERE employee_id=(SELECT employee_id FROM project_agents WHERE id=${row.agent_id}) AND project_id=${row.project_id} AND id=ANY(${threadIds}::uuid[]) ORDER BY id LIMIT 32`
      : []
    const delivery = command('project_run_wake', row)
    delivery.command = {
      ...delivery.command,
      input_ids: ids,
      thread_updates: updates.map((t) => ({ thread_id: t.thread_id, version: Number(t.version) })),
    }
    for (const input of inputs)
      yield* sql`UPDATE project_agent_input_queue SET wake_attempts=LEAST(wake_attempts::bigint+1,2147483647)::integer,wake_next_at=clock_timestamp()+${retrySeconds(input.wake_attempts, random)}*interval '1 second' WHERE id=${Number(input.id)}`
    out.push(delivery)
  }
  return out
})
