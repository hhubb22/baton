import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { expect, it } from 'vite-plus/test'
import { projectToolFixture, callProjectTool } from '../testing/project-tools.ts'
import { withTestDatabase } from '../testing/database.ts'
import { transaction } from '../database.ts'
import {
  applyChange,
  changeProjectMemory,
  getMemorySource,
  getProjectMemory,
  listProjectMemory,
  projectMemoryIndex,
  projectMemoryRevisions,
  writeProjectMemory,
  hashText,
  registerEventSource,
} from './memory/index.ts'

const write = (content: string, revision = 0) => ({
  operation_id: randomUUID(),
  title: 'Tests',
  content,
  expected_revision: revision,
})

it('serializes employee edits, preserves drafts through conflict responses, deduplicates operations and isolates all reads', async () =>
  withTestDatabase(async (db) => {
    const { context: c } = await projectToolFixture(db)
    const id = randomUUID(),
      input = write('Run pnpm test')
    const first = await db.run(writeProjectMemory(c.employeeId, c.projectId, id, input))
    expect(first).toMatchObject({
      id,
      revision: 1,
      status: 'active',
      basis: 'explicit',
      author: 'user',
      valid_from: null,
    })
    expect(await db.run(writeProjectMemory(c.employeeId, c.projectId, id, input))).toEqual(first)
    await expect(
      db.run(writeProjectMemory(c.employeeId, c.projectId, id, { ...input, content: 'different' })),
    ).rejects.toMatchObject({ code: 'operation_conflict' })
    const source = await db.run(getMemorySource(c.employeeId, c.projectId, first.evidence[0]!.source_id))
    expect(source).toMatchObject({ role: 'user', source_type: 'user_edit', suppressed: false })
    expect(hashText(source.text)).toBe(source.source_hash)
    const writes = await Promise.allSettled(
      ['A', 'B'].map((content) => db.run(writeProjectMemory(c.employeeId, c.projectId, id, write(content, 1)))),
    )
    expect(writes.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect((writes.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({
      code: 'memory_conflict',
      details: { current_revision: 2, current: { revision: 2 } },
    })
    expect(await db.run(getProjectMemory(c.employeeId, c.projectId, id, 1))).toMatchObject({
      content: input.content,
      retracted: true,
    })
    expect(await db.run(projectMemoryRevisions(c.employeeId, c.projectId, id, 0, 1))).toMatchObject({
      revisions: [{ revision: 1 }],
      next_after_revision: 1,
    })
    for (const [employee, project] of [
      [randomUUID(), c.projectId],
      [c.employeeId, randomUUID()],
    ]) {
      await expect(db.run(getProjectMemory(employee!, project!, id))).rejects.toMatchObject({ status: 404 })
      await expect(db.run(projectMemoryRevisions(employee!, project!, id))).rejects.toMatchObject({ status: 404 })
      await expect(db.run(getMemorySource(employee!, project!, source.id))).rejects.toMatchObject({ status: 404 })
      await expect(db.run(writeProjectMemory(employee!, project!, id, write('private')))).rejects.toMatchObject({
        status: 404,
      })
    }
  }))

it('merges independent evidence, makes identical support a no-op, and validates source ranges, ownership and hashes', async () =>
  withTestDatabase(async (db) => {
    const { context: c, memoryEvidence } = await projectToolFixture(db)
    const apply = (change: Parameters<typeof applyChange>[3]) =>
      db.run(transaction(applyChange(c.employeeId, c.projectId, { type: 'foreground', throughSeq: 1 }, change)))
    const change = {
      operation_id: randomUUID(),
      expected_revision: 0,
      action: 'add' as const,
      content: { title: 'Database', content: 'Use PostgreSQL' },
      evidence: memoryEvidence,
    }
    const first = await apply(change)
    expect(first).toMatchObject({ basis: 'inferred', revision: 1 })
    expect(await apply({ ...change, operation_id: randomUUID() })).toMatchObject({ id: first.id, revision: 1 })
    const support = {
      operation_id: randomUUID(),
      item_id: first.id,
      expected_revision: 1,
      action: 'support' as const,
      evidence: memoryEvidence,
    }
    expect(await apply(support)).toMatchObject({ revision: 1 })
    const other = await projectToolFixture(db)
    for (const evidence of [
      other.memoryEvidence,
      [{ ...memoryEvidence[0]!, source_hash: 'bad' }],
      [{ ...memoryEvidence[0]!, end_byte: 99999 }],
    ]) {
      await expect(
        apply({ ...change, operation_id: randomUUID(), content: { title: 'Other', content: randomUUID() }, evidence }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/not_found|invalid_evidence/) })
    }
    await expect(
      apply({ ...change, operation_id: randomUUID(), content: { ...change.content, core: true } }),
    ).rejects.toMatchObject({ code: 'invalid_core_source' })
    const user = await db.run(writeProjectMemory(c.employeeId, c.projectId, undefined, write('Use PostgreSQL')))
    expect(user.id).toBe(first.id)
    expect(user.evidence).toHaveLength(2)
    const [epoch] = await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{
          n: string
        }>`SELECT knowledge_epoch AS n FROM project_memory_state WHERE project_id=${c.projectId}`
      }),
    )
    expect(Number(epoch!.n)).toBe(2)
  }))

