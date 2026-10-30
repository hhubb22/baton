import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { arch, cpus, release, tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { performance } from 'node:perf_hooks'
import { stats } from '../measure/stats.mjs'

if (process.platform !== 'win32' || !process.env.RUNNER_TEMP) throw new Error('Windows runner required')

async function measure(base) {
  const directory = await mkdtemp(join(base, 'baton-sqlite-io-'))
  try {
    const db = new DatabaseSync(join(directory, 'ledger.sqlite'))
    try {
      db.exec(
        'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)',
      )
      const pragmas = {
        journal_mode: db.prepare('PRAGMA journal_mode').get().journal_mode,
        synchronous: db.prepare('PRAGMA synchronous').get().synchronous,
        fullfsync: db.prepare('PRAGMA fullfsync').get().fullfsync,
        wal_autocheckpoint: db.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint,
      }
      if (pragmas.journal_mode !== 'wal' || pragmas.synchronous !== 2) throw new Error('WAL/FULL unavailable')
      const insert = db.prepare('INSERT OR REPLACE INTO records (id, value) VALUES (1, ?)')
      const samples = []
      for (let i = 0; i < 2200; i++) {
        db.exec('BEGIN IMMEDIATE')
        insert.run(String(i))
        const started = performance.now()
        db.exec('COMMIT')
        if (i >= 200) samples.push(performance.now() - started)
      }
      return {
        volume: parse(directory).root,
        warmupTransactions: 200,
        transactions: samples.length,
        pragmas,
        commit: stats(samples),
      }
    } finally {
      db.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const osTemporary = await measure(tmpdir())
const runnerTemporary = await measure(process.env.RUNNER_TEMP)
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      arch: arch(),
      osRelease: release(),
      cpu: cpus()[0]?.model,
      osTemporary,
      runnerTemporary,
      note: 'SQLite I/O diagnostic; not Worker acceptance',
    },
    null,
    2,
  ),
)
