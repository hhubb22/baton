import { Clock, Effect, Metric } from 'effect'
import { waitEvent } from '@baton/telemetry'
import * as SqlClient from 'effect/sql/SqlClient'
import { projectStatus } from './project/view.ts'
import { recoveryWorkSQL } from './project/store.ts'

const actions = ['open', 'message', 'withdraw', 'stop', 'resume', 'settings', 'answer', 'check_activity'] as const
const threadStates = ['waiting_device', 'running', 'idle', 'stopped', 'unknown', 'archived'] as const
const jobStates = ['pending', 'claimed', 'running', 'completed', 'cancelled'] as const
const reasons = ['device_offline', 'approval', 'credential_missing', 'queue', 'lease', 'backoff'] as const
const online = Metric.gauge('baton.nodes.online')
const pending = Metric.gauge('baton.outbox.pending')
const threads = Metric.gauge('baton.threads')
const runs = Metric.gauge('baton.project.runs.active')
const memory = Metric.gauge('baton.memory.jobs')
const oldestOutbox = Metric.gauge('baton.outbox.oldest_age_s')
const oldestWait = Metric.gauge('baton.wait.oldest_age_s')

const memoryReason = (reason: string, backoff: boolean): (typeof reasons)[number] | undefined => {
  if (backoff) return 'backoff'
  if (['device_unavailable', 'node_idle_expired'].includes(reason)) return 'device_offline'
  if (reason === 'login_required') return 'credential_missing'
  if (['device_busy', 'foreground_priority', ''].includes(reason)) return 'queue'
  return undefined
}

const projectReason = (reason: string | undefined): (typeof reasons)[number] | undefined => {
  if (reason === 'all_devices_offline') return 'device_offline'
  if (reason === 'login_required') return 'credential_missing'
  if (reason === 'retry_backoff') return 'backoff'
  if (reason === 'capacity' || reason === 'scheduling') return 'queue'
  return undefined
}

export const makeProjectWaitObserver = () => {
  const previous = new Map<string, { reason: (typeof reasons)[number]; started: number; trace: unknown }>()
  const seen = new Set<string>()
  let cursor = ''
  const poll = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const clock = yield* Clock.Clock
    const now = clock.currentTimeMillisUnsafe()
    const rows = yield* sql<{
      id: string
      employee_id: string
      trace: unknown
      queue_ms: number | null
      failure_ms: number | null
    }>`SELECT p.id,p.employee_id,(SELECT q.trace_context FROM project_agent_input_queue q WHERE q.agent_id=a.id AND q.delivered_seq IS NULL AND q.trace_context IS NOT NULL ORDER BY q.id LIMIT 1) AS trace,(SELECT extract(epoch FROM min(q.created_at))*1000 FROM project_agent_input_queue q WHERE q.agent_id=a.id AND q.delivered_seq IS NULL) AS queue_ms,(SELECT extract(epoch FROM max(r.ended_at))*1000 FROM agent_runs r WHERE r.agent_id=a.id AND r.state='failed') AS failure_ms FROM projects p JOIN project_agents a ON a.project_id=p.id JOIN conversations c ON c.agent_id=a.id WHERE p.status='active' AND ((c.next_attempt_at>clock_timestamp()) OR ${recoveryWorkSQL(sql)}) AND (${cursor || null}::uuid IS NULL OR p.id>${cursor || null}::uuid) ORDER BY p.id LIMIT 32`
    for (const row of rows) {
      const status = yield* projectStatus(row.employee_id, row.id, -1)
      const reason = status.state === 'waiting' ? projectReason(status.waiting_reason) : undefined
      const old = previous.get(row.id)
      seen.add(row.id)
      cursor = row.id
      if (old?.reason === reason) continue
      const attrs = { 'baton.project.id': row.id }
      if (old) yield* waitEvent('end', old.reason, attrs, old.trace, now - old.started)
      if (reason) {
        yield* waitEvent('start', reason, attrs, row.trace)
        const knownStart = reason === 'queue' ? row.queue_ms : reason === 'backoff' ? row.failure_ms : null
        previous.set(row.id, { reason, started: knownStart === null ? now : Number(knownStart), trace: row.trace })
      } else previous.delete(row.id)
    }
    if (rows.length < 32) {
      for (const [id, old] of previous) {
        if (seen.has(id)) continue
        yield* waitEvent('end', old.reason, { 'baton.project.id': id }, old.trace, now - old.started)
        previous.delete(id)
      }
      cursor = ''
      seen.clear()
    }
  }).pipe(Effect.timeout('3 seconds'), Effect.ignore)
  return {
    poll,
    oldest: (reason: (typeof reasons)[number], now: number) =>
      [...previous.values()].reduce(
        (oldest, value) => (value.reason === reason ? Math.max(oldest, (now - value.started) / 1000) : oldest),
        0,
      ),
  }
}

