import type {
  ThreadReport,
  WorkerCommandAction,
  WorkerCommandReceipt,
  WorkerCommandStatus,
  WorkerOpenConfig,
} from '@baton/protocol'
import * as Sqlite from '@baton/sqlite'
import type { TraceContext } from '@baton/telemetry'
import { Effect, Schema } from 'effect'
import { FullOutputReference } from '@baton/protocol'
import { dirname } from 'node:path'
import { FullOutputStore, readOutputRetentionDays } from './full-output.ts'
import { boundReport } from './reports.ts'
import * as Reactivity from 'effect/reactivity/Reactivity'
import type { ProcessRecord } from '../platform/process-types.ts'
import type { AgentEvent, AgentMessage, InputPreparation } from './agent.ts'

export type Outcome = 'succeeded' | 'failed' | 'cancelled' | 'unknown'
export type Phase = 'empty' | 'opening' | 'idle' | 'busy' | 'stopping' | 'stopped' | 'unknown' | 'failed'

export interface Command {
  trace_context?: TraceContext
  receipt: WorkerCommandReceipt
  digest: string
  status: WorkerCommandStatus
  messageId?: string
}
export interface Message {
  trace_context?: TraceContext
  input: AgentMessage
  digest: string
  state: 'queued' | 'intent' | 'sent' | 'withdrawn' | 'unknown'
  preparation?: InputPreparation
  executionId?: string
  turn?: number
  ended?: boolean
  startedAtNs?: string
  startedAtMs?: number
  reason?: string
}
export interface OutboxEntry {
  report: ThreadReport
  acked: boolean
  /** JSON 保留原始 UTF-16 字符串和执行身份，与展示报告一同提交。 */
  replyEvidence?: Extract<AgentEvent, { readonly type: 'reply' }>
}
export interface Meta {
  config?: WorkerOpenConfig
  phase: Phase
  epoch: number
  opened: boolean
  nativeId?: string
  turn: number
  activeMessage?: string
  resumeRequested: boolean
  stopStartedNs?: string
  stopReason?: 'stopped' | 'timeout'
  processTreeStopped?: boolean
}
export interface State extends Meta {
  processes: Record<string, ProcessRecord>
  commands: Record<string, Command>
  messages: Record<string, Message>
  outbox: OutboxEntry[]
}

export const initialState = (): State => ({
  phase: 'empty',
  epoch: 0,
  opened: false,
  turn: 0,
  resumeRequested: false,
  commands: {},
  messages: {},
  outbox: [],
  processes: {},
})

export class WorkerFailure extends Error {
  readonly _tag = 'WorkerFailure'
  constructor(
    readonly code: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
  }
}

export const isPending = (command: Command) => command.status.state === 'accepted' || command.status.state === 'running'

export const commandAction = (type: string): WorkerCommandAction | undefined => {
  switch (type) {
    case 'thread_open':
      return 'open'
    case 'thread_resume':
      return 'resume'
    case 'thread_message':
      return 'message'
    case 'thread_settings':
      return 'settings'
    case 'thread_stop':
      return 'stop'
    case 'thread_withdraw':
      return 'withdraw'
    default:
      return undefined
  }
}

