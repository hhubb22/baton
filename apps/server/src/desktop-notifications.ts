import { randomUUID } from 'node:crypto'
import { Effect, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as P from '@baton/protocol'
import { transaction } from './database.ts'
import { AppError } from './errors.ts'
import { latestReplySeqSQL } from './project/attention.ts'

type NotificationInput = Omit<P.BrowserNotification, 'type' | 'event_id' | 'cursor'>
const boundedTitle = (title: string) => Array.from(title).slice(0, 1000).join('')
export function notificationCause(reason: string): string {
  switch (reason) {
    case 'timeout':
      return 'The reply timed out.'
    case 'agent_exited':
      return 'The Agent process exited.'
    case 'stopped':
      return 'The Agent process stopped.'
    case 'failed':
      return ''
    case 'history_lost':
    case 'history_missing':
    case 'history_unavailable':
      return 'The Agent conversation history is missing.'
    case 'folder_missing':
    case 'working_directory_missing':
      return 'The working directory is missing.'
    case 'invalid_working_directory':
      return 'The working directory is unavailable.'
    case 'working_directory_forbidden':
    case 'directory_not_allowed':
      return 'The working directory is not authorized.'
    case 'agent_unavailable':
      return 'The selected agent is unavailable.'
    case 'interrupted':
      return 'The reply was interrupted.'
    case 'start_failed':
      return 'The Agent could not start.'
    case 'lease_expired':
      return 'The project assistant connection expired.'
    case 'node_idle_expired':
      return 'The device credential expired after inactivity.'
    case 'node_revoked':
      return 'The device credential was revoked.'
    default:
      return reason
  }
}

// Business transactions persist intent without taking delivery locks.
export const saveNotification = Effect.fn('saveBrowserNotification')(function* (
  employeeId: string,
  sourceKey: string,
  input: NotificationInput,
) {
  return yield* transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const event = {
        ...input,
        title: boundedTitle(input.title),
        body: boundedTitle(input.body),
        type: 'notification' as const,
        event_id: randomUUID(),
      }
      const [inserted] = yield* sql<{
        event_id: string
      }>`INSERT INTO browser_notifications(employee_id,event_id,source_key,event)
        VALUES(${employeeId},${event.event_id},${sourceKey},${JSON.stringify(event)}::jsonb)
        ON CONFLICT (employee_id,source_key) DO NOTHING RETURNING event_id`
      if (inserted) return inserted.event_id
      const [old] = yield* sql<{ event_id: string }>`SELECT event_id FROM browser_notifications
        WHERE employee_id=${employeeId} AND source_key=${sourceKey}`
      return old!.event_id
    }),
  )
})