it('retains retirement through edits, blocks old evidence under new IDs, and requires explicit restoration', async () =>
  withTestDatabase(async (db) => {
    const { context: c, memoryEvidence } = await projectToolFixture(db)
    const first = await db.run(
      transaction(
        applyChange(
          c.employeeId,
          c.projectId,
          { type: 'foreground', throughSeq: 1 },
          {
            operation_id: randomUUID(),
            action: 'add',
            expected_revision: 0,
            content: { title: 'Database', content: 'Use PostgreSQL' },
            evidence: memoryEvidence,
          },
        ),
      ),
    )
    const retired = await db.run(
      changeProjectMemory(c.employeeId, c.projectId, first.id, {
        operation_id: randomUUID(),
        action: 'retire',
        expected_revision: 1,
      }),
    )
    expect(retired).toMatchObject({ status: 'retired', core: false, revision: 2, suppression_id: expect.any(String) })
    expect((await db.run(listProjectMemory(c.employeeId, c.projectId))).entries).toEqual([])
    expect(await db.run(projectMemoryIndex(c.employeeId, c.projectId))).toBe('')
    const edited = await db.run(
      writeProjectMemory(c.employeeId, c.projectId, first.id, { ...write('Use PostgreSQL 18', 2), core: true }),
    )
    expect(edited).toMatchObject({ status: 'retired', core: false, revision: 3 })
    const replay = await db.run(
      callProjectTool({ ...c, toolCallId: 'replay' }, 'memory.remember', {
        title: 'New ID',
        content: 'Use PostgreSQL',
        evidence: memoryEvidence,
      }),
    )
    expect(replay).toMatchObject({ isError: true, value: { code: 'source_suppressed' } })
    expect((await db.run(listProjectMemory(c.employeeId, c.projectId, undefined, 50, true))).entries).toHaveLength(1)
    const restored = await db.run(
      changeProjectMemory(c.employeeId, c.projectId, first.id, {
        operation_id: randomUUID(),
        action: 'restore',
        expected_revision: 3,
        suppression_id: edited.suppression_id!,
      }),
    )
    expect(restored).toMatchObject({ status: 'active', revision: 4, content: 'Use PostgreSQL 18' })
    expect((await db.run(listProjectMemory(c.employeeId, c.projectId))).entries).toHaveLength(1)
    expect(await db.run(getMemorySource(c.employeeId, c.projectId, memoryEvidence[0]!.source_id))).toMatchObject({
      suppressed: true,
    })
  }))

