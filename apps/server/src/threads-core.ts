import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { Effect, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import type { SqlError } from 'effect/sql/SqlError'
import type { RuntimeReport, Thread, ThreadCommand, ThreadMessage, ThreadMessageInput } from '@baton/protocol'
import { captureTrace, withTraceSpan } from '@baton/telemetry'
import { AppError } from './errors.ts'

import type { DatabaseEffect } from './database.ts'
import { dbError } from './database.ts'

export type DB<A> = DatabaseEffect<A>
export const failure = (code = 'thread_conflict', status = 409) => new AppError(status, code)
export const transaction = <A>(effect: Effect.Effect<A, AppError | SqlError, SqlClient.SqlClient>): DB<A> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(effect)
  }).pipe(Effect.mapError(dbError))
export const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(value),
    catch: () => failure('invalid_request', 422),
  })
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    )
  return JSON.stringify(value) ?? 'null'
}
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest()
export const uuid = randomUUID
export const readThread = (employee: string, id: string, lock = false) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    if (lock) {
      const rows = yield* sql`SELECT id FROM threads WHERE employee_id=${employee} AND id=${id} FOR UPDATE`
      if (!rows.length) return yield* Effect.fail(failure('not_found', 404))
    }
    const rows = yield* sql<{
      value: Thread
    }>`SELECT jsonb_strip_nulls(to_jsonb(t)-'request_hash'-'exec_wait_until') || jsonb_build_object(
    'node_online',COALESCE(p.online,false),'node_synced',COALESCE(p.synced,false),'node_last_contact_at',p.last_contact_at) AS value
    FROM threads t LEFT JOIN node_presence p ON p.node_id=t.node_id AND p.employee_id=t.employee_id
    WHERE t.employee_id=${employee} AND t.id=${id}`
    if (!rows.length) return yield* Effect.fail(failure('not_found', 404))
    return rows[0]!.value
  })
export const audit = (t: Thread, kind: string, payload: unknown, actor = 'employee', actorID = t.employee_id) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO thread_events(employee_id,thread_id,kind,actor,actor_id,payload) VALUES(${t.employee_id},${t.id},${kind},${actor},${actorID},${JSON.stringify(payload)}::jsonb)`
  })
export const touch = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE threads SET version=version+1,last_activity_at=clock_timestamp() WHERE id=${id}`
  })
export const enqueue = (t: Thread, action: ThreadCommand['action'], payload: unknown = {}) =>
  withTraceSpan(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const trace = yield* captureTrace
      yield* sql`INSERT INTO thread_outbox(employee_id,thread_id,node_id,message_id,action,payload,trace_context) VALUES(${t.employee_id},${t.id},${t.node_id},${uuid()},${action},${JSON.stringify(payload)}::jsonb,${trace ? JSON.stringify(trace) : null}::jsonb)`
    }),
    'baton.command.enqueue',
    undefined,
    {
      kind: 'producer',
      attributes: { 'baton.thread.id': t.id, 'baton.command.action': action },
    },
  )
