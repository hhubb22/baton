import { randomUUID } from 'node:crypto'
import { Effect, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { expect, it } from 'vite-plus/test'
import * as P from '@baton/protocol'
import { withTestDatabase, type TestDatabase } from '../testing/database.ts'
import { callProjectTool, projectToolFixture } from '../testing/project-tools.ts'
import { resultBytes } from '../project/tools.ts'
import * as threads from './index.ts'

async function fixture(db: TestDatabase) {
  const { context, source } = await projectToolFixture(db)
  const created = await db.run(
    callProjectTool(context, 'threads.create', {
      node_id: source.node_id,
      agent_type: 'cursor',
      working_directory: '/work/repo',
      message: 'Inspect the project',
    }),
  )
  const { thread_id: threadId } = created.value as { thread_id: string }
  const scope = { employeeId: context.employeeId, projectId: context.projectId }
  const view = await db.run(threads.view(scope, threadId))
  let seq = 0
  const report = (kind: P.ThreadReport['kind'], extra: Partial<P.ThreadReport> = {}): P.ThreadReport => ({
    type: 'thread.report',
    thread_id: threadId,
    event_id: randomUUID(),
    worker_seq: ++seq,
    storage_generation: 'generation',
    kind,
    ...extra,
  })
  await db.run(threads.processReport(source, report('thread.opened')))
  await db.run(
    threads.processReport(
      source,
      report('turn.started', {
        worker_turn_seq: 1,
        client_message_id: view.pending_messages![0]!.client_message_id,
      }),
    ),
  )
  const itemReport = (item: P.ThreadTurnItem, extra: Partial<P.ThreadReport> = {}) =>
    report('turn.item', {
      worker_turn_seq: 1,
      item,
      truncated: false,
      original_bytes: Buffer.byteLength(JSON.stringify(item)),
      ...extra,
    })
  return { context, source, scope, threadId, report, itemReport }
}
const item = (id: string, ordinal = 0, data: P.ThreadTurnItem['data'] = {}): P.ThreadTurnItem => ({
  id,
  ordinal,
  type: 'command_execution',
  status: 'completed',
  data,
})
const stats = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ events: number; inputs: number; items: number }>`SELECT
    (SELECT count(*)::integer FROM thread_events WHERE thread_id=${threadId}) AS events,
    (SELECT count(*)::integer FROM project_agent_input_queue WHERE payload->>'thread_id'=${threadId}) AS inputs,
    (SELECT count(*)::integer FROM thread_turn_items WHERE thread_id=${threadId}) AS items`
    return row!
  })

