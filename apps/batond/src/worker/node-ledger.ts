import { createHash } from 'node:crypto'
import { join } from 'node:path'
import * as Sqlite from '@baton/sqlite'
import {
  FullOutputReference,
  ThreadReport,
  WorkerOpenConfig,
  type WorkerCommandReceipt,
  type WorkerCommandStatus,
} from '@baton/protocol'
import { Effect, Exit, Schema, type Scope } from 'effect'
import type { SqlError } from 'effect/sql/SqlError'
import * as Reactivity from 'effect/reactivity/Reactivity'
import { checkStorageFormat, initializeStorage } from '../storage-format.ts'
import { commitVerification, storageBaseline } from '../node-schema.ts'
import { boundReport } from './reports.ts'
import { FullOutputStore, readOutputRetentionDays } from './full-output.ts'
import {
  emptyWorkerState,
  WorkerFailure,
  type Command,
  type Message,
  type OpenWorkerLedger,
  type OutboxEntry,
  type State,
} from './ledger.ts'
import type { AgentEvent } from './agent.ts'

interface ThreadRow {
  storage_generation: string
  startup_phase: 'awaiting_open' | 'open_attempted'
  config_json: string
  meta_json: string
}

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value
const hash = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
const outboxPayload = (entry: OutboxEntry) => JSON.stringify(entry.report)

function encode(state: State) {
  return {
    commands: new Map(Object.entries(state.commands).map(([id, value]) => [id, JSON.stringify(value)])),
    messages: new Map(Object.entries(state.messages).map(([id, value]) => [id, JSON.stringify(value)])),
    outbox: state.outbox.map(outboxPayload),
    processes: new Map(
      Object.values(state.processes).map((value) => [String(value.pid), { payload: JSON.stringify(value), ...value }]),
    ),
  }
}

const decode = (rows: {
  thread: ThreadRow | undefined
  commands: readonly { worker_json: string }[]
  messages: readonly { payload: string }[]
  outbox: readonly { seq: number; event_id: string; payload: string; worker_acked: number }[]
  processes: readonly { pid: number; creation_time: string; role: string }[]
}): State => {
  if (!rows.thread) return emptyWorkerState()
  const meta = JSON.parse(rows.thread.meta_json) as Omit<State, 'commands' | 'messages' | 'outbox' | 'processes'>
  return {
    ...emptyWorkerState(),
    ...meta,
    config: Schema.decodeUnknownSync(WorkerOpenConfig)(JSON.parse(rows.thread.config_json)),
    commands: Object.fromEntries(
      rows.commands.map((row) => {
        const value = JSON.parse(row.worker_json) as Command
        return [value.receipt.command_id, value]
      }),
    ),
    messages: Object.fromEntries(
      rows.messages.map((row) => {
        const value = JSON.parse(row.payload) as Message
        return [value.input.id, value]
      }),
    ),
    outbox: rows.outbox.map((row) => {
      const report = JSON.parse(row.payload) as ThreadReport
      return { report, acked: row.worker_acked === 1 }
    }),
    processes: Object.fromEntries(
      rows.processes.map((row) => [String(row.pid), { pid: row.pid, creationTime: row.creation_time, role: row.role }]),
    ),
  }
}

