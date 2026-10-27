import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import type { BrowserEvent } from '@baton/protocol'

export const notifyThreadChanged = Effect.fnUntraced(function* (
  employeeId: string,
  threadId: string,
  notify: (event: BrowserEvent) => void,
) {
  const sql = yield* SqlClient.SqlClient
  const [thread] = yield* sql<{ project_id: string | null }>`SELECT project_id FROM threads
    WHERE employee_id=${employeeId} AND id=${threadId}`
  notify({ type: 'thread.changed', thread_id: threadId, change: 'detail' })
  if (thread?.project_id) notify({ type: 'project.changed', project_id: thread.project_id, change: 'detail' })
})
