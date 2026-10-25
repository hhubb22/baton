import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { expect, it } from 'vite-plus/test'
import { projectToolFixture } from './testing/project-tools.ts'
import { withTestDatabase } from './testing/database.ts'
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
    '[local](http://localhost:3000)',
    '[mail](mailto:user@example.com)',
    '[ref][dev]\n\n[dev]: http://localhost:5173',
    '<http://example.com>',
    'www.example.com',
    'plain text',
  ])
    expect(validInboxMarkdown(text)).toBe(true)
  for (const text of [
    '[bad](data:text/html,script)',
    '[bad](vbscript:alert)',
    '[bad](file:///etc/passwd)',
    '[bad](mailto:)',
    '[bad](java&#115;cript:alert)',
    '[bad][ref]\n\n[ref]: javascript:alert',
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
  withTestDatabase(async (db) => {
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

it('allows more than ten pending questions, checks thread ownership and keeps system items separate', async () =>
  withTestDatabase(async (db) => {
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
      expect(
        await db.run(
          executeProjectTool({ ...c, toolCallId: `ask-${i}` }, 'inbox.ask', { ...ask, title: `Choose ${i}` }),
        ),
      ).not.toHaveProperty('isError', true)
    expect(await db.run(executeProjectTool({ ...c, toolCallId: 'overflow' }, 'inbox.ask', ask))).not.toHaveProperty(
      'isError',
      true,
    )
    expect((await db.run(listInbox(c.employeeId))).open_count).toBe(11)
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

it('reuses identical open questions under concurrent creation while allowing distinct questions beyond ten', async () =>
  withTestDatabase(async (db) => {
    const { context: c } = await projectToolFixture(db)
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        db.run(executeProjectTool({ ...c, toolCallId: `concurrent-${i}` }, 'inbox.ask', ask)),
      ),
    )
    expect(results.every((r) => !r.isError)).toBe(true)
    expect((await db.run(listInbox(c.employeeId))).open_count).toBe(1)
    const distinct = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        db.run(createAgentAttention(c, `distinct-${i}`, { ...ask, title: `Choose ${i}` })),
      ),
    )
    expect(new Set(distinct.map((r) => r.id)).size).toBe(12)
    expect(await db.run(createAgentAttention(c, 'distinct-0', ask))).toEqual(distinct[0])
    expect((await db.run(listInbox(c.employeeId))).open_count).toBe(13)
    const original = distinct[0]
    if (!original) throw new Error('Missing distinct question')
    await db.run(
      handleAttentionRequest(
        c.employeeId,
        original.id,
        {
          expected_version: 1,
          client_request_id: 'close-original',
        },
        true,
      ),
    )
    const reopened = await db.run(createAgentAttention(c, 'new-question', { ...ask, title: 'Choose 0' }))
    expect(reopened.id).not.toBe(original.id)
    expect(reopened.state).toBe('open')
  }))

it('round-trips more than five choices with local and email links and rejects an excessive option budget', async () =>
  withTestDatabase(async (db) => {
    const { context: c } = await projectToolFixture(db)
    const options = Array.from({ length: 6 }, (_, index) => ({ id: `choice-${index}`, label: `Choice ${index}` }))
    const request = await db.run(
      createAgentAttention(c, 'six-options', {
        ...ask,
        content: '[Dev](http://localhost:5173) [Mail](mailto:user@example.com)',
        options,
      }),
    )
    expect(request.options).toEqual(options)
    await expect(
      db.run(
        createAgentAttention(c, 'oversized-options', {
          ...ask,
          options: [{ id: 'large', label: 'Large', description: '文'.repeat(6000) }],
        }),
      ),
    ).rejects.toMatchObject({ status: 422 })
  }))