/** Only the Worker owns this database. All state and outbox changes share one FULL transaction. */
export const makeLedger = Effect.fn('Worker.makeLedger')(function* (dbPath: string, dataDirectory?: string) {
  const sql = yield* Sqlite.make({
    filename: dbPath,
    commitVerification: {
      writeToken: (token) => ({ sql: 'UPDATE worker_commit SET commit_token = ? WHERE id = 1', params: [token] }),
      readToken: { sql: 'SELECT commit_token FROM worker_commit WHERE id = 1' },
    },
  }).pipe(Effect.provide(Reactivity.layer))
  yield* sql.unsafe(
    'CREATE TABLE IF NOT EXISTS worker_commit (id INTEGER PRIMARY KEY CHECK (id = 1), commit_token TEXT NOT NULL)',
  )
  yield* sql.unsafe("INSERT OR IGNORE INTO worker_commit VALUES (1, '')")
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        'CREATE TABLE IF NOT EXISTS thread_meta (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL)',
      )
      yield* sql.unsafe('CREATE TABLE IF NOT EXISTS thread_commands (id TEXT PRIMARY KEY, payload TEXT NOT NULL)')
      yield* sql.unsafe('CREATE TABLE IF NOT EXISTS thread_messages (id TEXT PRIMARY KEY, payload TEXT NOT NULL)')
      yield* sql.unsafe(
        'CREATE TABLE IF NOT EXISTS thread_processes (pid INTEGER PRIMARY KEY, created_at TEXT NOT NULL, role TEXT NOT NULL)',
      )
      yield* sql.unsafe('CREATE TABLE IF NOT EXISTS thread_outbox (seq INTEGER PRIMARY KEY, payload TEXT NOT NULL)')
    }),
  )

  const load = Effect.gen(function* () {
    const meta = yield* sql.unsafe<{ payload: string }>('SELECT payload FROM thread_meta WHERE id = 1')
    if (meta.length === 0) return initialState()
    const commands = yield* sql.unsafe<{ id: string; payload: string }>(
      'SELECT id, payload FROM thread_commands ORDER BY rowid',
    )
    const messages = yield* sql.unsafe<{ id: string; payload: string }>(
      'SELECT id, payload FROM thread_messages ORDER BY rowid',
    )
    const processes = yield* sql.unsafe<{ pid: number; created_at: string; role: string }>(
      'SELECT pid, created_at, role FROM thread_processes ORDER BY pid',
    )
    const outbox = yield* sql.unsafe<{ payload: string }>('SELECT payload FROM thread_outbox ORDER BY seq')
    return yield* Effect.try({
      try: (): State => ({
        ...(JSON.parse(meta[0]!.payload) as Meta),
        processes: Object.fromEntries(
          processes.map((row) => [String(row.pid), { pid: row.pid, creationTime: row.created_at, role: row.role }]),
        ),
        commands: Object.fromEntries(commands.map((row) => [row.id, JSON.parse(row.payload) as Command])),
        messages: Object.fromEntries(messages.map((row) => [row.id, JSON.parse(row.payload) as Message])),
        outbox: outbox.map((row) => JSON.parse(row.payload) as OutboxEntry),
      }),
      catch: (cause) => new WorkerFailure('ledger_corrupt', 'Worker ledger cannot be decoded', cause),
    })
  })

  const fullOutput = new FullOutputStore(dirname(dbPath))
  const save = Effect.fn('Worker.save')(function* (state: State, previous: State) {
    const savedEvents = new Set(previous.outbox.map((saved) => saved.report.event_id))
    for (const entry of state.outbox) {
      if (savedEvents.has(entry.report.event_id)) continue
      const report = entry.report
      const config = state.config
      if (report.kind === 'reply' && config && report.content !== undefined) {
        const existing = report.metadata?.full_output
        const reference = Schema.is(FullOutputReference)(existing)
          ? existing
          : yield* Effect.tryPromise({
              try: async () =>
                fullOutput.put(
                  config,
                  Buffer.from(report.content ?? '', report.metadata?.encoding === 'base64' ? 'base64' : 'utf8'),
                  await readOutputRetentionDays(dataDirectory),
                ),
              catch: (cause) => new WorkerFailure('storage_error', 'Cannot save full reply', cause),
            })
        entry.report = boundReport({ ...report, metadata: { ...report.metadata, full_output: reference } })
      } else entry.report = boundReport(report)
    }
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const { commands, messages, outbox, processes, ...meta } = state
        yield* sql.unsafe(
          'INSERT INTO thread_meta VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
          [JSON.stringify(meta)],
        )
        for (const record of Object.values(processes)) {
          if (JSON.stringify(previous.processes[String(record.pid)]) === JSON.stringify(record)) continue
          yield* sql.unsafe(
            'INSERT INTO thread_processes VALUES (?, ?, ?) ON CONFLICT(pid) DO UPDATE SET created_at=excluded.created_at, role=excluded.role',
            [record.pid, record.creationTime, record.role],
          )
        }
        for (const record of Object.values(previous.processes)) {
          if (processes[String(record.pid)]) continue
          yield* sql.unsafe('DELETE FROM thread_processes WHERE pid = ? AND created_at = ? AND role = ?', [
            record.pid,
            record.creationTime,
            record.role,
          ])
        }
        for (const [id, command] of Object.entries(commands)) {
          if (JSON.stringify(previous.commands[id]) === JSON.stringify(command)) continue
          yield* sql.unsafe(
            'INSERT INTO thread_commands VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
            [id, JSON.stringify(command)],
          )
        }
        for (const [id, message] of Object.entries(messages)) {
          if (JSON.stringify(previous.messages[id]) === JSON.stringify(message)) continue
          yield* sql.unsafe(
            'INSERT INTO thread_messages VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
            [id, JSON.stringify(message)],
          )
        }
        for (let index = 0; index < outbox.length; index++) {
          const entry = outbox[index]!
          if (JSON.stringify(previous.outbox[index]) === JSON.stringify(entry)) continue
          yield* sql.unsafe(
            'INSERT INTO thread_outbox VALUES (?, ?) ON CONFLICT(seq) DO UPDATE SET payload=excluded.payload',
            [entry.report.worker_seq, JSON.stringify(entry)],
          )
        }
      }),
    )
  })
  return { load, save }
})
