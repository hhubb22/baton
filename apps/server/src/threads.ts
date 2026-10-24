import { Effect, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as P from '@baton/protocol'
import { AppError } from './errors.ts'
import {
  admission,
  audit,
  decode,
  digest,
  enqueue,
  failure,
  insertMessage,
  normalizeMessage,
  readThread,
  touch,
  transaction,
  uuid,
  type DB,
} from './threads-core.ts'
export { claimCommands, processReceipt } from './threads-outbox.ts'
export { processReport } from './threads-reports.ts'

export const create = (
  employeeID: string,
  input: P.CreateBrowserThreadInput,
): DB<{ thread: P.Thread; created: boolean }> =>
  transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const valid = yield* decode(P.CreateBrowserThreadInput, input)
      const message = yield* normalizeMessage(valid.message)
      const normalized = {
        client_thread_id: valid.client_thread_id,
        node_id: valid.node_id || '',
        agent_type: valid.agent_type,
        model: valid.model || '',
        working_directory: valid.working_directory,
        message,
      }
      const hash = digest(normalized)
      yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${employeeID + ':' + valid.client_thread_id},0))`
      const old = yield* sql<{
        id: string
        request_hash: Uint8Array
      }>`SELECT id,request_hash FROM threads WHERE employee_id=${employeeID} AND client_thread_id=${valid.client_thread_id}`
      if (old.length) {
        if (!Buffer.from(old[0]!.request_hash).equals(hash)) return yield* Effect.fail(failure())
        return { thread: yield* readThread(employeeID, old[0]!.id), created: false }
      }
      let node = valid.node_id
      if (!node) {
        yield* sql`INSERT INTO employee_settings(employee_id,updated_at) VALUES(${employeeID},clock_timestamp()) ON CONFLICT DO NOTHING`
        const settings = yield* sql<{
          default_device_node_id: string | null
        }>`SELECT default_device_node_id FROM employee_settings WHERE employee_id=${employeeID} FOR UPDATE`
        node = settings[0]!.default_device_node_id ?? undefined
        if (!node) {
          const candidates = yield* sql<{
            id: string
          }>`SELECT id FROM nodes WHERE employee_id=${employeeID} AND revoked_at IS NULL ORDER BY registration_seq LIMIT 1`
          node = candidates[0]?.id
          if (!node) return yield* Effect.fail(failure('default_device_required', 422))
          yield* sql`UPDATE employee_settings SET default_device_node_id=${node},updated_at=clock_timestamp() WHERE employee_id=${employeeID}`
        }
      }
      if (valid.agent_type === 'shell') return yield* Effect.fail(failure('agent_unavailable', 422))
      const model = yield* admission(
        employeeID,
        node,
        valid.agent_type,
        valid.working_directory,
        valid.model || '',
        'create',
      )
      const id = uuid()
      yield* sql`INSERT INTO threads(id,employee_id,client_thread_id,request_hash,node_id,agent_type,model,working_directory,created_by) VALUES(${id},${employeeID},${valid.client_thread_id},${hash},${node},${valid.agent_type},${model},${valid.working_directory},'employee')`
      const thread = yield* readThread(employeeID, id)
      yield* audit(thread, 'thread.created', { node_id: node })
      yield* enqueue(thread, 'open', { model })
      yield* insertMessage(thread, message)
      return { thread: yield* readThread(employeeID, id), created: true }
    }),
  )

export const addMessage = (employeeID: string, threadID: string, input: P.ThreadMessageInput): DB<P.ThreadMessage> =>
  transaction(
    Effect.gen(function* () {
      const valid = yield* decode(P.ThreadMessageInput, input)
      const t = yield* readThread(employeeID, threadID, true)
      return yield* insertMessage(t, valid)
    }),
  )

const action = (
  employeeID: string,
  threadID: string,
  kind: 'withdraw' | 'stop' | 'archive',
  messageID = '',
): DB<P.Thread> =>
  transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const t = yield* readThread(employeeID, threadID, true)
      if (t.status === 'archived') {
        if (kind === 'archive') return t
        return yield* Effect.fail(failure('thread_archived'))
      }
      if (kind === 'withdraw') {
        const rows = yield* sql<{
          client_message_id: string
          status: string
        }>`SELECT client_message_id,status FROM thread_messages WHERE employee_id=${employeeID} AND thread_id=${threadID} AND (id::text=${messageID} OR client_message_id=${messageID})`
        const m = rows[0]
        if (!m) return yield* Effect.fail(failure('not_found', 404))
        if (m.status === 'withdrawn') return t
        if (!['accepted', 'queued'].includes(m.status)) return yield* Effect.fail(failure('message_already_sent'))
        const pending =
          yield* sql`SELECT id FROM thread_outbox WHERE thread_id=${threadID} AND action='withdraw' AND payload->>'client_message_id'=${m.client_message_id} AND completed_at IS NULL`
        if (!pending.length) yield* enqueue(t, 'withdraw', { client_message_id: m.client_message_id })
      } else {
        const rows = yield* sql<{
          active: boolean
        }>`SELECT EXISTS(SELECT 1 FROM thread_turns WHERE thread_id=${threadID} AND ended_at IS NULL) OR EXISTS(SELECT 1 FROM thread_messages WHERE thread_id=${threadID} AND status IN ('accepted','queued','unknown')) AS active`
        if (
          kind === 'archive' &&
          !rows[0]!.active &&
          ['idle', 'stopped'].includes(t.status) &&
          (!t.stop_requested_at || t.stop_confirmed_at)
        ) {
          yield* sql`UPDATE threads SET status='archived',archive_requested_at=COALESCE(archive_requested_at,clock_timestamp()),archived_at=clock_timestamp() WHERE id=${threadID}`
          yield* audit(t, 'thread.archived', {})
        } else {
          if (kind === 'archive')
            yield* sql`UPDATE threads SET archive_requested_at=COALESCE(archive_requested_at,clock_timestamp()) WHERE id=${threadID}`
          if (!t.stop_requested_at || t.stop_confirmed_at) {
            yield* sql`UPDATE threads SET stop_requested_at=clock_timestamp(),stop_confirmed_at=NULL WHERE id=${threadID}`
            yield* enqueue(t, 'stop')
          }
        }
      }
      yield* audit(t, kind + '.requested', kind === 'withdraw' ? { message_id: messageID } : {})
      yield* touch(threadID)
      return yield* readThread(employeeID, threadID)
    }),
  )
export const withdraw = (employeeID: string, threadID: string, messageID: string) =>
  action(employeeID, threadID, 'withdraw', messageID)
export const stop = (employeeID: string, threadID: string) => action(employeeID, threadID, 'stop')
export const archive = (employeeID: string, threadID: string) => action(employeeID, threadID, 'archive')
export const resume = (employeeID: string, threadID: string): DB<P.Thread> =>
  transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const t = yield* readThread(employeeID, threadID, true)
      if (t.status === 'archived' || t.archive_requested_at) return yield* Effect.fail(failure('thread_archived'))
      const pending =
        yield* sql`SELECT id FROM thread_outbox WHERE employee_id=${employeeID} AND thread_id=${threadID} AND action='resume' AND completed_at IS NULL`
      if (pending.length) return t
      if (!t.opened_at || !t.storage_generation) return yield* Effect.fail(failure('thread_not_opened', 422))
      if (!['idle', 'stopped', 'unknown'].includes(t.status)) return yield* Effect.fail(failure())
      if (t.stop_requested_at && !t.stop_confirmed_at) return yield* Effect.fail(failure('stop_pending'))
      yield* admission(employeeID, t.node_id, t.agent_type, t.working_directory, '', 'resume')
      yield* enqueue(t, 'resume')
      yield* audit(t, 'resume.requested', {})
      yield* touch(threadID)
      return yield* readThread(employeeID, threadID)
    }),
  )

export const setModel = (employeeID: string, threadID: string, input: P.SetThreadModelInput): DB<P.Thread> =>
  transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const valid = yield* decode(P.SetThreadModelInput, input)
      const t = yield* readThread(employeeID, threadID, true)
      if (t.status === 'archived' || t.archive_requested_at) return yield* Effect.fail(failure('thread_archived'))
      const rows = yield* sql<{
        supported: boolean
      }>`SELECT COALESCE((SELECT (a->'capabilities'->>'switch_model')::boolean FROM node_runtime_reports r CROSS JOIN LATERAL jsonb_array_elements(r.report->'agents') a WHERE r.node_id=${t.node_id} AND r.employee_id=${employeeID} AND a->>'agent_type'=${t.agent_type}),false) AS supported`
      if (!rows[0]!.supported) return yield* Effect.fail(failure('model_switch_unsupported', 422))
      if (valid.model) yield* admission(employeeID, t.node_id, t.agent_type, t.working_directory, valid.model, 'queue')
      yield* sql`UPDATE threads SET next_model=${valid.model} WHERE id=${t.id}`
      yield* audit(t, 'model.updated', { model: valid.model })
      yield* touch(t.id)
      return yield* readThread(employeeID, threadID)
    }),
  )

export const view = (employeeID: string, threadID: string): DB<P.ThreadView> =>
  transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      // Thread 锁让状态、消息及 pending 来自同一个持久版本。
      const t = yield* readThread(employeeID, threadID, true)
      const turns = yield* sql<{
        value: P.ThreadTurn
      }>`SELECT jsonb_strip_nulls(to_jsonb(v)-'employee_id') AS value FROM thread_turns v WHERE employee_id=${employeeID} AND thread_id=${threadID} AND ended_at IS NULL`
      const messages = yield* sql<{
        value: P.ThreadMessage
      }>`SELECT jsonb_strip_nulls(to_jsonb(m)-'employee_id') AS value FROM thread_messages m WHERE employee_id=${employeeID} AND thread_id=${threadID} AND (status IN ('accepted','queued','unknown') OR (status='withdrawn' AND status_reason<>'')) ORDER BY created_at,id`
      const pending =
        yield* sql`SELECT id FROM thread_outbox WHERE employee_id=${employeeID} AND thread_id=${threadID} AND action='resume' AND completed_at IS NULL`
      return {
        ...t,
        current_turn: turns[0]?.value ?? null,
        pending_messages: messages.map((x) => x.value).filter((x) => x.status !== 'withdrawn'),
        failed_messages: messages.map((x) => x.value).filter((x) => x.status === 'withdrawn'),
        resume_pending: pending.length > 0,
      }
    }),
  )

const encodeCursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const cursor = (
  value: string | undefined,
  scope: string,
  kind: 'list' | 'timeline' = 'list',
): Effect.Effect<{ at: string; id: string } | undefined, AppError> =>
  Effect.try({
    try: () => {
      if (!value) return undefined
      const c: unknown = JSON.parse(Buffer.from(value, 'base64url').toString())
      if (
        typeof c !== 'object' ||
        !c ||
        !('scope' in c) ||
        c.scope !== scope ||
        !('at' in c) ||
        typeof c.at !== 'string' ||
        !('id' in c) ||
        typeof c.id !== 'string'
      )
        throw 0
      if (
        !Number.isFinite(Date.parse(c.at)) ||
        (kind === 'list'
          ? !Schema.is(P.UUID)(c.id)
          : !/^[1-9][0-9]{0,18}$/.test(c.id) || BigInt(c.id) > 9223372036854775807n)
      )
        throw 0
      return { at: c.at, id: c.id }
    },
    catch: () => failure('invalid_cursor', 422),
  })
export const list = (employeeID: string, query: P.ThreadListQuery = {}): DB<P.ThreadPage> =>
  transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const q = yield* decode(P.ThreadListQuery, query)
      const limit = Number(q.limit || 50)
      const scope = JSON.stringify([employeeID, q.project_id, q.node_id, q.status])
      const after = yield* cursor(q.cursor, scope)
      const rows = yield* sql<{
        value: P.ThreadSummary
      }>`SELECT jsonb_strip_nulls(to_jsonb(t)-'request_hash'-'exec_wait_until') || jsonb_build_object(
    'node_online',COALESCE(p.online,false),'node_synced',COALESCE(p.synced,false),'node_last_contact_at',p.last_contact_at,
    'title',COALESCE((SELECT left(split_part(content,chr(10),1),120) FROM thread_messages WHERE thread_id=t.id ORDER BY created_at,id LIMIT 1),t.working_directory),
    'current_turn',(SELECT jsonb_strip_nulls(to_jsonb(v)-'employee_id') FROM thread_turns v WHERE thread_id=t.id AND ended_at IS NULL),
    'stop_canceled',(SELECT count(*)::integer FROM thread_events e WHERE e.thread_id=t.id AND kind='message.withdrawn' AND id>COALESCE((SELECT max(id) FROM thread_events WHERE thread_id=t.id AND kind IN ('stop.requested','archive.requested')),9223372036854775807))) AS value
    FROM (SELECT * FROM threads WHERE employee_id=${employeeID}
    AND (${q.project_id ?? null}::uuid IS NULL OR project_id=${q.project_id ?? null}) AND (${q.node_id ?? null}::uuid IS NULL OR node_id=${q.node_id ?? null})
    AND (${q.status ?? null}::text IS NULL OR status=${q.status ?? null})
    AND (${after?.at ?? null}::timestamptz IS NULL OR (last_activity_at,id)<(${after?.at ?? null}::timestamptz,${after?.id ?? null}::uuid)) ORDER BY last_activity_at DESC,id DESC LIMIT ${limit + 1}) t
    LEFT JOIN node_presence p ON p.node_id=t.node_id AND p.employee_id=t.employee_id ORDER BY t.last_activity_at DESC,t.id DESC`
      const threads = rows.slice(0, limit).map((row) => row.value)
      const last = threads.at(-1)
      return {
        threads,
        ...(rows.length > limit && last
          ? { next_cursor: encodeCursor({ scope, at: last.last_activity_at, id: last.id }) }
          : {}),
      }
    }),
  )
export const timeline = (
  employeeID: string,
  threadID: string,
  query: P.ThreadTimelineQuery = {},
): DB<P.ThreadTimeline> =>
  transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* readThread(employeeID, threadID)
      const q = yield* decode(P.ThreadTimelineQuery, query)
      const scope = JSON.stringify([employeeID, threadID])
      const after = yield* cursor(q.cursor, scope, 'timeline')
      const limit = Number(q.limit || 20)
      const rows = yield* sql<{
        value: P.ThreadEvent
      }>`SELECT to_jsonb(e)-'employee_id'-'thread_id' AS value FROM thread_events e WHERE employee_id=${employeeID} AND thread_id=${threadID} AND (${after?.id ?? null}::bigint IS NULL OR id>${after?.id ?? null}::bigint) ORDER BY id ASC LIMIT ${limit + 1}`
      const events = rows.slice(0, limit).map((x) => x.value)
      const last = events.at(-1)
      return {
        events,
        ...(rows.length > limit && last
          ? { next_cursor: encodeCursor({ scope, at: last.created_at, id: String(last.id) }) }
          : {}),
      }
    }),
  )
