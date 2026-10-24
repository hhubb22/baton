import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { expect, it } from 'vite-plus/test'
import { projectToolFixture, withProjectToolDatabase } from './project-tools.test-support.ts'
import { getProjectMemory, listProjectMemory, projectMemoryRevisions, writeProjectMemory } from './project-memory.ts'
import { executeProjectTool } from './project-tools.ts'

it('keeps immutable memory revisions, returns the winning version on conflict, and isolates employees and projects', async () =>
  withProjectToolDatabase(async (db) => {
    const { context: c } = await projectToolFixture(db)
    const id = randomUUID()
    const first = await db.run(
      writeProjectMemory(c.employeeId, c.projectId, id, { title: 'First', content: 'body 1', expected_revision: 0 }),
    )
    expect(first).toMatchObject({ id, revision: 1, author: 'user' })
    const writes = await Promise.allSettled(
      ['A', 'B'].map((content) =>
        db.run(writeProjectMemory(c.employeeId, c.projectId, id, { title: content, content, expected_revision: 1 })),
      ),
    )
    expect(writes.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const loser = writes.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(loser.reason).toMatchObject({
      status: 409,
      code: 'memory_conflict',
      details: { current_revision: 2, current: { revision: 2 } },
    })
    expect(await db.run(getProjectMemory(c.employeeId, c.projectId, id, 1))).toMatchObject({
      title: 'First',
      content: 'body 1',
    })
    expect(await db.run(projectMemoryRevisions(c.employeeId, c.projectId, id, 0, 1))).toMatchObject({
      revisions: [{ revision: 1, title: 'First' }],
      next_after_revision: 1,
    })
    expect(await db.run(projectMemoryRevisions(c.employeeId, c.projectId, id, 1))).toMatchObject({
      revisions: [{ revision: 2 }],
    })
    await expect(db.run(getProjectMemory(randomUUID(), c.projectId, id))).rejects.toMatchObject({ status: 404 })
    await expect(db.run(getProjectMemory(c.employeeId, randomUUID(), id))).rejects.toMatchObject({ status: 404 })
    expect((await db.run(listProjectMemory(c.employeeId, c.projectId))).entries).toHaveLength(1)
    const inputs = await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{
          source_type: string
          wake_required: boolean
        }>`SELECT source_type,wake_required FROM project_agent_input_queue WHERE agent_id=${c.agentId}`
      }),
    )
    expect(inputs).toHaveLength(2)
    expect(inputs.every((r) => r.source_type === 'memory_updated' && !r.wake_required)).toBe(true)
    const agent = await db.run(
      executeProjectTool({ ...c, toolCallId: 'memory' }, 'memory.write', {
        entry_id: id,
        title: 'Agent',
        content: 'updated',
        expected_revision: 2,
      }),
    )
    expect(agent).toMatchObject({ value: { revision: 3 } })
    expect(await db.run(getProjectMemory(c.employeeId, c.projectId, id))).toMatchObject({
      author: 'agent',
      source_seq: 1,
    })
  }))

it('rolls tool side effects back if the result cannot commit and propagates database failures', async () =>
  withProjectToolDatabase(async (db) => {
    const { context: c } = await projectToolFixture(db)
    await expect(
      db.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const result = yield* executeProjectTool(c, 'memory.write', {
                title: 'Atomic',
                content: 'not committed',
                expected_revision: 0,
              })
              expect(result.isError).toBeUndefined()
              yield* sql`INSERT INTO conversation_events(conversation_id,seq,employee_id,kind,payload) VALUES(${c.conversationId},1,${c.employeeId},'tool_result','{}'::jsonb)`
            }),
          )
        }),
      ),
    ).rejects.toBeDefined()
    expect((await db.run(listProjectMemory(c.employeeId, c.projectId))).entries).toEqual([])
    await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE FUNCTION reject_memory() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''unavailable''; END;'`
        yield* sql`CREATE TRIGGER reject_memory BEFORE INSERT ON project_memory_revisions FOR EACH ROW EXECUTE FUNCTION reject_memory()`
      }),
    )
    await expect(
      db.run(executeProjectTool(c, 'memory.write', { title: 'Fail', content: 'fail', expected_revision: 0 })),
    ).rejects.toMatchObject({ status: 503 })
    expect((await db.run(listProjectMemory(c.employeeId, c.projectId))).entries).toEqual([])
    expect(
      await db.run(executeProjectTool(c, 'memory.write', { title: '', content: 'bad', expected_revision: 0 })),
    ).toMatchObject({ isError: true })
  }))