it('preserves factual intervals across future and past successors and rejects conflicting restoration', async () =>
  withTestDatabase(async (db) => {
    const { context: c } = await projectToolFixture(db)
    const first = await db.run(
      writeProjectMemory(c.employeeId, c.projectId, undefined, {
        ...write('Use A'),
        semantic_key: 'project.database',
        valid_from: '2020-01-01T00:00:00Z',
        time_precision: 'day',
      }),
    )
    const next = await db.run(
      changeProjectMemory(c.employeeId, c.projectId, first.id, {
        operation_id: randomUUID(),
        expected_revision: 1,
        action: 'supersede',
        successor: {
          title: 'Database',
          content: 'Use B',
          semantic_key: 'project.database',
          valid_from: '2090-01-01T00:00:00Z',
        },
      }),
    )
    expect(next).toMatchObject({ revision: 1, content: 'Use B' })
    expect((await db.run(listProjectMemory(c.employeeId, c.projectId))).entries.map((e) => e.id)).toEqual([first.id])
    const old = await db.run(getProjectMemory(c.employeeId, c.projectId, first.id))
    expect(old).toMatchObject({ status: 'superseded', successor_id: next.id })
    expect(Date.parse(old.valid_until!)).toBe(Date.parse('2090-01-01T00:00:00Z'))
    await db.run(
      changeProjectMemory(c.employeeId, c.projectId, first.id, {
        operation_id: randomUUID(),
        expected_revision: 2,
        action: 'retire',
      }),
    )
    const retired = await db.run(getProjectMemory(c.employeeId, c.projectId, first.id))
    expect(
      await db.run(
        changeProjectMemory(c.employeeId, c.projectId, first.id, {
          operation_id: randomUUID(),
          expected_revision: 3,
          action: 'restore',
          suppression_id: retired.suppression_id!,
        }),
      ),
    ).toMatchObject({ status: 'superseded', effective: true })
    const past = await db.run(
      writeProjectMemory(c.employeeId, c.projectId, undefined, {
        ...write('Past A'),
        semantic_key: 'project.runtime',
        valid_from: '2000-01-01T00:00:00Z',
      }),
    )
    const current = await db.run(
      changeProjectMemory(c.employeeId, c.projectId, past.id, {
        operation_id: randomUUID(),
        expected_revision: 1,
        action: 'supersede',
        successor: {
          title: 'Runtime',
          content: 'Current B',
          semantic_key: 'project.runtime',
          valid_from: '2001-01-01T00:00:00Z',
        },
      }),
    )
    const inactive = await db.run(
      changeProjectMemory(c.employeeId, c.projectId, past.id, {
        operation_id: randomUUID(),
        expected_revision: 2,
        action: 'retire',
      }),
    )
    await expect(
      db.run(
        changeProjectMemory(c.employeeId, c.projectId, past.id, {
          operation_id: randomUUID(),
          expected_revision: 3,
          action: 'restore',
          suppression_id: inactive.suppression_id!,
        }),
      ),
    ).rejects.toMatchObject({ code: 'memory_restore_conflict', details: { current: { id: current.id } } })
    const historic = await db.run(
      writeProjectMemory(c.employeeId, c.projectId, undefined, {
        ...write('Past value'),
        valid_from: '2000-01-01T00:00:00Z',
        valid_until: '2001-01-01T00:00:00Z',
      }),
    )
    expect((await db.run(listProjectMemory(c.employeeId, c.projectId))).entries.some((e) => e.id === historic.id)).toBe(
      false,
    )
    await expect(
      db.run(
        writeProjectMemory(c.employeeId, c.projectId, undefined, {
          ...write('Invalid interval'),
          valid_from: '2020-01-01T00:00:00Z',
          valid_until: '2000-01-01T00:00:00Z',
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_fact_time' })
  }))

it('rejects derived source registration, splits UTF-8 source pages safely and prevents archive writes while permitting paused edits', async () =>
  withTestDatabase(async (db) => {
    const { context: c } = await projectToolFixture(db)
    const item = await db.run(writeProjectMemory(c.employeeId, c.projectId, undefined, write('中文证据 '.repeat(4000))))
    const sourceId = item.evidence[0]!.source_id
    const page = await db.run(getMemorySource(c.employeeId, c.projectId, sourceId, 0, 101))
    expect(page.has_more).toBe(true)
    expect(Buffer.byteLength(page.text)).toBe(page.next_offset)
    expect(page.text).not.toContain('\uFFFD')
    await expect(db.run(registerEventSource(c.employeeId, c.projectId, 1, 2))).rejects.toMatchObject({
      code: 'invalid_evidence',
    })
    await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE projects SET status='paused' WHERE id=${c.projectId}`
      }),
    )
    await db.run(writeProjectMemory(c.employeeId, c.projectId, item.id, write('Paused edits work', 1)))
    await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE projects SET status='archived' WHERE id=${c.projectId}`
      }),
    )
    await expect(
      db.run(writeProjectMemory(c.employeeId, c.projectId, item.id, write('Archived', 2))),
    ).rejects.toMatchObject({ code: 'project_archived' })
  }))

it('reads a real pi-ai assistant source and refuses stale foreground corrections and forged source roles', async () =>
  withTestDatabase(async (db) => {
    const { context: c, memoryEvidence } = await projectToolFixture(db)
    const source = await db.run(callProjectTool({ ...c, toolCallId: 'source' }, 'memory.read', { source_seq: 1 }))
    expect(source).toMatchObject({
      value: {
        source_type: 'assistant',
        role: 'agent_report',
        text: 'Use PostgreSQL',
        source_hash: memoryEvidence[0]!.source_hash,
      },
    })
    expect(
      await db.run(callProjectTool({ ...c, toolCallId: 'forged' }, 'memory.read', { source_seq: 1, role: 'user' })),
    ).toMatchObject({ isError: true, value: { code: 'invalid' } })
    const first = await db.run(
      transaction(
        applyChange(
          c.employeeId,
          c.projectId,
          { type: 'foreground', throughSeq: 1 },
          {
            operation_id: randomUUID(),
            expected_revision: 0,
            action: 'add',
            content: { title: 'Database', content: 'Use PostgreSQL' },
            evidence: memoryEvidence,
          },
        ),
      ),
    )
    await db.run(writeProjectMemory(c.employeeId, c.projectId, first.id, write('Use SQLite', 1)))
    expect(
      await db.run(
        callProjectTool({ ...c, toolCallId: 'stale-correction' }, 'memory.correct', {
          item_id: first.id,
          expected_revision: 1,
          action: 'correct',
          content: { title: 'Old proposal', content: 'Use PostgreSQL' },
          evidence: memoryEvidence,
        }),
      ),
    ).toMatchObject({
      isError: true,
      value: { code: 'memory_conflict', current: { content: 'Use SQLite', revision: 2 } },
    })
    expect(
      await db.run(
        callProjectTool({ ...c, toolCallId: 'replay-correction' }, 'memory.remember', {
          title: 'Another ID',
          content: 'Use PostgreSQL',
          evidence: memoryEvidence,
        }),
      ),
    ).toMatchObject({ isError: true, value: { code: 'source_suppressed' } })
    expect(await db.run(getProjectMemory(c.employeeId, c.projectId, first.id, 1))).toMatchObject({
      retracted: true,
      effective: false,
    })
  }))

it('protects an explicit preference from inferred correction and supersession while allowing a user correction', async () =>
  withTestDatabase(async (db) => {
    const { context: c, memoryEvidence } = await projectToolFixture(db)
    const first = await db.run(
      writeProjectMemory(c.employeeId, c.projectId, undefined, {
        ...write('Use TypeScript'),
        kind: 'preference',
        semantic_key: 'project.language',
        valid_from: '2000-01-01T00:00:00Z',
      }),
    )
    for (const action of ['correct', 'supersede'] as const) {
      expect(
        await db.run(
          callProjectTool({ ...c, toolCallId: 'inferred-' + action }, 'memory.correct', {
            item_id: first.id,
            expected_revision: 1,
            action,
            content: {
              title: 'Language',
              content: 'Use Python',
              kind: 'preference',
              semantic_key: 'project.language',
              valid_from: '2090-01-01T00:00:00Z',
            },
            evidence: memoryEvidence,
          }),
        ),
      ).toMatchObject({ isError: true, value: { code: 'invalid_evidence' } })
    }
    expect(await db.run(getProjectMemory(c.employeeId, c.projectId, first.id))).toMatchObject({
      content: 'Use TypeScript',
      basis: 'explicit',
      revision: 1,
      successor_id: null,
    })
    expect(
      await db.run(writeProjectMemory(c.employeeId, c.projectId, first.id, write('Use Python for this project', 1))),
    ).toMatchObject({ content: 'Use Python for this project', basis: 'explicit', kind: 'preference', revision: 2 })
  }))

it('commits memory and tool receipts atomically', async () =>
  withTestDatabase(async (db) => {
    const { context: c, memoryEvidence } = await projectToolFixture(db)
    await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE FUNCTION reject_tool_result() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN IF NEW.kind=''tool_result'' THEN RAISE EXCEPTION ''unavailable''; END IF; RETURN NEW; END;'`
        yield* sql`CREATE TRIGGER reject_tool_result BEFORE INSERT ON conversation_events FOR EACH ROW EXECUTE FUNCTION reject_tool_result()`
      }),
    )
    await expect(
      db.run(
        callProjectTool(c, 'memory.remember', { title: 'Atomic', content: 'Use PostgreSQL', evidence: memoryEvidence }),
      ),
    ).rejects.toMatchObject({ status: 503 })
    expect((await db.run(listProjectMemory(c.employeeId, c.projectId))).entries).toEqual([])
  }))
