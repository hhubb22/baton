import { randomUUID } from 'node:crypto'
import { Effect, Schema } from 'effect'
import { SessionResult, type ThreadOutputQuery } from '@baton/protocol'
import * as Threads from './threads/index.ts'
import type { Gateway } from './gateway.ts'
import { AppError } from './errors.ts'

export const readThreadOutput = Effect.fn('Threads.readOutput')(function* (
  options: { readonly gateway: () => Pick<Gateway, 'request'> },
  employeeId: string,
  threadId: string,
  query: ThreadOutputQuery,
) {
  const thread = yield* Threads.view({ employeeId: employeeId }, threadId)
  const operationId = randomUUID()
  const failure = (code: string): SessionResult => ({
    type: 'session.result',
    operation_id: operationId,
    session_id: threadId,
    ok: false,
    code,
    gap: false,
  })
  if (!thread.node_online || !thread.node_synced) return failure(thread.node_online ? 'node_syncing' : 'node_offline')
  if (query.action === 'full_output' && (!query.output_id || !query.storage_generation))
    return yield* Effect.fail(new AppError(422, 'invalid_request'))
  const result = yield* Effect.tryPromise({
    try: async () =>
      Schema.decodeUnknownSync(SessionResult)(
        await options.gateway().request(thread.node_id, employeeId, {
          ...query,
          type: 'session.request',
          operation_id: operationId,
          session_id: threadId,
          action: query.action ?? 'output',
        }),
      ),
    catch: (error) => (error instanceof AppError ? error : new AppError(503, 'output_unavailable')),
  })
  if (result.operation_id !== operationId || result.session_id !== threadId)
    return yield* Effect.fail(new AppError(503, 'output_identity_mismatch'))
  if (
    query.action === 'full_output' &&
    result.ok &&
    (result.full_output === undefined ||
      result.full_output.output_id !== query.output_id ||
      result.full_output.storage_generation !== query.storage_generation)
  )
    return yield* Effect.fail(new AppError(503, 'output_identity_mismatch'))
  return result
})