it('persists first item versions across restart, fences sequence gaps and preserves raw JSON offline', () =>
  withTestDatabase(async (db) => {
    const f = await fixture(db)
    const before = await db.run(stats(f.threadId))
    const fullOutput: P.FullOutputReference = {
      id: randomUUID(),
      storage_generation: 'generation',
      total_bytes: 300000,
      expires_at: '2030-01-01T00:00:00.000Z',
    }
    const raw = { input: 'printf \\0', output: 'a\u0000b\ud800', nested: { nil: null } }
    const first = f.itemReport(
      {
        ...item('first', 3, raw),
        parent_id: 'parent',
        title: 'Inspect',
        started_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-01T00:00:01.000Z',
      },
      { truncated: true, original_bytes: 300000, metadata: { full_output: fullOutput } },
    )
    await expect(
      db.run(
        threads.processReport(f.source, {
          ...first,
          metadata: { full_output: { ...fullOutput, storage_generation: 'other-generation' } },
        }),
      ),
    ).rejects.toMatchObject({ status: 409, code: 'storage_generation_mismatch' })
    expect(await db.run(stats(f.threadId))).toEqual(before)
    const firstAck = await db.run(threads.processReport(f.source, first))
    const second = f.itemReport(item('second', 1, null))
    await db.run(threads.processReport(f.source, second))
    const recovered = await db.restart()
    expect(await recovered(threads.processReport(f.source, first))).toEqual(firstAck)
    await expect(recovered(threads.processReport(f.source, { ...first, item: item('changed') }))).rejects.toMatchObject(
      { status: 409 },
    )
    await recovered(threads.processReport(f.source, f.itemReport(item('first', 0, { changed: true }))))
    expect(await recovered(stats(f.threadId))).toEqual({ ...before, items: 2 })
    const ended = f.report('turn.ended', {
      worker_turn_seq: 1,
      reason: 'completed',
      queue_empty: true,
      token_usage: { input: 123, output: 45, provider: { extra: null, raw: '\u0000\ud800' } },
    })
    expect(
      await recovered(threads.processReport(f.source, { ...ended, worker_seq: ended.worker_seq + 1 })),
    ).toMatchObject({ ok: false, code: 'worker_sequence_gap', expected_worker_seq: ended.worker_seq })
    expect((await recovered(threads.readTurns(f.scope, f.threadId))).turns[0]).not.toHaveProperty('ended_at')
    await recovered(threads.processReport(f.source, ended))
    const history = await recovered(threads.readTurns(f.scope, f.threadId))
    expect(history.turns[0]).toMatchObject({ item_count: 2, token_usage: ended.token_usage })
    expect(history.turns[0]).not.toHaveProperty('employee_id')
    const timeline = await recovered(threads.timeline(f.context.employeeId, f.threadId))
    expect(timeline.events!.some((event) => event.kind === 'turn.item')).toBe(false)
    expect(timeline.events!.find((event) => event.kind === 'turn.ended')?.payload).toMatchObject({ item_count: 2 })
    await expect(recovered(threads.processReport(f.source, f.itemReport(item('late'))))).rejects.toMatchObject({
      status: 409,
    })
    await recovered(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE node_presence SET online=false,synced=false WHERE node_id=${f.source.node_id}`
      }),
    )
    const trace = Schema.decodeUnknownSync(P.ThreadTrace)(
      await recovered(threads.trace(f.scope, f.threadId, { worker_turn_seq: 1 })),
    )
    expect(trace.steps!.map((step) => step.item_id)).toEqual(['second', 'first'])
    expect(trace.steps![0]!.data).toBeNull()
    expect(trace.steps![1]).toEqual({
      item_id: 'first',
      type: first.item!.type,
      status: first.item!.status,
      ordinal: 3,
      parent_id: 'parent',
      title: 'Inspect',
      started_at: expect.any(String),
      completed_at: expect.any(String),
      data: raw,
      truncated: true,
      original_bytes: 300000,
      full_output: fullOutput,
    })
    await expect(recovered(threads.trace(f.scope, f.threadId, { worker_turn_seq: 2 }))).rejects.toMatchObject({
      status: 404,
    })
    await expect(
      recovered(threads.trace({ employeeId: randomUUID() }, f.threadId, { worker_turn_seq: 1 })),
    ).rejects.toMatchObject({ status: 404 })
    await expect(
      recovered(threads.trace({ ...f.scope, projectId: randomUUID() }, f.threadId, { worker_turn_seq: 1 })),
    ).rejects.toMatchObject({ status: 404 })
  }))

it.each([false, true])('keeps a timeline trace entry after history loss (reply=%s)', (withReply) =>
  withTestDatabase(async (db) => {
    const f = await fixture(db)
    await db.run(threads.processReport(f.source, f.itemReport(item('saved', 0, { input: 'pwd', output: '/repo' }))))
    if (withReply) {
      await db.run(threads.processReport(f.source, f.report('reply', { worker_turn_seq: 1, content: 'Saved reply' })))
    }
    const recovery = f.report('thread.unknown', { history_unavailable: true, reason: 'Device ledger is missing' })
    const ack = await db.run(threads.processReport(f.source, recovery))
    expect(await db.run(threads.processReport(f.source, recovery))).toEqual(ack)
    const timeline = await db.run(threads.timeline(f.context.employeeId, f.threadId))
    const ended = timeline.events!.filter((event) => event.kind === 'turn.ended')
    expect(ended).toHaveLength(1)
    expect(ended[0]!.payload).toMatchObject({
      worker_turn_seq: 1,
      item_count: 1,
      reason: 'agent_exited',
      history_unavailable: true,
    })
    expect(timeline.events!.filter((event) => event.kind === 'reply')).toHaveLength(withReply ? 1 : 0)
    const trace = await db.run(threads.trace(f.scope, f.threadId, { worker_turn_seq: 1 }))
    expect(trace.steps!.map((step) => step.item_id)).toEqual(['saved'])
    expect((await db.run(threads.readTurns(f.scope, f.threadId))).turns[0]).toMatchObject({
      item_count: 1,
      end_reason: 'agent_exited',
    })
  }),
)

it('paginates 120 items by ordinal and worker sequence within 50 items and 1 MiB without gaps', () =>
  withTestDatabase(async (db) => {
    const f = await fixture(db)
    const empty = await db.run(threads.trace(f.scope, f.threadId, { worker_turn_seq: 1 }))
    expect(empty).toEqual({
      ok: false,
      code: 'trace_missing',
      steps: [],
      page_cursor: expect.any(String),
    })
    const expected: P.ThreadTurnItem[] = []
    for (let i = 0; i < 120; i++) {
      const ordinal = Math.floor((119 - i) / 2)
      const value = item(`item-${i}`, ordinal, { output: ordinal < 3 ? '汉'.repeat(60000) : `output-${i}` })
      expected.push(value)
      await db.run(threads.processReport(f.source, f.itemReport(value)))
    }
    expect(
      await db.run(
        threads.trace(f.scope, f.threadId, {
          worker_turn_seq: 1,
          cursor: empty.page_cursor,
        }),
      ),
    ).toEqual(empty)
    const ids: string[] = []
    const pages: number[] = []
    let cursor: string | undefined
    do {
      const page = await db.run(
        threads.trace(f.scope, f.threadId, {
          worker_turn_seq: 1,
          ...(cursor ? { cursor } : {}),
        }),
      )
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1024 * 1024)
      expect(page.steps!.length).toBeLessThanOrEqual(50)
      ids.push(...page.steps!.map((step) => step.item_id))
      pages.push(page.steps!.length)
      cursor = page.next_cursor
      if (pages.length === 1) {
        expect(page.steps!.length).toBeLessThan(50)
        expect(cursor).toBeTruthy()
        await expect(
          db.run(threads.trace(f.scope, f.threadId, { worker_turn_seq: 2, cursor: cursor! })),
        ).rejects.toMatchObject({ code: 'invalid_cursor' })
        await db.run(threads.processReport(f.source, f.itemReport(item('late-low', 0))))
        await db.run(threads.processReport(f.source, f.itemReport(item('late-high', 1000))))
        const recovered = await db.restart()
        expect(
          JSON.stringify(
            await recovered(
              threads.trace(f.scope, f.threadId, {
                worker_turn_seq: 1,
                cursor: page.page_cursor,
              }),
            ),
          ),
        ).toBe(JSON.stringify(page))
        const future = JSON.parse(Buffer.from(cursor!, 'base64url').toString())
        future.highwater_worker_seq = Number.MAX_SAFE_INTEGER
        await expect(
          db.run(
            threads.trace(f.scope, f.threadId, {
              worker_turn_seq: 1,
              cursor: Buffer.from(JSON.stringify(future)).toString('base64url'),
            }),
          ),
        ).rejects.toMatchObject({ code: 'invalid_cursor' })
        const altered = JSON.parse(Buffer.from(cursor!, 'base64url').toString())
        altered.after.ordinal = -1
        await expect(
          db.run(
            threads.trace(f.scope, f.threadId, {
              worker_turn_seq: 1,
              cursor: Buffer.from(JSON.stringify(altered)).toString('base64url'),
            }),
          ),
        ).rejects.toMatchObject({ code: 'invalid_cursor' })
      }
    } while (cursor)
    expect(pages).toContain(50)
    expect(ids).toEqual(expected.sort((a, b) => a.ordinal - b.ordinal).map((value) => value.id))
    expect(new Set(ids).size).toBe(120)
    const refreshed: string[] = []
    do {
      const page = await db.run(
        threads.trace(f.scope, f.threadId, {
          worker_turn_seq: 1,
          ...(cursor ? { cursor } : {}),
        }),
      )
      refreshed.push(...page.steps!.map((step) => step.item_id))
      cursor = page.next_cursor
    } while (cursor)
    expect(new Set(refreshed).size).toBe(122)
    expect(refreshed).toEqual(expect.arrayContaining(['late-low', 'late-high', ...ids]))
    await expect(
      db.run(threads.trace(f.scope, f.threadId, { worker_turn_seq: 1, cursor: 'bad' })),
    ).rejects.toMatchObject({ code: 'invalid_cursor' })
  }))

it('wraps Project trace pages in bounded JSON fragments and enforces employee and Project access', () =>
  withTestDatabase(async (db) => {
    const f = await fixture(db)
    for (let i = 0; i < 6; i++) {
      await db.run(threads.processReport(f.source, f.itemReport(item(`large-${i}`, i, { output: '文'.repeat(60000) }))))
    }
    let offset = 0
    let text = ''
    let n = 0
    const args = { thread_id: f.threadId, worker_turn_seq: 1, max_bytes: 32768 }
    expect(
      await db.run(
        callProjectTool({ ...f.context, toolCallId: 'missing-snapshot' }, 'threads.trace', {
          ...args,
          offset: 1,
        }),
      ),
    ).toMatchObject({ isError: true, value: { code: 'snapshot_cursor_required' } })
    let pageCursor: string | undefined
    let originalJSON = ''
    let truncated: boolean
    do {
      const response = await db.run(
        callProjectTool({ ...f.context, toolCallId: `trace-${++n}` }, 'threads.trace', {
          ...args,
          offset,
          ...(pageCursor ? { cursor: pageCursor } : {}),
        }),
      )
      expect(response.isError).toBeUndefined()
      expect(resultBytes(response.value)).toBeLessThanOrEqual(32768)
      const page = response.value as {
        encoding: string
        text: string
        offset: number
        truncated: boolean
        next_offset?: number
        page_cursor: string
      }
      if (pageCursor === undefined) {
        pageCursor = page.page_cursor
        originalJSON = JSON.stringify(
          await db.run(
            threads.trace(f.scope, f.threadId, {
              worker_turn_seq: 1,
              cursor: pageCursor,
            }),
          ),
        )
        await db.run(threads.processReport(f.source, f.itemReport(item('late-small', 0))))
      }
      expect(page.page_cursor).toBe(pageCursor)
      expect(page.encoding).toBe('json')
      expect(page.offset).toBe(offset)
      text += page.text
      truncated = page.truncated
      offset = page.next_offset ?? offset
    } while (truncated)
    expect(text).toBe(originalJSON)
    const trace = Schema.decodeUnknownSync(P.ThreadTrace)(JSON.parse(text))
    expect(trace.page_cursor).toBe(pageCursor)
    expect(trace.steps).toHaveLength(5)
    expect(trace.next_cursor).toBeTruthy()
    text = ''
    offset = 0
    do {
      const next = await db.run(
        callProjectTool({ ...f.context, toolCallId: `next-trace-${++n}` }, 'threads.trace', {
          ...args,
          cursor: trace.next_cursor,
          offset,
        }),
      )
      const fragment = next.value as { text: string; truncated: boolean; next_offset?: number }
      text += fragment.text
      truncated = fragment.truncated
      offset = fragment.next_offset ?? offset
    } while (truncated)
    expect(Schema.decodeUnknownSync(P.ThreadTrace)(JSON.parse(text)).steps![0]!.item_id).toBe('large-5')
    const read = await db.run(
      callProjectTool({ ...f.context, toolCallId: 'read-count' }, 'threads.read', { thread_id: f.threadId }),
    )
    expect(JSON.parse((read.value as { text: string }).text).turns[0].item_count).toBe(7)
    for (const existing of [undefined, f.context]) {
      const other = await projectToolFixture(db, existing)
      expect(await db.run(callProjectTool(other.context, 'threads.trace', args))).toMatchObject({
        isError: true,
        value: { code: 'not_found' },
      })
    }
    expect(
      await db.run(
        callProjectTool({ ...f.context, toolCallId: 'strict-trace' }, 'threads.trace', {
          ...args,
          employee_id: f.context.employeeId,
        }),
      ),
    ).toMatchObject({ isError: true })
  }))