export const makeMemoryWaitObserver = () => {
  const previous = new Map<
    string,
    { reason: (typeof reasons)[number]; started: number; project: string; trace: unknown }
  >()
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{
      id: string
      project_id: string
      waiting_reason: string
      backoff: boolean
      started_ms: number
      trace: unknown
    }>`SELECT j.id,j.project_id,j.waiting_reason,j.next_attempt_at>clock_timestamp() AS backoff,extract(epoch FROM j.updated_at)*1000 AS started_ms,(SELECT r.trace_context FROM agent_runs r WHERE r.memory_job_id=j.id AND r.trace_context IS NOT NULL ORDER BY r.lease_epoch DESC LIMIT 1) AS trace FROM project_memory_jobs j WHERE j.state='pending'`
    const next = new Map<
      string,
      { reason: (typeof reasons)[number]; started: number; project: string; trace: unknown }
    >()
    const clock = yield* Clock.Clock
    const now = clock.currentTimeMillisUnsafe()
    for (const row of rows) {
      const reason = memoryReason(row.waiting_reason, row.backoff)
      if (!reason) continue
      const old = previous.get(row.id)
      const item = { reason, started: Number(row.started_ms), project: row.project_id, trace: row.trace }
      next.set(row.id, old?.reason === reason ? old : item)
      if (old?.reason === reason) continue
      const attrs = { 'baton.project.id': row.project_id, 'baton.memory.job.id': row.id }
      if (old) yield* waitEvent('end', old.reason, attrs, old.trace, now - old.started)
      yield* waitEvent('start', reason, attrs, row.trace)
    }
    for (const [id, old] of previous) {
      if (next.has(id)) continue
      yield* waitEvent(
        'end',
        old.reason,
        { 'baton.project.id': old.project, 'baton.memory.job.id': id },
        old.trace,
        now - old.started,
      )
    }
    previous.clear()
    for (const [id, value] of next) previous.set(id, value)
  }).pipe(Effect.timeout('3 seconds'), Effect.ignore)
}

