import { createHash } from 'node:crypto'
import { Effect, Predicate } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as P from '@baton/protocol'
import type { NodeSource } from '../errors.ts'
import { runtimeRequest } from '../project/runtime.ts'
import { transaction } from '../database.ts'

// 替身为每条新输出准备真实快照；重投递复用原输出的身份。
const contextualRequest = Effect.fnUntraced(function* (source: NodeSource, request: P.ProjectRuntimeRequest) {
  const payload = request.payload
  if (request.operation !== 'append_event' || !Predicate.isObject(payload) || 'memory_context_id' in payload)
    return yield* runtimeRequest(source, request)
  const sql = yield* SqlClient.SqlClient
  yield* sql`SELECT a.id FROM project_agents a JOIN agent_runs r ON r.agent_id=a.id WHERE r.id=${request.run_id} FOR NO KEY UPDATE OF a`
  const [row] = yield* sql<{
    input_seq: number
    context_id: string | null
  }>`SELECT (SELECT COALESCE(max(seq),0)::float8 FROM conversation_events WHERE conversation_id=c.id AND kind='input') AS input_seq,(SELECT payload->>'memory_context_id' FROM conversation_events WHERE conversation_id=c.id AND client_event_id=${request.client_event_id ?? ''}) AS context_id FROM agent_runs r JOIN conversations c ON c.agent_id=r.agent_id WHERE r.id=${request.run_id}`
  const key = createHash('sha256')
    .update(`${request.run_id}:${request.client_event_id}:${request.last_seq}`)
    .digest('hex')
  const contextId =
    row?.context_id ??
    `${key.slice(0, 8)}-${key.slice(8, 12)}-5${key.slice(13, 16)}-a${key.slice(17, 20)}-${key.slice(20, 32)}`
  if (!row?.context_id)
    yield* runtimeRequest(source, {
      ...request,
      operation: 'prepare_context',
      payload: { context_id: contextId, input_seq: row?.input_seq ?? 0, ...P.MEMORY_CONTEXT_DEFAULTS },
    })
  return yield* runtimeRequest(source, {
    ...request,
    payload: Object.assign({}, payload, { memory_context_id: contextId }),
  })
})
export const contextualRuntimeRequest = (source: NodeSource, request: P.ProjectRuntimeRequest) =>
  request.operation === 'append_event'
    ? transaction(contextualRequest(source, request))
    : runtimeRequest(source, request)
