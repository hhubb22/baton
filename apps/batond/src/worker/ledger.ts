import {
  FullOutputReference,
  ThreadReport,
  WorkerCommandReceipt,
  WorkerCommandStatus,
  WorkerOpenConfig,
} from '@baton/protocol'
import type { ThreadAnswerInput, ThreadQuestion } from '@baton/protocol'
import * as Sqlite from '@baton/sqlite'
import type { TraceContext } from '@baton/telemetry'
import { lstat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import { Effect, Exit, Schema, type Scope } from 'effect'
import type { SqlError } from 'effect/sql/SqlError'
import * as Reactivity from 'effect/reactivity/Reactivity'
import { hasCode } from '../platform/errors.ts'
import { openPrivateFile } from '../platform/private.ts'
import type { ProcessRecord } from '../platform/process-types.ts'
import { FullOutputStore, readOutputRetentionDays } from './full-output.ts'
import { boundReport } from './reports.ts'
import type { AgentEvent, AgentMessage, InputPreparation } from './agent.ts'

export type Outcome = 'succeeded' | 'failed' | 'cancelled' | 'unknown'
type Phase = 'empty' | 'opening' | 'idle' | 'busy' | 'stopping' | 'stopped' | 'unknown' | 'failed'

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
interface PendingQuestion {
  question: ThreadQuestion
  messageId: string
  executionId: string
  turn: number
  state: 'pending' | 'queued' | 'intent' | 'resolved' | 'cancelled'
  answer?: ThreadAnswerInput
  commandId?: string
}
interface Meta {
  questions?: PendingQuestion[]
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

const initialState = (): State => ({
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

export type WorkerLedgerInspection = 'valid' | 'missing' | 'empty' | 'corrupt' | 'retry'
export interface OpenWorkerLedger {
  readonly initial: State
  readonly save: (next: State) => Effect.Effect<void, WorkerFailure | SqlError>
}

type Row = Record<string, SQLOutputValue>
const tables = [
  'worker_commit',
  'thread_meta',
  'thread_commands',
  'thread_messages',
  'thread_processes',
  'thread_outbox',
]
const phases = new Set(['empty', 'opening', 'idle', 'busy', 'stopping', 'stopped', 'unknown', 'failed'])
const integer = Schema.Number.check(Schema.makeFilter((value) => Number.isSafeInteger(value) && value >= 0))
const metaSchema = Schema.Struct({
  phase: Schema.Unknown.check(Schema.makeFilter((value) => phases.has(String(value)))),
  epoch: integer,
  turn: integer,
  opened: Schema.Boolean,
  resumeRequested: Schema.Boolean,
})
const commandSchema = Schema.Struct({
  digest: Schema.String,
  receipt: WorkerCommandReceipt,
  status: WorkerCommandStatus,
})
const messageSchema = Schema.Struct({
  digest: Schema.String,
  input: Schema.Struct({ id: Schema.Unknown }),
  state: Schema.Unknown.check(
    Schema.makeFilter((value) => ['queued', 'intent', 'sent', 'withdrawn', 'unknown'].includes(String(value))),
  ),
})
const outboxSchema = Schema.Struct({ acked: Schema.Boolean, report: ThreadReport })
const corrupt = (): never => {
  throw new WorkerFailure('ledger_corrupt', 'Worker ledger cannot be decoded')
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

/** 两种打开方式使用相同字段规则；证据和扩展字段保留 JSON 原值。 */
function decodeLedger(query: (sql: string) => readonly Row[], expected?: WorkerOpenConfig) {
  const checks = query('PRAGMA quick_check(1)')
  if (checks.length !== 1 || Object.values(checks[0]!)[0] !== 'ok') corrupt()
  const found = new Set(query("SELECT name FROM sqlite_schema WHERE type='table'").map((row) => row.name))
  if (found.size === 0 || (found.size === 1 && found.has('worker_commit')))
    return { initial: initialState(), condition: 'empty' as const }
  if (tables.some((table) => !found.has(table))) corrupt()
  const commands = query('SELECT id, payload FROM thread_commands ORDER BY rowid')
  const messages = query('SELECT id, payload FROM thread_messages ORDER BY rowid')
  const processes = query('SELECT pid, created_at, role FROM thread_processes ORDER BY pid')
  const outbox = query('SELECT seq, payload FROM thread_outbox ORDER BY seq')
  const hasActivity = commands.length + messages.length + processes.length + outbox.length > 0
  const rows = query('SELECT payload FROM thread_meta WHERE id=1')
  if (!rows.length) {
    if (hasActivity) corrupt()
    return { initial: initialState(), condition: 'empty' as const }
  }
  const meta: Meta = JSON.parse(String(rows[0]!.payload))
  Schema.decodeUnknownSync(metaSchema)(meta)
  if (meta.config === undefined) {
    if (
      hasActivity ||
      meta.phase !== 'empty' ||
      meta.epoch !== 0 ||
      meta.turn !== 0 ||
      meta.opened ||
      meta.resumeRequested ||
      meta.nativeId !== undefined ||
      meta.activeMessage !== undefined
    )
      corrupt()
    return { initial: { ...initialState(), ...meta }, condition: 'empty' as const }
  }
  Schema.decodeUnknownSync(WorkerOpenConfig)(meta.config)
  const config = meta.config
  if (
    (expected && JSON.stringify(canonical(config)) !== JSON.stringify(canonical(expected))) ||
    (meta.opened && (typeof meta.nativeId !== 'string' || !meta.nativeId))
  )
    corrupt()
  const initial: State = {
    ...meta,
    commands: Object.fromEntries(
      commands.map((row) => {
        const value: Command = JSON.parse(String(row.payload))
        const { receipt, status } = Schema.decodeUnknownSync(commandSchema)(value)
        if (
          receipt.command_id !== row.id ||
          status.command_id !== row.id ||
          receipt.thread_id !== config.thread_id ||
          receipt.storage_generation !== config.storage_generation
        )
          corrupt()
        return [String(row.id), value]
      }),
    ),
    messages: Object.fromEntries(
      messages.map((row) => {
        const value: Message = JSON.parse(String(row.payload))
        const decoded = Schema.decodeUnknownSync(messageSchema)(value)
        if (decoded.input.id !== row.id) corrupt()
        return [String(row.id), value]
      }),
    ),
    processes: Object.fromEntries(
      processes.map((row) => [
        String(row.pid),
        {
          pid: row.pid as number,
          creationTime: row.created_at as string,
          role: row.role as string,
        },
      ]),
    ),
    outbox: outbox.map((row) => {
      const value: OutboxEntry = JSON.parse(String(row.payload))
      const { report } = Schema.decodeUnknownSync(outboxSchema)(value)
      if (
        report.thread_id !== config.thread_id ||
        report.storage_generation !== config.storage_generation ||
        report.worker_seq !== row.seq
      )
        corrupt()
      return value
    }),
  }
  return { initial, condition: 'valid' as const }
}

function readLedger(dbPath: string, expected?: WorkerOpenConfig) {
  const db = new DatabaseSync(dbPath, { readOnly: true, allowExtension: false, timeout: 0 })
  try {
    return decodeLedger((sql) => db.prepare(sql).all(), expected)
  } finally {
    db.close()
  }
}

const isCorruption = (error: unknown) => {
  if (error instanceof Error && 'errcode' in error && typeof error.errcode === 'number')
    return [1, 11, 26].includes(error.errcode & 0xff)
  return (
    error instanceof SyntaxError ||
    (error instanceof WorkerFailure && error.code === 'ledger_corrupt') ||
    Schema.isSchemaError(error)
  )
}

/** 只读检查不创建或修复账本；关闭失败同样需要重试。 */
export async function inspectWorkerLedger(dbPath: string, expected: WorkerOpenConfig): Promise<WorkerLedgerInspection> {
  let file
  try {
    file = await openPrivateFile(dbPath)
  } catch (error) {
    return hasCode(error, 'ENOENT') ? 'missing' : 'retry'
  }
  try {
    await file.close()
  } catch {
    return 'retry'
  }
  let db: DatabaseSync | undefined
  let result: WorkerLedgerInspection
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, allowExtension: false, timeout: 0 })
    result = decodeLedger((sql) => db!.prepare(sql).all(), expected).condition
  } catch (error) {
    result = isCorruption(error) ? 'corrupt' : 'retry'
  }
  try {
    db?.close()
  } catch {
    return 'retry'
  }
  return result
}

function encode(state: State) {
  return {
    commands: new Map(Object.entries(state.commands).map(([id, value]) => [id, JSON.stringify(value)])),
    messages: new Map(Object.entries(state.messages).map(([id, value]) => [id, JSON.stringify(value)])),
    outbox: state.outbox.map((value) => JSON.stringify(value)),
    events: new Set(state.outbox.map((value) => value.report.event_id)),
    processes: new Map(
      Object.values(state.processes).map((value) => [
        String(value.pid),
        {
          payload: JSON.stringify(value),
          pid: value.pid,
          creationTime: value.creationTime,
          role: value.role,
        },
      ]),
    ),
  }
}

/** 调用方持有 Worker 独占锁；失败后须关闭 Scope 并重新打开。 */
export const openWorkerLedger = Effect.fn('Worker.openWorkerLedger')(function* (options: {
  dbPath: string
  dataDirectory?: string
}): Effect.fn.Return<OpenWorkerLedger, WorkerFailure | SqlError, Scope.Scope> {
  const { dbPath, dataDirectory } = options
  const initial = yield* Effect.tryPromise({
    try: async () => {
      try {
        await lstat(dbPath)
      } catch (error) {
        if (hasCode(error, 'ENOENT')) return initialState()
        throw error
      }
      return readLedger(dbPath).initial
    },
    catch: (cause) =>
      cause instanceof WorkerFailure
        ? cause
        : new WorkerFailure(
            isCorruption(cause) ? 'ledger_corrupt' : 'storage_error',
            'Cannot read Worker ledger',
            cause,
          ),
  })
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
  let baseline = encode(initial)
  let usable = true
  const fullOutput = new FullOutputStore(dirname(dbPath))
  const save = Effect.fn('Worker.save')(
    function* (state: State) {
      if (!usable)
        return yield* Effect.fail(new WorkerFailure('ledger_closed', 'Reopen the Worker ledger after a failed save'))
      for (const entry of state.outbox) {
        if (baseline.events.has(entry.report.event_id)) continue
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
      const next = encode(state)
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const { commands: _commands, messages: _messages, outbox, processes, ...meta } = state
          yield* sql.unsafe(
            'INSERT INTO thread_meta VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
            [JSON.stringify(meta)],
          )
          for (const [id, record] of next.processes) {
            if (baseline.processes.get(id)?.payload === record.payload) continue
            yield* sql.unsafe(
              'INSERT INTO thread_processes VALUES (?, ?, ?) ON CONFLICT(pid) DO UPDATE SET created_at=excluded.created_at, role=excluded.role',
              [record.pid, record.creationTime, record.role],
            )
          }
          for (const [id, record] of baseline.processes) {
            if (processes[id]) continue
            yield* sql.unsafe('DELETE FROM thread_processes WHERE pid = ? AND created_at = ? AND role = ?', [
              record.pid,
              record.creationTime,
              record.role,
            ])
          }
          for (const [id, payload] of next.commands) {
            if (baseline.commands.get(id) === payload) continue
            yield* sql.unsafe(
              'INSERT INTO thread_commands VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
              [id, payload],
            )
          }
          for (const [id, payload] of next.messages) {
            if (baseline.messages.get(id) === payload) continue
            yield* sql.unsafe(
              'INSERT INTO thread_messages VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
              [id, payload],
            )
          }
          for (let index = 0; index < outbox.length; index++) {
            const payload = next.outbox[index]!
            if (baseline.outbox[index] === payload) continue
            yield* sql.unsafe(
              'INSERT INTO thread_outbox VALUES (?, ?) ON CONFLICT(seq) DO UPDATE SET payload=excluded.payload',
              [outbox[index]!.report.worker_seq, payload],
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
  return { initial, save }
})
