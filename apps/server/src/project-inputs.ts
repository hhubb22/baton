import { createHash } from 'node:crypto'
import { Effect, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { activeInputSQL, checkPayloadSize, projectDecode, projectError } from './project-store.ts'

export const ProjectInputType = Schema.Literals([
  'user_message',
  'attention_answer',
  'turn_ended',
  'thread_message_failed',
  'thread_reply',
  'memory_updated',
  'project_updated',
])
export const insertProjectInput = Effect.fn('insertProjectInput')(function* (
  employeeId: string,
  agentId: string,
  sourceType: string,
  sourceKey: string,
  payload: unknown,
) {
  const kind = yield* projectDecode(ProjectInputType, sourceType)
  const sql = yield* SqlClient.SqlClient
  const command = yield* projectDecode(Schema.Record(Schema.String, Schema.Unknown), payload)
  const limits = {
    user_message: 72,
    attention_answer: 32,
    turn_ended: 'command_result' in command ? 72 : 4,
    thread_message_failed: 40,
    thread_reply: 40,
    memory_updated: 1,
    project_updated: 4,
  }
  yield* checkPayloadSize(payload, limits[kind] * 1024)
  if (!sourceKey || sourceKey.includes('\0')) return yield* Effect.fail(projectError('invalid', 422))
  const raw = JSON.stringify(payload)
  yield* sql`INSERT INTO project_agent_input_queue(employee_id,agent_id,source_type,source_key,payload,payload_hash,wake_required)
 VALUES(${employeeId},${agentId},${kind},${sourceKey},${raw}::jsonb,${createHash('sha256').update(raw).digest()},${kind} IN ${activeInputSQL(sql)})
 ON CONFLICT(agent_id,source_key) DO NOTHING`
})
