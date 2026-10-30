import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import type { Thread } from '@baton/protocol'
import { transaction } from '../database.ts'
import type { ThreadScope } from './core.ts'

export const listProjectThreads = (
  scope: ThreadScope & { projectId: string },
  query: { afterId?: string; status?: Thread['status'] } = {},
) =>
  transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{
        id: string
        value: {
          thread_id: string
          node_id: string
          agent_type: string
          runtime_mode: Thread['runtime_mode']
          working_directory: string
          status: Thread['status']
          last_activity_at: string
        }
      }>`SELECT id,jsonb_build_object('thread_id',id,'node_id',node_id,'agent_type',agent_type,'runtime_mode',runtime_mode,
    'working_directory',working_directory,'status',status,'last_activity_at',last_activity_at) AS value FROM threads
    WHERE employee_id=${scope.employeeId} AND project_id=${scope.projectId}
    AND (${query.afterId ?? null}::uuid IS NULL OR id>${query.afterId ?? null})
    AND (${query.status ?? null}::text IS NULL OR status=${query.status ?? null}) ORDER BY id LIMIT 20`
      return { threads: rows.map((r) => r.value), next_after_id: rows.at(-1)?.id ?? '' }
    }),
  )