export function directoryAllowed(system: string, directory: string, roots: RuntimeReport['roots']) {
  const windows = system === 'windows'
  const parser = windows ? path.win32 : path.posix
  if (!parser.isAbsolute(directory)) return false
  const normalize = (value: string) => (windows ? parser.resolve(value).toLowerCase() : parser.resolve(value))
  const target = normalize(directory)
  return (
    roots?.some((root) => {
      const relative = parser.relative(normalize(root.path), target)
      return (
        relative === '' ||
        (!relative.startsWith('..' + parser.sep) && relative !== '..' && !parser.isAbsolute(relative))
      )
    }) ?? false
  )
}
export const admission = (
  employee: string,
  node: string,
  agent: string,
  directory: string,
  model: string,
  operation: 'create' | 'queue' | 'steer' | 'resume',
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{
      system_name: string
      report: RuntimeReport
    }>`SELECT n.system_name,r.report FROM nodes n LEFT JOIN node_runtime_reports r ON r.node_id=n.id AND r.employee_id=n.employee_id WHERE n.id=${node} AND n.employee_id=${employee} AND n.revoked_at IS NULL`
    if (!rows.length) return yield* Effect.fail(failure('not_found', 404))
    const row = rows[0]!
    if (!directoryAllowed(row.system_name, directory, row.report?.roots))
      return yield* Effect.fail(failure('directory_not_allowed', 422))
    const capability = row.report?.agents?.find((a) => a.agent_type === agent && a.status === 'available')
    if (!capability || !capability.capabilities[operation])
      return yield* Effect.fail(
        failure(
          operation === 'steer'
            ? 'steer_unsupported'
            : operation === 'resume'
              ? 'resume_unsupported'
              : 'agent_unavailable',
          422,
        ),
      )
    if (model && !capability.models?.some((m) => m.id === model))
      return yield* Effect.fail(failure('model_unavailable', 422))
    if (operation !== 'create' && model && !capability.capabilities.switch_model)
      return yield* Effect.fail(failure('model_switch_unsupported', 422))
    return model || (operation === 'create' ? capability.default_model : '')
  })
export const normalizeMessage = (input: ThreadMessageInput) =>
  Effect.gen(function* () {
    const mode = input.mode || 'queue'
    const model = input.model || ''
    if (mode === 'steer' && model) return yield* Effect.fail(failure('model_with_steer', 422))
    const normalized = { client_message_id: input.client_message_id, content: input.content, mode, model } as const
    const body = {
      type: 'thread.command',
      trace_context: { traceparent: `00-${'f'.repeat(32)}-${'f'.repeat(16)}-01`, tracestate: '\\'.repeat(512) },
      thread_id: uuid(),
      action: 'message',
      storage_generation: '\\'.repeat(256),
      ...normalized,
    }
    const frame = {
      kind: 'envelope',
      envelope: {
        version: 1,
        message_id: uuid(),
        route: { to: uuid() },
        priority: 'control',
        source: { kind: 'control' },
        body,
      },
    }
    if (Buffer.byteLength(JSON.stringify(frame)) > 256 * 1024)
      return yield* Effect.fail(failure('message_too_large', 413))
    return normalized
  })
export const insertMessage = (t: Thread, input: ThreadMessageInput) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const m = yield* normalizeMessage(input)
    const old = yield* sql<{
      value: ThreadMessage
    }>`SELECT jsonb_strip_nulls(to_jsonb(m)-'employee_id') AS value FROM thread_messages m WHERE employee_id=${t.employee_id} AND thread_id=${t.id} AND client_message_id=${m.client_message_id}`
    if (old.length) {
      const saved = old[0]!.value
      if (saved.content !== m.content || saved.mode !== m.mode || (saved.requested_model || '') !== m.model)
        return yield* Effect.fail(failure())
      return saved
    }
    if (t.status === 'archived' || t.archive_requested_at) return yield* Effect.fail(failure('thread_archived'))
    if (t.status === 'stopped' && !t.opened_at) return yield* Effect.fail(failure('thread_not_opened', 422))
    const selected = m.model || t.next_model || ''
    yield* admission(t.employee_id, t.node_id, t.agent_type, t.working_directory, selected, m.mode)
    const rows = yield* sql<{
      value: ThreadMessage
    }>`INSERT INTO thread_messages(id,employee_id,thread_id,client_message_id,sender,content,mode,model,requested_model) VALUES(${uuid()},${t.employee_id},${t.id},${m.client_message_id},'employee',${m.content},${m.mode},${selected},${m.model}) RETURNING jsonb_strip_nulls(to_jsonb(thread_messages)-'employee_id') AS value`
    yield* enqueue(t, 'message', { client_message_id: m.client_message_id })
    yield* audit(t, 'message.accepted', rows[0]!.value)
    yield* touch(t.id)
    return rows[0]!.value
  })
