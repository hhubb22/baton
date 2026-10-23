import { DatabaseSync } from 'node:sqlite'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { setImmediate as immediate, setTimeout as delay } from 'node:timers/promises'
import { mkdtempSync, rmSync, statfsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { environment, stats } from './common.mjs'

const count = Number(process.argv[2] ?? 10_000)
const batch = Number(process.argv[3] ?? 100)
if (!Number.isSafeInteger(count) || count < 100 || !Number.isSafeInteger(batch) || batch < 1) {
  throw new Error('Usage: node sqlite-full.mjs [commits>=100] [commitsPerEventLoopYield>=1]')
}
const directory = mkdtempSync(join(resolve(process.env.BATON_MEASURE_STORAGE ?? tmpdir()), 'baton-full-'))
const database = new DatabaseSync(join(directory, 'ledger.db'))
try {
  database.exec(
    'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE ledger (seq INTEGER PRIMARY KEY, body BLOB NOT NULL)',
  )
  const settings = {
    journalMode: database.prepare('PRAGMA journal_mode').get().journal_mode,
    synchronous: database.prepare('PRAGMA synchronous').get().synchronous,
    walAutocheckpoint: database.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint,
    pageSize: database.prepare('PRAGMA page_size').get().page_size,
    fullfsync: database.prepare('PRAGMA fullfsync').get().fullfsync,
  }
  if (settings.journalMode !== 'wal' || settings.synchronous !== 2) throw new Error('WAL/FULL was not applied')
  const insert = database.prepare('INSERT INTO ledger(body) VALUES (?)')
  const payload = Buffer.alloc(1024, 120)
  const transaction = () => {
    database.exec('BEGIN IMMEDIATE')
    insert.run(payload)
    database.exec('COMMIT')
  }
  for (let i = 0; i < 200; i++) transaction()
  // Arm the histogram before blocking; sample again after the final batch.
  const histogram = monitorEventLoopDelay({ resolution: 1 })
  histogram.enable()
  await delay(20)
  histogram.reset()
  const commits = []
  const transactions = []
  const start = performance.now()
  for (let i = 0; i < count; i++) {
    const begin = performance.now()
    database.exec('BEGIN IMMEDIATE')
    insert.run(payload)
    const beforeCommit = performance.now()
    database.exec('COMMIT')
    commits.push(performance.now() - beforeCommit)
    transactions.push(performance.now() - begin)
    if ((i + 1) % batch === 0) await immediate()
  }
  const elapsedMs = performance.now() - start
  await delay(20)
  histogram.disable()
  const rows = database.prepare('SELECT count(*) AS count FROM ledger').get().count
  if (rows !== count + 200) throw new Error('Committed row count mismatch')
  console.log(
    JSON.stringify(
      {
        ...environment(),
        count,
        warmup: 200,
        payloadBytes: payload.length,
        commitsPerYield: batch,
        storageDirectory: directory,
        filesystemType: `0x${statfsSync(directory).type.toString(16)}`,
        settings,
        elapsedMs,
        commitsPerSecond: (count / elapsedMs) * 1000,
        commit: stats(commits),
        transaction: stats(transactions),
        eventLoop: {
          resolutionMs: 1,
          count: histogram.count,
          p50Ms: histogram.percentile(50) / 1e6,
          p99Ms: histogram.percentile(99) / 1e6,
          maxMs: histogram.max / 1e6,
        },
        exceeds50Ms: stats(commits).p99Ms > 50,
      },
      null,
      2,
    ),
  )
} finally {
  database.close()
  rmSync(directory, { recursive: true, force: true })
}
