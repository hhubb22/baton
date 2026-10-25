import { Effect, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as P from '@baton/protocol'
import { transaction } from '../database.ts'
import { decode, failure, readThread, type DB, type ThreadScope } from './core.ts'

const TraceCursor = Schema.Struct({
  scope: Schema.String,
  highwater_worker_seq: P.NonNegativeInteger,
  after: Schema.NullOr(Schema.Struct({ ordinal: P.NonNegativeInteger, worker_seq: P.PositiveInteger })),
})
const encodeCursor = (value: typeof TraceCursor.Type) => Buffer.from(JSON.stringify(value)).toString('base64url')
const decodeCursor = Effect.fnUntraced(function* (value: string | undefined, scope: string, highwater: number) {
  if (value === undefined) return { scope, highwater_worker_seq: highwater, after: null }
  return yield* Effect.try({
    try: () => {
      if (!value || value.length > 2048) throw 0
      const cursor = Schema.decodeUnknownSync(Schema.fromJsonString(TraceCursor))(
        Buffer.from(value, 'base64url').toString(),
      )
      if (
        cursor.scope !== scope ||
        cursor.highwater_worker_seq > highwater ||
        (cursor.after && cursor.after.worker_seq > cursor.highwater_worker_seq)
      )
        throw 0
      return cursor
    },
    catch: () => failure('invalid_cursor', 422),
  })
})

export const trace = (
  scope: ThreadScope,
  threadId: string,
  query: { worker_turn_seq: number; cursor?: string },
): DB<P.ThreadTrace> =>
  transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const thread = yield* readThread(scope.employeeId, threadId, false, scope.projectId)
      const turnSeq = yield* decode(P.PositiveInteger, query.worker_turn_seq)
      const cursorScope = JSON.stringify([scope.employeeId, threadId, turnSeq])
      const snapshot = yield* decodeCursor(query.cursor, cursorScope, thread.last_worker_seq)
      const pageCursor = encodeCursor(snapshot)
      const after = snapshot.after
      const turns =
        yield* sql`SELECT id FROM thread_turns WHERE employee_id=${scope.employeeId} AND thread_id=${threadId} AND worker_turn_seq=${turnSeq}`
      if (!turns.length) return yield* Effect.fail(failure('not_found', 404))
      // json 保留上游字符串中的 \u0000，读取时不经过 jsonb 转换。
      const rows = yield* sql<{
        value: P.ThreadTraceStep & { worker_seq: number }
      }>`SELECT row_to_json(i) AS value FROM thread_turn_items i
        WHERE employee_id=${scope.employeeId} AND thread_id=${threadId} AND worker_turn_seq=${turnSeq}
        AND worker_seq<=${snapshot.highwater_worker_seq}
        AND (${after?.ordinal ?? null}::bigint IS NULL OR (ordinal,worker_seq)>(${after?.ordinal ?? null}::bigint,${after?.worker_seq ?? null}::bigint))
        ORDER BY ordinal,worker_seq LIMIT 51`
      if (!rows.length) {
        const items = after
          ? yield* sql`SELECT item_id FROM thread_turn_items WHERE employee_id=${scope.employeeId} AND thread_id=${threadId} AND worker_turn_seq=${turnSeq} AND worker_seq<=${snapshot.highwater_worker_seq} LIMIT 1`
          : []
        return items.length
          ? { ok: true, steps: [], page_cursor: pageCursor }
          : { ok: false, code: 'trace_missing', steps: [], page_cursor: pageCursor }
      }
      const steps: P.ThreadTraceStep[] = []
      let nextCursor: string | undefined
      for (const row of rows.slice(0, 50)) {
        const { data, ...fields } = row.value
        const step = yield* decode(P.ThreadTraceStep, {
          ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null)),
          data,
        })
        const candidateCursor =
          rows.length > steps.length + 1
            ? encodeCursor({ ...snapshot, after: { ordinal: row.value.ordinal, worker_seq: row.value.worker_seq } })
            : undefined
        const candidate = {
          ok: true,
          steps: [...steps, step],
          page_cursor: pageCursor,
          ...(candidateCursor ? { next_cursor: candidateCursor } : {}),
        }
        if (Buffer.byteLength(JSON.stringify(candidate)) > 1024 * 1024) break
        steps.push(step)
        nextCursor = candidateCursor
      }
      if (!steps.length) return yield* Effect.fail(failure('trace_item_too_large', 422))
      return { ok: true, steps, page_cursor: pageCursor, ...(nextCursor ? { next_cursor: nextCursor } : {}) }
    }),
  )
