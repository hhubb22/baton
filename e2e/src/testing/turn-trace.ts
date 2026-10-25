import { Effect, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { expect } from 'vite-plus/test'
import * as P from '@baton/protocol'
import type { openTestDatabase } from '@baton/server/testing/database'

type Request = (path: string) => Promise<{ status: number; body: unknown }>

export async function readTurnTrace(request: Request, threadId: string, workerTurnSeq = 1) {
  const steps: P.ThreadTraceStep[] = []
  let cursor: string | undefined
  const cursors = new Set<string>()
  do {
    const query = new URLSearchParams({ worker_turn_seq: String(workerTurnSeq), ...(cursor ? { cursor } : {}) })
    const response = await request(`/threads/${threadId}/trace?${query.toString()}`)
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    const page = Schema.decodeUnknownSync(P.ThreadTrace)(response.body)
    expect(page.ok, page.code).toBe(true)
    expect(page.page_cursor.length).toBeGreaterThan(0)
    expect(page.steps).not.toBeNull()
    expect(page.steps!.length).toBeLessThanOrEqual(50)
    steps.push(...page.steps!)
    cursor = page.next_cursor
    if (cursor) {
      expect(cursors.has(cursor), 'trace cursor must advance').toBe(false)
      cursors.add(cursor)
    }
  } while (cursor)
  return steps
}

export async function assertStoredTurnTrace({
  database,
  request,
  threadId,
  workerTurnSeq = 1,
  expectedItems,
  tokenUsage,
  beforeReply = false,
}: {
  database: Awaited<ReturnType<typeof openTestDatabase>>
  request: Request
  threadId: string
  workerTurnSeq?: number
  expectedItems: ReadonlyArray<{ type: string; text: string; status?: string }>
  tokenUsage?: { inputTokens: number; outputTokens: number }
  beforeReply?: boolean
}) {
  const saved = await database.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const items = yield* sql<{
        worker_seq: number
        step: P.ThreadTraceStep
      }>`SELECT worker_seq::float8 AS worker_seq,row_to_json(i) AS step
        FROM thread_turn_items i WHERE thread_id=${threadId} AND worker_turn_seq=${workerTurnSeq}
        ORDER BY ordinal,worker_seq`
      const turns = yield* sql<{ token_usage: typeof Schema.Json.Type | null }>`SELECT token_usage FROM thread_turns
        WHERE thread_id=${threadId} AND worker_turn_seq=${workerTurnSeq} AND ended_at IS NOT NULL`
      const endings = yield* sql<{
        payload: { worker_seq: number; item_count: number }
      }>`SELECT payload FROM thread_events
        WHERE thread_id=${threadId} AND kind='turn.ended' AND (payload->>'worker_turn_seq')::bigint=${workerTurnSeq}`
      const replies = yield* sql<{ worker_seq: number }>`SELECT worker_seq::float8 AS worker_seq FROM thread_replies
        WHERE thread_id=${threadId} AND worker_turn_seq=${workerTurnSeq} ORDER BY worker_seq`
      const timelineItems = yield* sql`SELECT id FROM thread_events WHERE thread_id=${threadId} AND kind='turn.item'`
      return {
        items: items.map(({ worker_seq, step }) => {
          const { data, ...fields } = step
          return {
            worker_seq,
            step: Schema.decodeUnknownSync(P.ThreadTraceStep)({
              ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null)),
              data,
            }),
          }
        }),
        turns,
        endings,
        replies,
        timelineItems,
      }
    }),
  )
  expect(saved.turns).toHaveLength(1)
  expect(saved.endings).toHaveLength(1)
  expect(saved.replies.length).toBeGreaterThan(0)
  expect(saved.timelineItems).toEqual([])
  expect(saved.items.length).toBeGreaterThan(0)
  expect(new Set(saved.items.map(({ step }) => step.item_id)).size).toBe(saved.items.length)
  const ended = saved.endings[0]!.payload
  expect(ended.item_count).toBe(saved.items.length)
  for (const reply of saved.replies) expect(reply.worker_seq).toBeLessThan(ended.worker_seq)
  for (const { worker_seq, step } of saved.items) {
    expect(worker_seq).toBeLessThan(ended.worker_seq)
    expect(['assistant_message', 'user_message']).not.toContain(step.type)
    const expectedStatus = expectedItems.find((expected) => expected.type === step.type)?.status ?? 'completed'
    expect(step.status, step.type).toBe(expectedStatus)
    expect(step.truncated).toBe(false)
    expect(step.original_bytes).toBeGreaterThan(0)
    if (beforeReply) expect(worker_seq).toBeLessThan(saved.replies[0]!.worker_seq)
  }
  for (const expected of expectedItems) {
    const matching = saved.items.filter(({ step }) => step.type === expected.type)
    expect(matching.length, expected.type).toBeGreaterThan(0)
    expect(JSON.stringify(matching.map(({ step }) => step.data))).toContain(expected.text)
  }
  if (tokenUsage) {
    expect(saved.turns[0]!.token_usage).toMatchObject(tokenUsage)
  }
  const steps = await readTurnTrace(request, threadId, workerTurnSeq)
  expect(steps).toHaveLength(saved.items.length)
  steps.forEach((step, index) => expect(step).toMatchObject(saved.items[index]!.step))
  return steps
}
