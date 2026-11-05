import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { Schema } from 'effect'
import { readProcessLock } from '../platform/lock.ts'
import { identityMatches } from '../platform/identity.ts'
import { reapProcessTree } from '../platform/process-tree.ts'
import { openPrivateFile, readPrivateFile } from '../platform/private.ts'
import { hasCode } from '../platform/errors.ts'
import type { ProcessRecord } from '../platform/process-types.ts'
import { readLedger } from '../worker/ledger.ts'
import { readExecutionState } from '../execution/ledger.ts'
import { isMissing } from './identity.ts'

const ProcessRecordSchema = Schema.Struct({ pid: Schema.Int, creationTime: Schema.String, role: Schema.String })
const fileSize = async (path: string) => {
  const file = await openPrivateFile(path)
  try {
    return (await file.stat()).size
  } finally {
    await file.close()
  }
}
const entries = (path: string) =>
  readdir(path).catch((error: unknown) => {
    if (isMissing(error)) return []
    throw error
  })

async function processRecords(directory: string): Promise<ProcessRecord[]> {
  const records: ProcessRecord[] = []
  for (const category of ['threads', 'executions']) {
    for (const id of await entries(join(directory, category))) {
      if (!/^[a-f0-9-]{36}$/i.test(id)) continue
      const path = join(directory, category, id, category === 'threads' ? 'thread.db' : 'execution.db')
      try {
        if (!(await fileSize(path))) continue
        if (category === 'threads') records.push(...Object.values(readLedger(path).initial.processes))
        else {
          const process = readExecutionState(path)?.process
          if (process) records.push(process)
        }
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    }
  }
  const projectPath = join(directory, 'project-runtime.db')
  try {
    await fileSize(projectPath)
    const db = new DatabaseSync(projectPath, { readOnly: true })
    try {
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_processes'").get())
        for (const row of db.prepare('SELECT payload FROM project_processes').all())
          records.push(Schema.decodeUnknownSync(ProcessRecordSchema)(JSON.parse(String(row.payload))))
    } finally {
      db.close()
    }
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  for (const agent of await entries(join(directory, 'agent-probes'))) {
    try {
      records.push(
        ...Schema.decodeUnknownSync(Schema.Array(ProcessRecordSchema))(
          JSON.parse(
            (await readPrivateFile(join(directory, 'agent-probes', agent, 'processes.json'))).toString('utf8'),
          ),
        ),
      )
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
  return records
}

/** Stop detached legacy Workers and their separately owned execution groups before unbinding. */
export async function stopManagedProcesses(dataDirectory: string): Promise<void> {
  // Snapshot process records before stopping their owners; owner finalizers may remove those records.
  const before = await processRecords(dataDirectory)
  for (const category of ['threads', 'executions']) {
    const ids = await readdir(join(dataDirectory, category)).catch((error: unknown) => {
      if (isMissing(error)) return []
      throw error
    })
    for (const id of ids) {
      if (!/^[a-f0-9-]{36}$/i.test(id)) continue
      const record = await readProcessLock(join(dataDirectory, category, id, 'worker.lock'))
      if (!record || !(await identityMatches(record))) continue
      try {
        process.kill(record.pid, 'SIGTERM')
      } catch (error) {
        if (!hasCode(error, 'ESRCH')) throw error
      }
      const deadline = performance.now() + 2000
      while (performance.now() < deadline && (await identityMatches(record))) await delay(25)
      const result = await reapProcessTree(record)
      if (!result.reaped && result.reason !== 'identity-mismatch') throw new Error('未能回收活动 Worker 进程树')
    }
  }
  for (const record of [...before, ...(await processRecords(dataDirectory))]) {
    const result = await reapProcessTree(record)
    if (!result.reaped && result.reason !== 'identity-mismatch') throw new Error('未能回收活动执行进程树')
  }
}
