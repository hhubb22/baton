import { randomUUID } from 'node:crypto'
import { Effect, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as P from '@baton/protocol'
import { expect, it } from 'vite-plus/test'
import { withTestDatabase } from '../testing/database.ts'
import { projectToolFixture } from '../testing/project-tools.ts'
import { transaction } from '../database.ts'
import { runtimeRequest } from './runtime.ts'
import { insertProjectInput } from './inputs.ts'
import { hashText, writeProjectMemory } from './memory/index.ts'

const textAssistant = (context: P.MemoryContext, content: Schema.Json[] = [{ type: 'text', text: 'done' }]) => ({
  format: 'pi-ai/1',
  memory_context_id: context.context_id,
  message: { role: 'assistant', content, provider_signature: 'opaque' },
})

it('persists the exact automatic context, recalls recent goals for continuation, rejects stale outputs and preserves retry receipts', async () =>
  withTestDatabase(async (db) => {
    const { context: c } = await projectToolFixture(db)
    const rpc = (operation: P.ProjectRuntimeRequest['operation'], extra: Partial<P.ProjectRuntimeRequest> = {}) =>
      db.run(
        runtimeRequest(c.source, {
          type: 'project_runtime.request',
          run_id: c.runId,
          lease_epoch: c.leaseEpoch,
          operation,
          ...extra,
        }),
      )
    const add = (title: string, content: string, core = false) =>
      db.run(
        writeProjectMemory(c.employeeId, c.projectId, undefined, {
          operation_id: randomUUID(),
          expected_revision: 0,
          title,
          content,
          core,
        }),
      )
    const core = await add('测试要求', '不要跳过测试；只有纯文档改动可以例外。', true)
    const deployment = await add('部署入口', 'deployment 使用 pnpm deploy。')
    await add('未来要求', '未来才使用的要求。', false)
    await db.run(
      insertProjectInput(c.employeeId, c.agentId, 'user_message', 'first', { content: '请检查 deployment 部署入口' }),
    )
    await rpc('claim_inputs', { last_seq: 1 })
    const prepare = async (
      last_seq: number,
      input_seq: number,
      core_tokens = 1500,
      view_refs: P.MemoryItemVersion[] = [],
    ) =>
      Schema.decodeUnknownSync(P.MemoryContext)(
        await rpc('prepare_context', {
          last_seq,
          payload: { context_id: randomUUID(), input_seq, ...P.MEMORY_CONTEXT_DEFAULTS, core_tokens, view_refs },
        }),
      )
    const first = await prepare(2, 2)
    expect(first.content).toContain(core.content)
    expect(first.content).toContain(deployment.content)
    expect(first.memory_refs.map((r) => ('item_id' in r ? r.item_id : undefined))).toContain(core.id)
    const [stored] = await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{
          snapshot: P.MemoryContext
          content_hash: string
        }>`SELECT snapshot,content_hash FROM project_memory_contexts WHERE context_id=${first.context_id}`
      }),
    )
    expect(stored!.snapshot).toEqual(first)
    expect(stored!.content_hash).toBe(hashText(first.content))
    expect(Buffer.byteLength(JSON.stringify(first, null, 1))).toBeLessThanOrEqual(40960)
    await rpc('append_event', { last_seq: 2, client_event_id: 'goal-reply', payload: textAssistant(first) })
    await db.run(insertProjectInput(c.employeeId, c.agentId, 'user_message', 'continue', { content: '继续上次那个' }))
    await rpc('claim_inputs', { last_seq: 3 })
    const continuing = await prepare(4, 4)
    expect(continuing.content).toContain(deployment.content)
    expect(continuing.query).toContain('deployment')
    await db.run(
      writeProjectMemory(c.employeeId, c.projectId, core.id, {
        operation_id: randomUUID(),
        expected_revision: 1,
        title: core.title,
        content: '不要跳过测试；文档也要检查格式。',
        core: true,
      }),
    )
    await expect(
      rpc('append_event', { last_seq: 4, client_event_id: 'stale-output', payload: textAssistant(continuing) }),
    ).rejects.toMatchObject({ code: 'memory_context_changed' })
    const refreshed = await prepare(4, 4)
    expect(refreshed.core_epoch).toBeGreaterThan(continuing.core_epoch)
    expect(refreshed.content).not.toContain(core.content)
    // 快照只依赖读到的条目、核心集合和时间边界；新增无关知识不使它失效。
    await add('new knowledge', '无关的新知识不影响已有快照。')
    const payload = textAssistant(refreshed)
    const saved = await rpc('append_event', { last_seq: 4, client_event_id: 'fresh-output', payload })
    expect(await rpc('append_event', { last_seq: 4, client_event_id: 'fresh-output', payload })).toEqual(saved)
    const related = await prepare(5, 4, 1500, [{ item_id: deployment.id, revision: 1 }])
    expect(related.memory_refs).toContainEqual({ item_id: deployment.id, revision: 1, mode: 'current' })
    expect(related.view_refs).toEqual([{ item_id: deployment.id, revision: 1 }])
    await db.run(
      writeProjectMemory(c.employeeId, c.projectId, deployment.id, {
        operation_id: randomUUID(),
        expected_revision: 1,
        title: deployment.title,
        content: 'deployment 使用 pnpm release。',
      }),
    )
    await expect(
      rpc('append_event', { last_seq: 5, client_event_id: 'stale-related', payload: textAssistant(related) }),
    ).rejects.toMatchObject({ code: 'memory_context_changed' })
    const corrected = await prepare(5, 4, 1500, [
      { item_id: deployment.id, revision: 1 },
      { item_id: deployment.id, revision: 2 },
    ])
    expect(corrected.core_epoch).toBe(related.core_epoch)
    expect(corrected.view_refs).toEqual([{ item_id: deployment.id, revision: 2 }])
    await expect(add('核心超额', '禁止省略条件。'.repeat(1500), true)).rejects.toMatchObject({
      code: 'core_budget_exceeded',
    })
  }))

