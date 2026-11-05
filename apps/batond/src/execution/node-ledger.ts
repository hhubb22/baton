import * as Sqlite from '@baton/sqlite'
import { Effect, Schema } from 'effect'
import * as Reactivity from 'effect/reactivity/Reactivity'
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { ExecutionCommand, ExecutionReport } from '@baton/protocol'
import type { ProcessRecord } from '../platform/process.ts'
import { checkStorageFormat, initializeStorage } from '../storage-format.ts'
import { commitVerification, storageBaseline } from '../node-schema.ts'
import { hasCode } from '../platform/errors.ts'

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

export function readExecutionStates(filename: string): readonly { id: string; state: ExecutionState }[] {
  if (!existsSync(filename)) return []
  let db: DatabaseSync
  try {
    checkStorageFormat(filename, 'node', storageBaseline)
    db = new DatabaseSync(filename, { readOnly: true })
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return []
    throw error
  }
  try {
    if (!db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='executions'").get()) return []
    return db
      .prepare('SELECT execution_id,payload FROM executions ORDER BY execution_id')
      .all()
      .map((row) => ({
        id: String(row.execution_id),
        state: Schema.decodeUnknownSync(StoredState)(JSON.parse(String(row.payload))) as ExecutionState,
      }))
  } finally {
    db.close()
  }
}

export const openExecutionLedger = Effect.fn('Execution.openLedger')(function* (filename: string, executionId: string) {
  yield* Effect.try({
    try: () => checkStorageFormat(filename, 'node', storageBaseline),
    catch: (error) => error as Error,
  })
  const sql = yield* Sqlite.make({
    filename,
    busyTimeoutMs: 5000,
    commitVerification,
  }).pipe(Effect.provide(Reactivity.layer))
  yield* initializeStorage(sql, 'node', storageBaseline)
  const rows = yield* sql.unsafe<{ payload: string }>('SELECT payload FROM executions WHERE execution_id=?', [
    executionId,
  ])
  const state: ExecutionState = rows[0]
    ? Schema.decodeUnknownSync(StoredState)(JSON.parse(rows[0].payload))
    : { intent: false, reports: [] }
  let previousProcess = state.process
  const save = (next: ExecutionState) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const generation = next.command?.storage_generation ?? next.stopped?.storage_generation ?? ''
        yield* sql.unsafe(
          `INSERT INTO executions(execution_id,storage_generation,payload) VALUES(?,?,?)
           ON CONFLICT(execution_id) DO UPDATE SET storage_generation=excluded.storage_generation,payload=excluded.payload`,
          [executionId, generation, JSON.stringify(next)],
        )
        if (previousProcess && previousProcess !== next.process) {
          yield* sql.unsafe(
            "DELETE FROM node_processes WHERE owner_kind='execution' AND owner_id=? AND pid=? AND creation_time=? AND role=?",
            [executionId, previousProcess.pid, previousProcess.creationTime, previousProcess.role],
          )
        }
        if (next.process && next.process !== previousProcess) {
          yield* sql.unsafe(
            `INSERT INTO node_processes(owner_kind,owner_id,pid,creation_time,role) VALUES('execution',?,?,?,?)
             ON CONFLICT(owner_kind,owner_id,pid) DO UPDATE SET creation_time=excluded.creation_time,role=excluded.role`,
            [executionId, next.process.pid, next.process.creationTime, next.process.role],
          )
        }
        previousProcess = next.process
      }),
    )
  return { state, save }
})