/** A Thread state machine owns one node.db thread row; it never opens a per-Thread database. */
export const openThreadLedger = Effect.fn('Worker.openThreadLedger')(function* (options: {
  dbPath: string
  threadId: string
  dataDirectory: string
}): Effect.fn.Return<OpenWorkerLedger, WorkerFailure | SqlError, Scope.Scope> {
  const { dbPath, threadId, dataDirectory } = options
  yield* Effect.try({
    try: () => checkStorageFormat(dbPath, 'node', storageBaseline),
    catch: (cause) =>
      new WorkerFailure('storage_error', cause instanceof Error ? cause.message : 'Cannot read node.db', cause),
  })
  const sql = yield* Sqlite.make({
    filename: dbPath,
    busyTimeoutMs: 5000,
    commitVerification,
  }).pipe(Effect.provide(Reactivity.layer))
  yield* initializeStorage(sql, 'node', storageBaseline).pipe(
    Effect.mapError((cause) =>
      cause instanceof WorkerFailure ? cause : new WorkerFailure('storage_error', 'Cannot initialize node.db', cause),
    ),
  )
  const load = Effect.gen(function* () {
    const thread = yield* sql.unsafe<ThreadRow>('SELECT * FROM threads WHERE thread_id=?', [threadId])
    if (!thread[0]) return emptyWorkerState()
    Schema.decodeUnknownSync(WorkerOpenConfig)(JSON.parse(thread[0].config_json))
    return decode({
      thread: thread[0],
      commands: yield* sql.unsafe<{ worker_json: string }>(
        'SELECT worker_json FROM thread_commands WHERE thread_id=? AND worker_json IS NOT NULL ORDER BY rowid',
        [threadId],
      ),
      messages: yield* sql.unsafe<{ payload: string }>(
        'SELECT payload FROM thread_messages WHERE thread_id=? ORDER BY seq',
        [threadId],
      ),
      outbox: yield* sql.unsafe<{ seq: number; event_id: string; payload: string; worker_acked: number }>(
        'SELECT seq,event_id,payload,worker_acked FROM thread_outbox WHERE thread_id=? ORDER BY seq',
        [threadId],
      ),
      processes: yield* sql.unsafe<{ pid: number; creation_time: string; role: string }>(
        "SELECT pid,creation_time,role FROM node_processes WHERE owner_kind='thread' AND owner_id=? ORDER BY pid",
        [threadId],
      ),
    })
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof WorkerFailure ? cause : new WorkerFailure('storage_error', 'Cannot decode Thread ledger', cause),
    ),
  )
  const initial = yield* load
  let baseline = encode(initial)
  let usable = true
  const fullOutput = new FullOutputStore(join(dataDirectory, 'threads', threadId))
  const save = Effect.fn('Worker.saveThread')(
    function* (state: State) {
      if (!usable)
        return yield* Effect.fail(new WorkerFailure('ledger_closed', 'Reopen the Thread ledger after a failed save'))
      for (const entry of state.outbox) {
        if (baseline.outbox.includes(outboxPayload(entry)) && entry.acked) continue
        const report = entry.report
        const config = state.config
        if (report.kind === 'reply' && config && report.content !== undefined) {
          const bounded = boundReport(report)
          const existing = report.metadata?.full_output
          if (bounded.truncated && !Schema.is(FullOutputReference)(existing)) {
            const reference = yield* Effect.tryPromise({
              try: async () =>
                fullOutput.put(
                  config,
                  Buffer.from(report.content ?? '', report.metadata?.encoding === 'base64' ? 'base64' : 'utf8'),
                  await readOutputRetentionDays(dataDirectory),
                ),
              catch: (cause) => new WorkerFailure('storage_error', 'Cannot save full reply', cause),
            })
            entry.report = boundReport({ ...bounded, metadata: { ...bounded.metadata, full_output: reference } })
          } else entry.report = bounded
        } else if (report.kind === 'turn.item' && report.item && config) {
          const bounded = boundReport(report)
          const existing = report.metadata?.full_output
          if (bounded.truncated && !Schema.is(FullOutputReference)(existing)) {
            const reference = yield* Effect.tryPromise({
              try: async () =>
                fullOutput.put(
                  config,
                  Buffer.from(JSON.stringify(report.item!.data)),
                  await readOutputRetentionDays(dataDirectory),
                ),
              catch: (cause) => new WorkerFailure('storage_error', 'Cannot save full turn item', cause),
            })
            entry.report = boundReport({ ...bounded, metadata: { ...bounded.metadata, full_output: reference } })
          } else entry.report = bounded
        } else entry.report = boundReport(report)
      }
      const config = state.config
      if (!config) return
      const next = encode(state)
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const { commands: _commands, messages: _messages, outbox: _outbox, processes, ...meta } = state
          yield* sql.unsafe(
            `INSERT INTO threads(thread_id,storage_generation,startup_phase,config_json,meta_json,control_json)
             VALUES(?,?,'open_attempted',?,?,'{}')
             ON CONFLICT(thread_id) DO UPDATE SET
               storage_generation=excluded.storage_generation,
               config_json=excluded.config_json,
               meta_json=excluded.meta_json`,
            [config.thread_id, config.storage_generation, JSON.stringify(config), JSON.stringify(meta)],
          )
          for (const [pid, record] of next.processes) {
            if (baseline.processes.get(pid)?.payload === record.payload) continue
            yield* sql.unsafe(
              `INSERT INTO node_processes(owner_kind,owner_id,pid,creation_time,role) VALUES('thread',?,?,?,?)
               ON CONFLICT(owner_kind,owner_id,pid) DO UPDATE SET creation_time=excluded.creation_time,role=excluded.role`,
              [threadId, record.pid, record.creationTime, record.role],
            )
          }
          for (const [pid, record] of baseline.processes) {
            if (processes[pid]) continue
            yield* sql.unsafe(
              "DELETE FROM node_processes WHERE owner_kind='thread' AND owner_id=? AND pid=? AND creation_time=? AND role=?",
              [threadId, record.pid, record.creationTime, record.role],
            )
          }
          for (const [id, payload] of next.commands) {
            if (baseline.commands.get(id) === payload) continue
            const command = JSON.parse(payload) as Command
            yield* sql.unsafe(
              `INSERT INTO thread_commands(command_id,thread_id,hash,receipt_json,status_json,worker_json)
               VALUES(?,?,?,?,?,?)
               ON CONFLICT(command_id) DO UPDATE SET receipt_json=excluded.receipt_json,
                 status_json=excluded.status_json,worker_json=excluded.worker_json`,
              [
                id,
                threadId,
                command.digest,
                JSON.stringify(command.receipt satisfies WorkerCommandReceipt),
                JSON.stringify(command.status satisfies WorkerCommandStatus),
                payload,
              ],
            )
          }
          const messageIds = new Set(Object.keys(state.messages))
          for (const [id, payload] of next.messages) {
            if (baseline.messages.get(id) === payload) continue
            const index = Object.keys(state.messages).indexOf(id)
            yield* sql.unsafe(
              `INSERT INTO thread_messages(thread_id,message_id,seq,payload) VALUES(?,?,?,?)
               ON CONFLICT(thread_id,message_id) DO UPDATE SET seq=excluded.seq,payload=excluded.payload`,
              [threadId, id, index, payload],
            )
          }
          for (const id of baseline.messages.keys()) {
            if (messageIds.has(id)) continue
            yield* sql.unsafe('DELETE FROM thread_messages WHERE thread_id=? AND message_id=?', [threadId, id])
          }
          for (const entry of state.outbox) {
            if (baseline.outbox.includes(outboxPayload(entry))) continue
            const { report } = entry
            const { trace_context: _trace, ...content } = report
            yield* sql.unsafe(
              `INSERT INTO thread_outbox(thread_id,seq,event_id,hash,payload,created_ms,acked,worker_acked)
               VALUES(?,?,?,?,?,?,0,?)
               ON CONFLICT(thread_id,seq) DO NOTHING`,
              [
                threadId,
                report.worker_seq,
                report.event_id,
                hash(content),
                outboxPayload(entry),
                Date.now(),
                entry.acked ? 1 : 0,
              ],
            )
          }
        }),
      )
      baseline = next
    },
    Effect.onExit((exit) =>
      Effect.sync(() => {
        if (Exit.isFailure(exit)) usable = false
      }),
    ),
  )
  const ack = Effect.fn('Worker.ackThread')(
    function* (seq: number, eventId: string) {
      if (!usable)
        return yield* Effect.fail(new WorkerFailure('ledger_closed', 'Reopen the Thread ledger after a failed save'))
      const payload = baseline.outbox[seq - 1]
      const report: ThreadReport | undefined = payload === undefined ? undefined : JSON.parse(payload)
      if (!report || report.worker_seq !== seq || report.event_id !== eventId)
        return yield* Effect.fail(new WorkerFailure('invalid_ack', 'Report sequence and event ID do not match'))
      const next = JSON.stringify(report)
      yield* sql.withTransaction(
        sql.unsafe('UPDATE thread_outbox SET worker_acked=1 WHERE thread_id=? AND seq=? AND event_id=?', [
          threadId,
          seq,
          eventId,
        ]),
      )
      baseline.outbox[seq - 1] = next
    },
    Effect.onExit((exit) =>
      Effect.sync(() => {
        if (Exit.isFailure(exit)) usable = false
      }),
    ),
  )
  return { initial, save, ack }
})

export type { AgentEvent, ThreadReport }
