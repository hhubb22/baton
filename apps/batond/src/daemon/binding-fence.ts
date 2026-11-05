import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Schema } from 'effect'
import { UUID } from '@baton/protocol'
import { readPrivateFile, writePrivateFileAtomic } from '../platform/private.ts'
import { hasCode } from '../platform/errors.ts'

const BindingFence = Schema.Struct({
  node_ids: Schema.Array(UUID),
  thread_ids: Schema.Array(UUID),
  execution_ids: Schema.Array(UUID),
  project_run_ids: Schema.Array(UUID),
})
export type BindingFence = typeof BindingFence.Type

export async function loadBindingFence(dataDirectory: string): Promise<BindingFence> {
  try {
    return Schema.decodeUnknownSync(BindingFence)(
      JSON.parse((await readPrivateFile(join(dataDirectory, 'retired-bindings.json'))).toString('utf8')),
    )
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return { node_ids: [], thread_ids: [], execution_ids: [], project_run_ids: [] }
    throw error
  }
}

/** Commit the binding barrier before replacing or deleting identity; retain all saved execution facts. */
export async function retireBinding(dataDirectory: string, nodeId?: string): Promise<void> {
  const previous = await loadBindingFence(dataDirectory)
  const threads = await readdir(join(dataDirectory, 'threads')).catch((error: unknown) => {
    if (hasCode(error, 'ENOENT')) return []
    throw error
  })
  const executions = await readdir(join(dataDirectory, 'executions')).catch((error: unknown) => {
    if (hasCode(error, 'ENOENT')) return []
    throw error
  })
  const projectRuns: string[] = []
  const projectFile = join(dataDirectory, 'project-runtime.db')
  try {
    if ((await stat(projectFile)).size) {
      const db = new DatabaseSync(projectFile, { readOnly: true })
      try {
        for (const row of db
          .prepare(
            "SELECT run_id FROM project_runtime_runs UNION SELECT json_extract(payload,'$.run_id') AS run_id FROM project_commands",
          )
          .all())
          projectRuns.push(Schema.decodeUnknownSync(UUID)(row.run_id))
      } finally {
        db.close()
      }
    }
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error
  }
  await writePrivateFileAtomic(
    join(dataDirectory, 'retired-bindings.json'),
    JSON.stringify({
      node_ids: [...new Set([...previous.node_ids, ...(nodeId ? [Schema.decodeUnknownSync(UUID)(nodeId)] : [])])],
      thread_ids: [...new Set([...previous.thread_ids, ...threads.filter(Schema.is(UUID))])],
      execution_ids: [...new Set([...previous.execution_ids, ...executions.filter(Schema.is(UUID))])],
      project_run_ids: [...new Set([...previous.project_run_ids, ...projectRuns])],
    }),
  )
}
