import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as P from '@baton/protocol'
import { expect, it } from 'vite-plus/test'
import { withTestDatabase } from '../testing/database.ts'
import { projectToolFixture } from '../testing/project-tools.ts'
import { transaction } from '../database.ts'
import { changeProjectMemory, recallProjectMemory, saveSource, writeProjectMemory } from './memory/index.ts'

// 人工固定语料，预期事实由测试直接指定；检索完全在本机 PostgreSQL 与应用进程中执行。
it('recalls mixed Chinese, aliases and exact identifiers, bounds long hits, and filters stale projections', async () =>
  withTestDatabase(async (db) => {
    const { context: c } = await projectToolFixture(db)
    const add = (title: string, content: string, topic = '') =>
      db.run(
        writeProjectMemory(c.employeeId, c.projectId, undefined, {
          operation_id: randomUUID(),
          expected_revision: 0,
          title,
          content,
          topic,
        }),
      )
    const deployment = await add('部署测试', '部署前运行 pnpm test；测试失败时不要发布。', '发布 deployment')
    const exact = await add('foo_bar /src/runtime.ts', '技术标识符必须按原文保存。')
    await add('foo bar src runtime ts', '普通拆分词也可以匹配。')
    await add('Other', '不相关的配色要求。')
    for (const query of ['部署测试', 'deployment', 'ＦＯＯ＿ＢＡＲ', '/src/runtime.ts']) {
      const result = await db.run(recallProjectMemory(c.employeeId, c.projectId, { query }))
      expect(result.no_match).toBe(false)
      expect(
        result.entries.some(
          (h) => h.item?.id === (query.includes('部署') || query === 'deployment' ? deployment.id : exact.id),
        ),
      ).toBe(true)
      expect(P.MemoryRecallResult.make(result)).toEqual(result)
    }
    const precise = await db.run(recallProjectMemory(c.employeeId, c.projectId, { query: 'foo_bar' }))
    expect(precise.entries.filter((h) => h.item)[0]!.item!.id).toBe(exact.id)
    // array_to_tsvector 没有位置信息，候选直接消费规范 lexeme。
    const [counts] = await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{
          exact: number
          reparsed: number
        }>`SELECT count(*) FILTER(WHERE terms @@ ${"'foo_bar'"}::tsquery)::float8 AS exact,count(*) FILTER(WHERE terms @@ to_tsquery('simple',${"'foo_bar'"}))::float8 AS reparsed FROM project_memory_search_documents WHERE project_id=${c.projectId} AND item_id IS NOT NULL`
      }),
    )
    expect(counts).toEqual({ exact: 1, reparsed: 0 })
    const long = await add('Long', 'longNeedle ' + '完整技术记录。'.repeat(2000))
    const bounded = await db.run(
      recallProjectMemory(c.employeeId, c.projectId, { query: 'longNeedle', max_bytes: 2048 }),
    )
    const hit = bounded.entries.find((h) => h.item?.id === long.id)!
    expect(hit).toMatchObject({ snippet_truncated: true, item: { read_tool: 'memory.read', revision: 1 } })
    expect(hit.snippet).toContain('longNeedle')
    expect(hit.item!.evidence).toHaveLength(1)
    expect(Buffer.byteLength(JSON.stringify(bounded, null, 1))).toBeLessThanOrEqual(2048)
    expect(bounded.result_truncated).toBe(true)
    await db.run(
      changeProjectMemory(c.employeeId, c.projectId, deployment.id, {
        operation_id: randomUUID(),
        expected_revision: 1,
        action: 'retire',
      }),
    )
    // 即使有人恢复旧索引词项，规范状态仍阻止旧值进入当前结果。
    expect((await db.run(recallProjectMemory(c.employeeId, c.projectId, { query: '部署测试' }))).entries).toEqual([])
    const historical = await db.run(
      recallProjectMemory(c.employeeId, c.projectId, { query: '部署测试', mode: 'history', include_inactive: true }),
    )
    expect(historical.entries.find((h) => h.item?.id === deployment.id)!.item!.status).toBe('retired')
    expect(historical.entries.some((h) => h.source?.suppressed)).toBe(true)
    const missing = await db.run(recallProjectMemory(c.employeeId, c.projectId, { query: 'nothingmatches' }))
    expect(missing).toMatchObject({ entries: [], no_match: true, candidate_truncated: false })
    expect(
      (await db.run(recallProjectMemory(c.employeeId, c.projectId, { query: 'a '.repeat(2000) }))).query_truncated,
    ).toBe(true)
    await expect(db.run(recallProjectMemory(randomUUID(), c.projectId, { query: '部署' }))).rejects.toMatchObject({
      code: 'not_found',
    })
  }))

it('selects facts by current and historical intervals and exposes bounded source byte ranges', async () =>
  withTestDatabase(async (db) => {
    const { context: c } = await projectToolFixture(db)
    const old = await db.run(
      writeProjectMemory(c.employeeId, c.projectId, undefined, {
        operation_id: randomUUID(),
        expected_revision: 0,
        title: '数据库',
        content: 'database 使用 A',
        semantic_key: 'database',
        valid_from: '2000-01-01T00:00:00Z',
      }),
    )
    const next = await db.run(
      changeProjectMemory(c.employeeId, c.projectId, old.id, {
        operation_id: randomUUID(),
        expected_revision: 1,
        action: 'supersede',
        successor: {
          title: '数据库',
          content: 'database 使用 B',
          semantic_key: 'database',
          valid_from: '2001-01-01T00:00:00Z',
        },
      }),
    )
    const current = await db.run(recallProjectMemory(c.employeeId, c.projectId, { query: 'database' }))
    expect(current.entries.filter((h) => h.item).map((h) => h.item!.id)).toEqual([next.id])
    const past = await db.run(
      recallProjectMemory(c.employeeId, c.projectId, {
        query: 'database',
        mode: 'history',
        as_of: '2000-06-01T00:00:00Z',
      }),
    )
    expect(past.entries.filter((h) => h.item).map((h) => h.item!.id)).toEqual([old.id])
    const sourceId = await db.run(
      transaction(
        saveSource(
          c.employeeId,
          c.projectId,
          'manual-source',
          'user_message',
          'user',
          '段落证据 sourceNeedle\n\n' + '后续资料。'.repeat(2000),
          1,
        ),
      ),
    )
    const source = (
      await db.run(recallProjectMemory(c.employeeId, c.projectId, { query: 'sourceNeedle' }))
    ).entries.find((h) => h.source?.source_id === sourceId)!
    expect(source.source!.start_byte).toBe(0)
    expect(source.source!.end_byte).toBe(Buffer.byteLength(source.snippet))
    expect(source.snippet).toContain('sourceNeedle')
  }))

it('reports candidate truncation without loading an unbounded source corpus', async () =>
  withTestDatabase(async (db) => {
    const { context: c } = await projectToolFixture(db)
    await db.run(
      transaction(
        Effect.gen(function* () {
          for (let i = 0; i < 514; i++)
            yield* saveSource(
              c.employeeId,
              c.projectId,
              'bounded:' + i,
              'user_message',
              'user',
              'candidateNeedle ' + i,
              1,
            )
        }),
      ),
    )
    const result = await db.run(
      recallProjectMemory(c.employeeId, c.projectId, { query: 'candidateNeedle', max_results: 2 }),
    )
    expect(result).toMatchObject({ candidate_truncated: true, result_truncated: true, no_match: false })
    expect(result.entries).toHaveLength(2)
  }))
