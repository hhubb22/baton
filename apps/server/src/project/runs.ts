import { randomUUID } from 'node:crypto'
import { Effect, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import {
  ProjectRunSummary,
  ProjectRunTranscriptResult,
  ProjectRunsResponse,
  TranscriptPage,
  UUID,
  type ProjectRunTranscriptRequest,
} from '@baton/protocol'
import { AppError } from '../errors.ts'
import type { Gateway } from '../gateway.ts'
import { projectDecode, projectTransaction, readProject } from './store.ts'

export const projectRuns = Effect.fn('Project.runs')(function* (employeeId: string, projectId: string, limit = 50) {
  return yield* projectTransaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`
      yield* projectDecode(UUID, projectId)
      yield* readProject(employeeId, projectId)
      const rows = yield* sql<{ value: unknown }>`SELECT jsonb_build_object(
 'run_id',r.id,'node_id',r.node_id,
 'kind',CASE WHEN r.memory_job_id IS NULL THEN 'foreground' ELSE 'memory' END,
 'memory_job_id',r.memory_job_id,'memory_kind',j.kind,'state',r.state,'provider',r.provider,'model',r.model,
 'started_at',r.started_at,'ended_at',r.ended_at,
 'error_code',CASE WHEN r.state IN ('failed','lost') THEN r.end_reason ELSE NULL END) AS value
 FROM agent_runs r JOIN project_agents a ON a.id=r.agent_id AND a.employee_id=r.employee_id
 LEFT JOIN project_memory_jobs j ON j.id=r.memory_job_id
 WHERE a.project_id=${projectId} AND r.employee_id=${employeeId}
 ORDER BY r.started_at DESC,r.id DESC LIMIT ${Math.max(1, Math.min(100, Math.trunc(limit)))}`
      const runs = []
      for (const row of rows) runs.push(yield* projectDecode(ProjectRunSummary, row.value))
      return yield* projectDecode(ProjectRunsResponse, { runs })
    }),
  )
})

export const projectRunTranscript = Effect.fn('Project.runTranscript')(function* (
  gateway: Pick<Gateway, 'request'>,
  employeeId: string,
  projectId: string,
  runId: string,
  offset?: number,
) {
  yield* projectDecode(UUID, projectId)
  yield* projectDecode(UUID, runId)
  yield* readProject(employeeId, projectId)
  const sql = yield* SqlClient.SqlClient
  const [run] = yield* sql<{ node_id: string }>`SELECT r.node_id FROM agent_runs r
 JOIN project_agents a ON a.id=r.agent_id AND a.employee_id=r.employee_id
 WHERE r.id=${runId} AND r.employee_id=${employeeId} AND a.project_id=${projectId}`
  if (!run) return yield* Effect.fail(new AppError(404, 'run_not_found'))
  const operationId = randomUUID()
  const request: ProjectRunTranscriptRequest = {
    type: 'project_run_transcript',
    operation_id: operationId,
    project_id: projectId,
    run_id: runId,
    ...(offset === undefined ? {} : { offset }),
  }
  const result = yield* Effect.tryPromise({
    try: async () =>
      Schema.decodeUnknownSync(ProjectRunTranscriptResult)(await gateway.request(run.node_id, employeeId, request)),
    catch: (error) =>
      error instanceof AppError
        ? error.code === 'node_offline' || error.code === 'node_syncing'
          ? new AppError(409, 'device_offline', '设备当前离线，运行记录暂不可取回')
          : error
        : new AppError(503, 'transcript_unavailable'),
  })
  if (result.operation_id !== operationId) return yield* Effect.fail(new AppError(503, 'transcript_identity_mismatch'))
  if (!result.ok || !result.transcript) {
    const code = result.code ?? 'transcript_unavailable'
    return yield* Effect.fail(
      new AppError(code === 'transcript_missing' ? 404 : code === 'transcript_expired' ? 410 : 503, code),
    )
  }
  return Schema.decodeUnknownSync(TranscriptPage)(result.transcript)
})