it('closes unsubmitted calls on invalid context, preserves pending exec and original results across knowledge changes', async () =>
  withTestDatabase(async (db) => {
    const { context: c, nodeId } = await projectToolFixture(db)
    const rpc = (operation: P.ProjectRuntimeRequest['operation'], extra: Partial<P.ProjectRuntimeRequest> = {}) =>
      db.run(
        runtimeRequest(c.source, {
          type: 'project_runtime.request',
          run_id: c.runId,
          lease_epoch: c.leaseEpoch,
          operation,
          ...extra,
        }),
      )
    const prepare = async (last_seq: number) =>
      Schema.decodeUnknownSync(P.MemoryContext)(
        await rpc('prepare_context', {
          last_seq,
          payload: { context_id: randomUUID(), input_seq: 0, ...P.MEMORY_CONTEXT_DEFAULTS },
        }),
      )
    const mutate = () =>
      db.run(
        writeProjectMemory(c.employeeId, c.projectId, undefined, {
          operation_id: randomUUID(),
          expected_revision: 0,
          title: '约束',
          content: randomUUID(),
          core: true,
        }),
      )
    const args = { node_id: nodeId, working_directory: '/work', command: 'printf once', wait_seconds: 600 }
    const call = (id: string) => ({ type: 'toolCall', id, name: 'nodes.exec', arguments: args })
    const first = await prepare(1)
    await rpc('append_event', {
      last_seq: 1,
      client_event_id: 'before-change',
      payload: textAssistant(first, [call('unsubmitted')]),
    })
    await mutate()
    const error = Schema.decodeUnknownSync(P.ProjectEvent)(
      await rpc('call_tool', { last_seq: 2, tool_call_id: 'unsubmitted', tool_name: 'nodes.exec', arguments: args }),
    )
    expect(JSON.stringify(error.payload)).toContain('memory_context_changed')
    const next = await prepare(3)
    await rpc('append_event', {
      last_seq: 3,
      client_event_id: 'exec-output',
      payload: textAssistant(next, [call('pending')]),
    })
    const pending = await rpc('call_tool', {
      last_seq: 4,
      tool_call_id: 'pending',
      tool_name: 'nodes.exec',
      arguments: args,
    })
    await mutate()
    expect(
      await rpc('call_tool', { last_seq: 4, tool_call_id: 'pending', tool_name: 'nodes.exec', arguments: args }),
    ).toMatchObject({ pending: true, thread_id: (pending as { thread_id: string }).thread_id })
    expect(await rpc('wait_tool', { last_seq: 4, tool_call_id: 'pending' })).toMatchObject({
      pending: true,
      thread_id: (pending as { thread_id: string }).thread_id,
    })
    const finished = await rpc('wait_tool', { last_seq: 4, tool_call_id: 'pending', payload: { finish_wait: true } })
    await mutate()
    expect(
      await rpc('call_tool', { last_seq: 4, tool_call_id: 'pending', tool_name: 'nodes.exec', arguments: args }),
    ).toEqual(finished)
    const [count] = await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{ n: number }>`SELECT count(*)::float8 AS n FROM threads WHERE project_id=${c.projectId}`
      }),
    )
    expect(count!.n).toBe(1)
  }))

