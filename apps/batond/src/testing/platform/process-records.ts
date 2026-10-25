import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Effect, Schema } from 'effect'
import type { ProcessRecord, ProcessRecordCallbacks } from '../../platform/process-types.ts'
import type { Worker } from '../../worker/index.ts'

const Records = Schema.Array(Schema.Struct({ pid: Schema.Int, creationTime: Schema.String, role: Schema.String }))

/** Reopen the SQLite file for every operation so callbacks only resolve after a durable write. */
export const replayProcessRecords = (directory: string) => {
  const access = <A>(operation: (db: DatabaseSync) => A): A => {
    const db = new DatabaseSync(join(directory, 'replay-processes.db'))
    try {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
      db.exec(
        'CREATE TABLE IF NOT EXISTS processes (pid INTEGER PRIMARY KEY, creationTime TEXT NOT NULL, role TEXT NOT NULL)',
      )
      return operation(db)
    } finally {
      db.close()
    }
  }
  return {
    add: async (record: ProcessRecord) => {
      access((db) => {
        db.prepare('INSERT INTO processes VALUES (?, ?, ?)').run(record.pid, record.creationTime, record.role)
      })
    },
    remove: async (record: ProcessRecord) => {
      access((db) => {
        db.prepare('DELETE FROM processes WHERE pid = ? AND creationTime = ? AND role = ?').run(
          record.pid,
          record.creationTime,
          record.role,
        )
      })
    },
    list: () =>
      access((db) => Schema.decodeUnknownSync(Records)(db.prepare('SELECT * FROM processes ORDER BY pid').all())),
  } satisfies ProcessRecordCallbacks & { list: () => readonly ProcessRecord[] }
}

/** The factory is invoked after Worker construction; its callbacks use the Worker's own transactions. */
export const workerProcessRecords = (worker: () => Worker): ProcessRecordCallbacks => ({
  add: (record) => Effect.runPromise(worker().records.add(record)),
  remove: (record) => Effect.runPromise(worker().records.remove(record)),
})
