import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { expect, it } from 'vite-plus/test'
import { projectToolFixture, withProjectToolDatabase } from './project-tools.test-support.ts'
import {
  createAgentAttention,
  createSystemAttention,
  getAttentionRequest,
  handleAttentionRequest,
  listInbox,
  resolveSystemAttention,
  validInboxMarkdown,
  withdrawAttention,
  archiveProjectAttention,
} from './inbox.ts'
import { executeProjectTool } from './project-tools.ts'

it('validates actual Markdown destinations including references, entities and GFM autolinks', () => {
  for (const text of [
    '[ok](https://example.com)',
    '[ok][ref]\n\n[ref]: https://example.com',
    '`[example](http://example.com)`',
    '```\n[example](http://example.com)\n```',
    'plain text',
  ])
    expect(validInboxMarkdown(text)).toBe(true)
  for (const text of [
    '[bad](http://example.com)',
    '[bad](java&#115;cript:alert)',
    '[bad][ref]\n\n[ref]: http://example.com',
    '<http://example.com>',
    'www.example.com',
    '[bad](//example.com)',
    'x'.repeat(32769),
  ])
    expect(validInboxMarkdown(text)).toBe(false)
})
const ask = {
  title: 'Choose',
  content: '[Details](https://example.com)',
  options: [{ id: 'yes', label: 'Continue', recommended: true }],
  allow_text: true,
}

it('serializes concurrent handling and withdrawal, preserves retry result and queues exactly one active answer', async () =>
  withProjectToolDatabase(async (db) => {
    const { context: c } = await projectToolFixture(db)
    for (let i = 0; i < 10; i++) {
      const request = await db.run(createAgentAttention(c, `call-${i}`, ask))
      const replies = await Promise.allSettled([
        db.run(
          handleAttentionRequest(c.employeeId, request.id, {
            expected_version: 1,
            client_request_id: `answer-${i}`,
            option_id: 'yes',
            text: 'Proceed',
          }),
        ),
        db.run(
          handleAttentionRequest(
            c.employeeId,
            request.id,
            { expected_version: 1, client_request_id: `other-${i}` },
            true,
          ),
        ),
      ])
      expect(replies.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect((replies.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({
        code: 'inbox_conflict',
        details: { current: { version: 2 } },
      })
      const saved = await db.run(getAttentionRequest(c.employeeId, request.id))
      expect(
        await db.run(
          handleAttentionRequest(
            c.employeeId,
            request.id,
            { expected_version: 1, client_request_id: saved.resolution!.client_request_id },
            true,
          ),
        ),
      ).toEqual(saved)
    }
    const concurrent = await db.run(createAgentAttention(c, 'withdraw-race', ask))
    await Promise.allSettled([
      db.run(withdrawAttention(c, concurrent.id, 'No longer needed')),
      db.run(
        handleAttentionRequest(c.employeeId, concurrent.id, {
          expected_version: 1,
          client_request_id: 'racing',
          option_id: 'yes',
        }),
      ),
    ])
    const current = await db.run(getAttentionRequest(c.employeeId, concurrent.id))
    expect(['withdrawn', 'answered']).toContain(current.state)
    const count = await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{
          count: number
        }>`SELECT count(*)::integer AS count FROM project_agent_input_queue WHERE agent_id=${c.agentId} AND source_type='attention_answer'`
      }),
    )
    expect(count[0]!.count).toBe(current.state === 'answered' ? 11 : 10)
    await expect(db.run(getAttentionRequest(randomUUID(), concurrent.id))).rejects.toMatchObject({ status: 404 })
    await expect(
      db.run(withdrawAttention({ ...c, projectId: randomUUID() }, concurrent.id, 'wrong project')),
    ).rejects.toMatchObject({ status: 404 })
    expect((await db.run(listInbox(c.employeeId, { state: 'all' }))).requests).toHaveLength(11)
    for (let i = 0; i < 99; i++) {
      const request = await db.run(createAgentAttention(c, `withdraw-race-${i}`, ask))
      await Promise.allSettled([
        db.run(withdrawAttention(c, request.id, 'No longer needed')),
        db.run(
          handleAttentionRequest(c.employeeId, request.id, {
            expected_version: 1,
            client_request_id: `race-${i}`,
            option_id: 'yes',
          }),
        ),
      ])
      const saved = await db.run(getAttentionRequest(c.employeeId, request.id))
      const inputs = await db.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql`SELECT id FROM project_agent_input_queue WHERE agent_id=${c.agentId} AND source_key=${`attention:${request.id}:resolution`}`
        }),
      )
      expect(inputs).toHaveLength(saved.state === 'answered' ? 1 : 0)
      expect(saved.version).toBe(2)
    }
  }))