/** Collect a complete snapshot before updating gauges, so failed queries leave the previous snapshot intact. */
export const collectServerMetrics = Effect.fnUntraced(function* (
  projects?: ReturnType<typeof makeProjectWaitObserver>,
) {
  const sql = yield* SqlClient.SqlClient
  const clock = yield* Clock.Clock
  const [node] = yield* sql<{ count: number }>`SELECT count(*)::float8 AS count FROM node_presence WHERE online`
  const outbox = yield* sql<{
    action: string
    count: number
    age: number
  }>`SELECT action,count(*)::float8 AS count,GREATEST(0,extract(epoch FROM clock_timestamp()-min(created_at)))::float8 AS age FROM thread_outbox WHERE acked_at IS NULL AND completed_at IS NULL GROUP BY action`
  const states = yield* sql<{
    status: string
    count: number
  }>`SELECT status,count(*)::float8 AS count FROM threads GROUP BY status`
  const [active] = yield* sql<{
    count: number
  }>`SELECT count(*)::float8 AS count FROM agent_runs WHERE state IN ('starting','running')`
  const jobs = yield* sql<{
    state: string
    waiting_reason: string
    backoff: boolean
    count: number
    age: number
  }>`SELECT state,waiting_reason,(next_attempt_at>clock_timestamp()) AS backoff,count(*)::float8 AS count,GREATEST(0,extract(epoch FROM clock_timestamp()-min(updated_at)))::float8 AS age FROM project_memory_jobs GROUP BY state,waiting_reason,(next_attempt_at>clock_timestamp())`
  const [offline] = yield* sql<{
    age: number
  }>`SELECT COALESCE(GREATEST(0,extract(epoch FROM clock_timestamp()-min(GREATEST(o.created_at,COALESCE(p.status_updated_at,o.created_at))))),0)::float8 AS age FROM thread_outbox o LEFT JOIN node_presence p ON p.node_id=o.node_id WHERE o.acked_at IS NULL AND o.completed_at IS NULL AND NOT COALESCE(p.online AND p.synced,false)`
  const [approval] = yield* sql<{
    age: number
  }>`SELECT COALESCE(GREATEST(0,extract(epoch FROM clock_timestamp()-min(e.created_at))),0)::float8 AS age FROM thread_events e JOIN threads t ON t.id=e.thread_id JOIN thread_turns v ON v.thread_id=e.thread_id AND v.worker_turn_seq=(e.payload->>'worker_turn_seq')::bigint AND v.ended_at IS NULL WHERE e.kind='question.pending' AND t.status='running' AND t.stop_requested_at IS NULL AND t.archive_requested_at IS NULL AND NOT EXISTS(SELECT 1 FROM thread_events done WHERE done.thread_id=e.thread_id AND done.id>e.id AND done.kind IN ('question.resolved','question.answered') AND done.payload->>'request_id'=e.payload->'question'->>'request_id' AND (done.payload->>'worker_turn_seq' IS NULL OR done.payload->>'worker_turn_seq'=e.payload->>'worker_turn_seq'))`
  const projectAges = Object.fromEntries(
    reasons.map((reason) => [reason, projects?.oldest(reason, clock.currentTimeMillisUnsafe()) ?? 0]),
  )
  const queueAge = outbox.reduce((oldest, row) => Math.max(oldest, row.age), 0)
  yield* Metric.update(online, node?.count ?? 0)
  yield* Metric.update(runs, active?.count ?? 0)
  for (const action of actions) {
    const row = outbox.find((entry) => entry.action === action)
    yield* Metric.update(Metric.withAttributes(pending, { 'baton.command.action': action }), row?.count ?? 0)
    yield* Metric.update(Metric.withAttributes(oldestOutbox, { 'baton.command.action': action }), row?.age ?? 0)
  }
  for (const status of threadStates)
    yield* Metric.update(
      Metric.withAttributes(threads, { 'baton.turn.result': status }),
      states.find((row) => row.status === status)?.count ?? 0,
    )
  for (const state of jobStates) {
    for (const reason of reasons) {
      const value = jobs
        .filter(
          (job) =>
            job.state === state && job.state === 'pending' && memoryReason(job.waiting_reason, job.backoff) === reason,
        )
        .reduce((sum, job) => sum + job.count, 0)
      yield* Metric.update(
        Metric.withAttributes(memory, { 'baton.memory.job.state': state, 'baton.wait.reason': reason }),
        value,
      )
    }
    const value = jobs
      .filter(
        (job) => job.state === state && (job.state !== 'pending' || !memoryReason(job.waiting_reason, job.backoff)),
      )
      .reduce((sum, job) => sum + job.count, 0)
    yield* Metric.update(Metric.withAttributes(memory, { 'baton.memory.job.state': state }), value)
  }
  for (const reason of reasons) {
    const memoryAge = jobs.reduce(
      (oldest, job) =>
        job.state === 'pending' && memoryReason(job.waiting_reason, job.backoff) === reason
          ? Math.max(oldest, job.age)
          : oldest,
      0,
    )
    const otherAge =
      reason === 'device_offline'
        ? (offline?.age ?? 0)
        : reason === 'approval'
          ? (approval?.age ?? 0)
          : reason === 'queue'
            ? queueAge
            : 0
    yield* Metric.update(
      Metric.withAttributes(oldestWait, { 'baton.wait.reason': reason }),
      Math.max(memoryAge, otherAge, projectAges[reason]!),
    )
  }
})

export const serverMetricsLoop = (projects: ReturnType<typeof makeProjectWaitObserver>) =>
  collectServerMetrics(projects).pipe(
    Effect.timeout('3 seconds'),
    Effect.ignore,
    Effect.andThen(Effect.sleep('30 seconds')),
    Effect.forever,
  )