it('checks natural expiry without an epoch change and reports core capacity while allowing independent reads', async () =>
  withTestDatabase(async (db) => {
    const { context: c, nodeId } = await projectToolFixture(db)
    const rpc = (operation: P.ProjectRuntimeRequest['operation'], extra: Partial<P.ProjectRuntimeRequest> = {}) =>
      db.run(
        runtimeRequest(c.source, {
          type: 'project_runtime.request',
          run_id: c.runId,
          lease_epoch: c.leaseEpoch,
          operation,
          ...extra,
        }),
      )
    const [clock] = await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{ until: string }>`SELECT (clock_timestamp()+interval '1 second')::text AS until`
      }),
    )
    await db.run(
      writeProjectMemory(c.employeeId, c.projectId, undefined, {
        operation_id: randomUUID(),
        expected_revision: 0,
        title: '临时要求',
        content: '到期前禁止发布。',
        core: true,
        valid_until: clock!.until,
      }),
    )
    const prepare = async (core_tokens = 1500) =>
      Schema.decodeUnknownSync(P.MemoryContext)(
        await rpc('prepare_context', {
          last_seq: 1,
          payload: { context_id: randomUUID(), input_seq: 0, ...P.MEMORY_CONTEXT_DEFAULTS, core_tokens },
        }),
      )
    const complete = await prepare()
    const limited = await prepare(1)
    expect(limited).toMatchObject({ core_complete: false, degraded: ['core_budget_exceeded'] })
    expect(complete.expires_at).not.toBeNull()
    const crossed = Schema.decodeUnknownSync(P.MemoryContext)(
      await db.run(
        transaction(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            yield* sql`SELECT pg_sleep(GREATEST(0,extract(epoch FROM (${clock!.until}::timestamptz-clock_timestamp())))+0.02)`
            return yield* runtimeRequest(c.source, {
              type: 'project_runtime.request',
              run_id: c.runId,
              lease_epoch: c.leaseEpoch,
              operation: 'prepare_context',
              last_seq: 1,
              payload: { context_id: randomUUID(), input_seq: 0, ...P.MEMORY_CONTEXT_DEFAULTS },
            })
          }),
        ),
      ),
    )
    expect(crossed.expires_at).not.toBeNull()
    await expect(
      rpc('append_event', { last_seq: 1, client_event_id: 'crossed-expiry', payload: textAssistant(crossed) }),
    ).rejects.toMatchObject({ code: 'memory_context_changed' })
    await expect(
      rpc('append_event', { last_seq: 1, client_event_id: 'expired', payload: textAssistant(complete) }),
    ).rejects.toMatchObject({ code: 'memory_context_changed' })
    const after = await prepare()
    expect(after.core_epoch).toBe(complete.core_epoch)
    expect(after.content).not.toContain('到期前禁止发布')
    // 容量不足只阻止提交操作；读取设备以诊断容量仍可完成。
    await db.run(
      writeProjectMemory(c.employeeId, c.projectId, undefined, {
        operation_id: randomUUID(),
        expected_revision: 0,
        title: '要求',
        content: '必须运行验证。',
        core: true,
      }),
    )
    const incomplete = await prepare(1)
    await rpc('append_event', {
      last_seq: 1,
      client_event_id: 'limited',
      payload: textAssistant(incomplete, [
        { type: 'toolCall', id: 'read', name: 'devices.list', arguments: {} },
        {
          type: 'toolCall',
          id: 'write',
          name: 'nodes.exec',
          arguments: { node_id: nodeId, working_directory: '/work', command: 'printf blocked' },
        },
      ]),
    })
    const read = await rpc('call_tool', { last_seq: 2, tool_call_id: 'read', tool_name: 'devices.list', arguments: {} })
    expect(JSON.stringify(read)).toContain('devices')
    const blocked = await rpc('call_tool', {
      last_seq: 3,
      tool_call_id: 'write',
      tool_name: 'nodes.exec',
      arguments: { node_id: nodeId, working_directory: '/work', command: 'printf blocked' },
    })
    expect(JSON.stringify(blocked)).toContain('core_budget_exceeded')
  }))