it('enforces pending limit, thread ownership and system item rules without queuing system inputs', async () =>
  withProjectToolDatabase(async (db) => {
    const { context: c } = await projectToolFixture(db)
    await db.run(createSystemAttention(c, 'Model failed'))
    await db.run(createSystemAttention(c, 'Same condition'))
    const system = (await db.run(listInbox(c.employeeId))).requests[0]!
    expect(system.source).toBe('system')
    expect(
      await db.run(executeProjectTool(c, 'inbox.withdraw', { request_id: system.id, reason: 'denied' })),
    ).toMatchObject({ isError: true })
    await expect(
      db.run(
        handleAttentionRequest(c.employeeId, system.id, {
          expected_version: 1,
          client_request_id: 'bad',
          text: 'answer',
        }),
      ),
    ).rejects.toMatchObject({ status: 422 })
    await db.run(
      handleAttentionRequest(c.employeeId, system.id, { expected_version: 1, client_request_id: 'close-system' }, true),
    )
    await db.run(resolveSystemAttention(c.employeeId, c.projectId))
    expect((await db.run(getAttentionRequest(c.employeeId, system.id))).state).toBe('closed')
    for (let i = 0; i < 10; i++)
      expect(await db.run(executeProjectTool({ ...c, toolCallId: `ask-${i}` }, 'inbox.ask', ask))).not.toHaveProperty(
        'isError',
        true,
      )
    expect(await db.run(executeProjectTool({ ...c, toolCallId: 'overflow' }, 'inbox.ask', ask))).toMatchObject({
      isError: true,
      value: { code: 'inbox_limit' },
    })
    const duplicate = await db.run(createAgentAttention(c, 'ask-0', ask))
    expect(duplicate.state).toBe('open')
    expect(
      await db.run(
        executeProjectTool({ ...c, toolCallId: 'bad-thread' }, 'inbox.ask', { ...ask, thread_id: randomUUID() }),
      ),
    ).toMatchObject({ isError: true })
    expect(
      await db.run(
        executeProjectTool({ ...c, toolCallId: 'bad-options' }, 'inbox.ask', {
          ...ask,
          options: [],
          allow_text: false,
        }),
      ),
    ).toMatchObject({ isError: true })
    await db.run(archiveProjectAttention(c.employeeId, c.projectId))
    expect((await db.run(listInbox(c.employeeId))).open_count).toBe(0)
    const inputs = await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql`SELECT id FROM project_agent_input_queue WHERE agent_id=${c.agentId}`
      }),
    )
    expect(inputs).toEqual([])
  }))

it('keeps the proposal limit and call identity under concurrent creation', async () =>
  withProjectToolDatabase(async (db) => {
    const { context: c } = await projectToolFixture(db)
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        db.run(executeProjectTool({ ...c, toolCallId: `concurrent-${i}` }, 'inbox.ask', ask)),
      ),
    )
    expect(results.filter((r) => !r.isError)).toHaveLength(10)
    expect(results.filter((r) => r.isError)).toHaveLength(2)
    const first = results.findIndex((r) => !r.isError)
    expect(await db.run(executeProjectTool({ ...c, toolCallId: `concurrent-${first}` }, 'inbox.ask', ask))).toEqual(
      results[first],
    )
    expect((await db.run(listInbox(c.employeeId))).open_count).toBe(10)
  }))
