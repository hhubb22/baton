import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Schema } from 'effect'
import { reapProcessTree } from '../platform/process-tree.ts'
import { readPrivateFile } from '../platform/private.ts'
import { hasCode } from '../platform/errors.ts'
import type { ProcessRecord } from '../platform/process-types.ts'
import { isMissing } from './identity.ts'

const ProcessRecordSchema = Schema.Struct({ pid: Schema.Int, creationTime: Schema.String, role: Schema.String })

function nodeRecords(directory: string): ProcessRecord[] {
  if (!existsSync(join(directory, 'node.db'))) return []
  try {
    const db = new DatabaseSync(join(directory, 'node.db'), { readOnly: true })
    try {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='node_processes'").get()) return []
      return db
        .prepare('SELECT pid,creation_time,role FROM node_processes')
        .all()
        .map((row) => ({
          pid: Number(row.pid),
          creationTime: String(row.creation_time),
          role: String(row.role),
        }))
    } finally {
      db.close()
    }
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
}

function projectRecords(directory: string): ProcessRecord[] {
  if (!existsSync(join(directory, 'project-runtime.db'))) return []
  try {
    const db = new DatabaseSync(join(directory, 'project-runtime.db'), { readOnly: true })
    try {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_processes'").get()) return []
      return db
        .prepare('SELECT payload FROM project_processes')
        .all()
        .map((row) => Schema.decodeUnknownSync(ProcessRecordSchema)(JSON.parse(String(row.payload))))
    } finally {
      db.close()
    }
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
}

async function probeRecords(directory: string): Promise<ProcessRecord[]> {
  const records: ProcessRecord[] = []
  for (const agent of ['codex', 'cursor', 'pi', 'kiro', 'antigravity', 'droid']) {
    try {
      records.push(
        ...Schema.decodeUnknownSync(Schema.Array(ProcessRecordSchema))(
          JSON.parse(
            (await readPrivateFile(join(directory, 'agent-probes', agent, 'processes.json'))).toString('utf8'),
          ),
        ),
      )
    } catch (error) {
      if (!isMissing(error) && !hasCode(error, 'ENOENT')) throw error
    }
  }
  return records
}

/** Reclaim every child group owned by this data directory before logout or shutdown. */
export async function stopManagedProcesses(dataDirectory: string): Promise<void> {
  const records = [
    ...nodeRecords(dataDirectory),
    ...projectRecords(dataDirectory),
    ...(await probeRecords(dataDirectory)),
  ]
  for (const record of records) {
    const result = await reapProcessTree(record)
    if (!result.reaped && result.reason !== 'identity-mismatch')
      throw new Error('未能回收后台子进程树，请重试或重启设备后再注销')
  }
}
