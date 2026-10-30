import * as Sqlite from '@baton/sqlite'
import { Effect, Schema } from 'effect'
import * as Reactivity from 'effect/reactivity/Reactivity'
import { DatabaseSync } from 'node:sqlite'
import { ExecutionCommand, ExecutionReport } from '@baton/protocol'
import type { ProcessRecord } from '../platform/process.ts'
import { checkStorageFormat, initializeStorage } from '../storage-format.ts'

export const storageBaseline = [
  'CREATE TABLE commit_marker (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL)',
  "INSERT INTO commit_marker VALUES(1,'')",
  'CREATE TABLE execution_state (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)',
] as const

export interface ExecutionState {
  command?: ExecutionCommand
  stopped?: ExecutionCommand
  intent: boolean
  process?: ProcessRecord
  reports: readonly { readonly report: ExecutionReport; readonly acked: boolean }[]
}

const StoredState = Schema.Struct({
  command: Schema.optionalKey(ExecutionCommand),
  stopped: Schema.optionalKey(ExecutionCommand),
  intent: Schema.Boolean,
  process: Schema.optionalKey(Schema.Struct({ pid: Schema.Number, creationTime: Schema.String, role: Schema.String })),
  reports: Schema.Array(Schema.Struct({ report: ExecutionReport, acked: Schema.Boolean })),
})

export function readExecutionState(filename: string): ExecutionState | undefined {
  checkStorageFormat(filename, 'execution', storageBaseline)
  const db = new DatabaseSync(filename, { readOnly: true })
  try {
    const row = db.prepare('SELECT payload FROM execution_state WHERE id=1').get()
    return row ? Schema.decodeUnknownSync(StoredState)(JSON.parse(String(row.payload))) : undefined
  } finally {
    db.close()
  }
}

export const openExecutionLedger = Effect.fn('Execution.openLedger')(function* (filename: string) {
  yield* Effect.try({
    try: () => checkStorageFormat(filename, 'execution', storageBaseline),
    catch: (error) => error as Error,
  })
  const sql = yield* Sqlite.make({
    filename,
    commitVerification: {
      writeToken: (token) => ({ sql: 'UPDATE commit_marker SET token=? WHERE id=1', params: [token] }),
      readToken: { sql: 'SELECT token FROM commit_marker WHERE id=1' },
    },
  }).pipe(Effect.provide(Reactivity.layer))
  yield* initializeStorage(sql, 'execution', storageBaseline)
  const rows = yield* sql.unsafe<{ payload: string }>('SELECT payload FROM execution_state WHERE id=1')
  const state: ExecutionState = rows[0]
    ? Schema.decodeUnknownSync(StoredState)(JSON.parse(rows[0].payload))
    : { intent: false, reports: [] }
  const save = (next: ExecutionState) =>
    sql.withTransaction(
      sql
        .unsafe('INSERT INTO execution_state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload', [
          JSON.stringify(next),
        ])
        .pipe(Effect.asVoid),
    )
  return { state, save }
})