// Only delivery transactions allocate cursors; they never acquire Node or Project locks.
const sequenceNotifications = Effect.fnUntraced(function* (employeeId: string, limit?: number) {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO browser_notification_cursors(employee_id) VALUES(${employeeId}) ON CONFLICT DO NOTHING`
  const [counter] = yield* sql<{ last_seq: string }>`SELECT last_seq::text FROM browser_notification_cursors
    WHERE employee_id=${employeeId} FOR UPDATE`
  const [assigned] = yield* sql<{ last_seq: string | null; count: number }>`WITH pending AS (
    SELECT event_id,row_number() OVER (ORDER BY created_at,event_id) AS ordinal FROM browser_notifications
    WHERE employee_id=${employeeId} AND seq IS NULL ORDER BY created_at,event_id LIMIT ${limit ?? null}::integer
  ), sequenced AS (
    UPDATE browser_notifications n SET seq=${counter!.last_seq}::bigint+p.ordinal,
      event=n.event || jsonb_build_object('cursor',(${counter!.last_seq}::bigint+p.ordinal)::text)
    FROM pending p WHERE n.event_id=p.event_id RETURNING n.seq
  ) SELECT max(seq)::text AS last_seq,count(*)::integer AS count FROM sequenced`
  const cursor = assigned!.last_seq ?? counter!.last_seq
  if (assigned!.count)
    yield* sql`UPDATE browser_notification_cursors SET last_seq=${cursor}::bigint WHERE employee_id=${employeeId}`
  return { cursor, count: assigned!.count }
})

export const replayNotifications = Effect.fn('replayBrowserNotifications')(function* (
  employeeId: string,
  after?: string,
  limit = 100,
) {
  return yield* transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      // Sequence all already committed intent before establishing a first-run baseline.
      const { cursor: highwater } = yield* sequenceNotifications(employeeId)
      if (after === undefined) return { events: [], cursor: highwater, has_more: false } satisfies P.NotificationReplay
      if (BigInt(after) > BigInt(highwater)) return yield* Effect.fail(new AppError(400, 'invalid_cursor'))
      const rows = yield* sql<{ event: P.BrowserNotification }>`SELECT event FROM browser_notifications
      WHERE employee_id=${employeeId} AND seq>${after}::bigint AND seq<=${highwater}::bigint ORDER BY seq LIMIT ${limit + 1}`
      const events = rows.slice(0, limit).map((row) => row.event)
      const has_more = rows.length > limit
      return { events, cursor: has_more ? events.at(-1)!.cursor : highwater, has_more } satisfies P.NotificationReplay
    }),
  )
})

export const claimNotificationBroadcasts = Effect.fn('claimBrowserNotificationBroadcasts')(function* () {
  return yield* transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const employees = yield* sql<{ employee_id: string }>`SELECT DISTINCT employee_id FROM browser_notifications
        WHERE seq IS NULL ORDER BY employee_id LIMIT 100`
      let remaining = 100
      for (const employee of employees) {
        const assigned = yield* sequenceNotifications(employee.employee_id, remaining)
        remaining -= assigned.count
        if (remaining === 0) break
      }
      return yield* sql<{ employee_id: string; event: P.BrowserNotification }>`WITH pending AS (
      SELECT employee_id,seq FROM browser_notifications WHERE published_at IS NULL AND seq IS NOT NULL
      ORDER BY employee_id,seq LIMIT 100 FOR UPDATE SKIP LOCKED
    ) UPDATE browser_notifications n SET published_at=clock_timestamp() FROM pending p
      WHERE n.employee_id=p.employee_id AND n.seq=p.seq RETURNING n.employee_id,n.event`
    }),
  )
})

export const threadTitle = Effect.fnUntraced(function* (threadId: string) {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{ title: string }>`SELECT COALESCE((SELECT left(split_part(content,chr(10),1),120)
    FROM thread_messages WHERE thread_id=t.id ORDER BY created_at,id LIMIT 1),t.working_directory) AS title
    FROM threads t WHERE t.id=${threadId}`
  return boundedTitle(row?.title ?? 'Thread')
})

const StatusChange = Schema.Struct({
  status: Schema.String,
  reason: Schema.String,
  stop_code: Schema.optionalKey(P.ThreadStopCode),
})
export const recordThreadNotification = Effect.fnUntraced(function* (
  t: P.Thread,
  sourceKey: string,
  kind: string,
  payload: unknown,
) {
  let notificationKind: P.BrowserNotification['kind'] | undefined
  if (kind === 'question.pending' && Schema.is(P.ThreadReport)(payload))
    notificationKind = payload.question?.kind === 'user_input' ? 'question' : 'approval'
  else if (kind === 'turn.ended' && Schema.is(P.ThreadReport)(payload) && !payload.history_unavailable) {
    notificationKind =
      payload.reason === 'completed'
        ? 'turn_ended'
        : payload.reason === 'failed'
          ? 'turn_failed'
          : payload.reason !== 'stopped' || !t.stop_requested_at
            ? 'turn_stopped'
            : undefined
  } else if (
    kind === 'status.changed' &&
    Schema.is(StatusChange)(payload) &&
    ['stopped', 'unknown'].includes(payload.status) &&
    (payload.reason || ['history_lost', 'folder_missing', 'start_failed'].includes(payload.stop_code ?? '')) &&
    payload.stop_code !== 'user_stopped' &&
    payload.stop_code !== 'forced_stop'
  ) {
    if (payload.status === 'stopped') {
      if (payload.reason === 'completed') return
      const sql = yield* SqlClient.SqlClient
      const [ended] = yield* sql<{ end_reason: string }>`SELECT end_reason FROM thread_turns
        WHERE employee_id=${t.employee_id} AND thread_id=${t.id} AND ended_at IS NOT NULL
        ORDER BY worker_turn_seq DESC LIMIT 1`
      if (ended?.end_reason === payload.reason) return
    }
    notificationKind = payload.stop_code === 'start_failed' ? 'turn_failed' : 'turn_stopped'
  }
  if (!notificationKind) return
  const agent = {
    cursor: 'Cursor',
    pi: 'Pi',
    codex: 'Codex',
    kiro: 'Kiro',
    shell: 'Shell',
    grok: 'Grok',
    antigravity: 'Antigravity',
  }[t.agent_type]
  const report = Schema.is(P.ThreadReport)(payload) ? payload : undefined
  const question = report?.question
  const detail = question?.questions.map((item) => item.question).join(' ') || question?.prompt
  const cause =
    report?.content ||
    notificationCause(
      report?.reason || (Schema.is(StatusChange)(payload) ? payload.reason || payload.stop_code || '' : ''),
    )
  const body =
    notificationKind === 'question' || notificationKind === 'approval'
      ? `${agent} ${notificationKind === 'approval' ? 'needs confirmation' : 'has a question'}${detail ? `: ${detail}` : '.'}`
      : notificationKind === 'turn_ended'
        ? `${agent} finished replying.`
        : `${agent} ${notificationKind === 'turn_failed' ? 'could not finish replying' : 'stopped unexpectedly'}${cause ? `: ${cause}` : '.'}`
  yield* saveNotification(t.employee_id, sourceKey, {
    kind: notificationKind,
    thread_id: t.id,
    node_id: t.node_id,
    ...(t.project_id ? { project_id: t.project_id } : {}),
    title: yield* threadTitle(t.id),
    body,
  })
})

export const saveProjectNotification = Effect.fnUntraced(function* (
  employeeId: string,
  projectId: string,
  sourceKey: string,
  kind: P.BrowserNotification['kind'],
  body: string,
  threadId?: string,
) {
  const sql = yield* SqlClient.SqlClient
  const [project] = yield* sql<{ title: string }>`SELECT title FROM projects
    WHERE id=${projectId} AND employee_id=${employeeId}`
  if (!project) return
  yield* saveNotification(employeeId, sourceKey, {
    kind,
    project_id: projectId,
    ...(threadId ? { thread_id: threadId } : {}),
    title: threadId ? yield* threadTitle(threadId) : project.title,
    body,
  })
})

export const recordDeviceRejection = Effect.fnUntraced(function* (
  employeeId: string,
  nodeId: string,
  sourceKey: string,
  body: string,
) {
  const sql = yield* SqlClient.SqlClient
  const [node] = yield* sql<{ title: string }>`SELECT display_name AS title FROM nodes
    WHERE id=${nodeId} AND employee_id=${employeeId}`
  if (node)
    yield* saveNotification(employeeId, sourceKey, {
      kind: 'device_rejected',
      node_id: nodeId,
      title: node.title,
      body,
    })
})

export const activitySnapshot = Effect.fn('browserActivitySnapshot')(function* (employeeId: string) {
  const sql = yield* SqlClient.SqlClient
  const [snapshot] = yield* sql<{ value: P.ActivitySnapshot }>`WITH waiting AS (
    SELECT t.id,t.project_id,t.last_activity_at,COALESCE((SELECT left(split_part(m.content,chr(10),1),120)
      FROM thread_messages m WHERE m.thread_id=t.id ORDER BY m.created_at,m.id LIMIT 1),left(t.working_directory,1000)) AS title
    FROM threads t WHERE t.employee_id=${employeeId} AND t.agent_type<>'shell' AND t.status<>'archived' AND
      t.status='running' AND t.stop_requested_at IS NULL AND t.archive_requested_at IS NULL AND EXISTS(
        SELECT 1 FROM thread_events e JOIN thread_turns v ON v.thread_id=e.thread_id
          AND v.worker_turn_seq=(e.payload->>'worker_turn_seq')::bigint AND v.ended_at IS NULL
        WHERE e.thread_id=t.id AND e.kind='question.pending'
          AND NOT EXISTS(SELECT 1 FROM thread_events done WHERE done.thread_id=t.id
            AND done.kind IN ('question.resolved','question.answered')
            AND done.payload->>'request_id'=e.payload->'question'->>'request_id'))
  ) SELECT jsonb_build_object(
    'running_count',(SELECT count(*) FROM threads WHERE employee_id=${employeeId} AND agent_type<>'shell' AND status='running'),
    'waiting_count',(SELECT count(*) FROM waiting)+(SELECT count(*) FROM projects p
      JOIN project_agents a ON a.project_id=p.id AND a.employee_id=p.employee_id
      JOIN conversations c ON c.agent_id=a.id AND c.employee_id=a.employee_id
      WHERE p.employee_id=${employeeId} AND p.status<>'archived' AND ${latestReplySeqSQL(sql)}>c.read_reply_seq),
    'waiting_threads',COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'thread_id',id,'project_id',project_id,'title',title))) FROM (
        SELECT * FROM waiting ORDER BY last_activity_at DESC,id LIMIT 5) w),'[]'::jsonb)) AS value`
  return snapshot!.value
})
