import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { expect, it } from 'vite-plus/test'
import type { Execution, ExecutionReport } from '@baton/protocol'
import type { Gateway } from './gateway.ts'
import * as executions from './executions.ts'
import { withTestDatabase } from './testing/database.ts'
import { projectToolFixture, callProjectTool, waitForProjectTool } from './testing/project-tools.ts'
import { contextualRuntimeRequest } from './testing/project-context.ts'
import { patchProject } from './project/projects.ts'

const report = (e: Execution, extra: Partial<ExecutionReport> = {}): ExecutionReport => ({
  type: 'execution.report',
  execution_id: e.id,
  storage_generation: e.storage_generation,
  event_id: randomUUID(),
  seq: 1,
  status: 'completed',
  ...(!extra.status || extra.status === 'completed' ? { exit_code: 0 } : {}),
  output: 'done',
  total_bytes: 4,
  ...extra,
})
const queue = (agentId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<{ source_type: string; delivered_seq: number | null; wake_required: boolean }>`SELECT
    source_type,delivered_seq::float8 AS delivered_seq,wake_required FROM project_agent_input_queue WHERE agent_id=${agentId}`
  })

it('persists one Execution per tool call and consumes the completion input with the synchronous result', () =>
  withTestDatabase(async (db) => {
    const { context: c, nodeId } = await projectToolFixture(db)
    const args = { node_id: nodeId, working_directory: '/work', command: 'printf done', wait_seconds: 600 }
    const first = await db.run(callProjectTool(c, 'nodes.exec', args))
    const id = (first.value as { execution_id: string }).execution_id
    expect(await db.run(callProjectTool(c, 'nodes.exec', args))).toMatchObject({
      pending: true,
      value: { execution_id: id },
    })
    expect(await db.run(waitForProjectTool(c))).toMatchObject({ pending: true })
    const e = await db.run(executions.get(c, id))
    expect(await db.run(executions.create(c, args))).toEqual(e)
    await expect(db.run(executions.create(c, { ...args, command: 'different' }))).rejects.toMatchObject({
      code: 'execution_conflict',
    })
    const commands = await db.run(executions.claimCommands())
    expect(commands).toHaveLength(1)
    expect(commands[0]!.body).toMatchObject({
      action: 'start',
      execution_id: id,
      command: args.command,
      timeout_seconds: 7200,
    })
    const done = report(e)
    expect(await db.run(executions.processReport(c.source, done))).toMatchObject({ ok: true })
    expect(await db.run(executions.processReport(c.source, done))).toMatchObject({ ok: true })
    expect(await db.run(queue(c.agentId))).toEqual([
      { source_type: 'execution.finished', delivered_seq: null, wake_required: true },
    ])
    const result = await db.run(waitForProjectTool(c))
    expect(result).toMatchObject({
      value: { execution_id: id, status: 'completed', command_result: { output: 'done', exit_code: 0 } },
    })
    expect(await db.run(queue(c.agentId))).toEqual([
      { source_type: 'execution.finished', delivered_seq: result.seq, wake_required: false },
    ])
    expect(await db.run(waitForProjectTool(c))).toEqual(result)
    expect(await db.run(callProjectTool(c, 'nodes.exec', args))).toEqual(result)
    expect(await db.run(executions.claimCommands())).toEqual([])
    await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        expect(yield* sql`SELECT id FROM threads WHERE project_id=${c.projectId}`).toEqual([])
      }),
    )
  }))

it('delivers completion after the tool wait once and preserves unknown without a new start', () =>
  withTestDatabase(async (db) => {
    const { context: c, nodeId } = await projectToolFixture(db)
    const args = { node_id: nodeId, working_directory: '/work', command: 'side-effect', wait_seconds: 0 }
    const pending = await db.run(callProjectTool(c, 'nodes.exec', args))
    const id = (pending.value as { execution_id: string }).execution_id
    expect(await db.run(waitForProjectTool(c))).toMatchObject({ value: { execution_id: id, status: 'pending' } })
    const e = await db.run(executions.get(c, id))
    const unknown = report(e, { status: 'unknown', reason: 'completion evidence missing' })
    await db.run(executions.processReport(c.source, unknown))
    await db.run(executions.processReport(c.source, unknown))
    expect(await db.run(queue(c.agentId))).toEqual([
      { source_type: 'execution.finished', delivered_seq: null, wake_required: true },
    ])
    expect(await db.run(executions.create(c, args))).toMatchObject({ id, status: 'unknown' })
    expect(await db.run(executions.claimCommands())).toEqual([])
    await expect(db.run(executions.processReport(c.source, { ...unknown, output: 'changed' }))).rejects.toMatchObject({
      code: 'execution_conflict',
    })
    expect(
      await db.run(
        contextualRuntimeRequest(c.source, {
          type: 'project_runtime.request',
          run_id: c.runId,
          lease_epoch: c.leaseEpoch,
          operation: 'claim_inputs',
          last_seq: 3,
        }),
      ),
    ).toMatchObject({ input_count: 1 })
    await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        expect(
          yield* sql`SELECT role FROM project_memory_sources WHERE project_id=${c.projectId} AND source_type='execution.finished'`,
        ).toEqual([{ role: 'execution' }])
      }),
    )
  }))

it('keeps stop requested separate from cancellation and enforces Project ownership', () =>
  withTestDatabase(async (db) => {
    const { context: c, nodeId } = await projectToolFixture(db)
    const e = await db.run(executions.create(c, { node_id: nodeId, working_directory: '/work', command: 'sleep 10' }))
    const other = await projectToolFixture(db, c)
    await expect(db.run(executions.get(other.context, e.id))).rejects.toMatchObject({ code: 'not_found' })
    await expect(db.run(executions.stop(other.context, e.id))).rejects.toMatchObject({ code: 'not_found' })
    expect(await db.run(executions.stop(c, e.id))).toMatchObject({
      status: 'pending',
      stop_requested_at: expect.any(String),
    })
    await db.run(executions.stop(c, e.id))
    expect((await db.run(executions.claimCommands())).map((item) => item.body.action)).toEqual(['stop'])
    await db.run(executions.processReport(c.source, report(e, { status: 'cancelled', output: '' })))
    expect(await db.run(executions.get(c, e.id))).toMatchObject({ status: 'cancelled' })
    expect(await db.run(executions.claimCommands())).toEqual([])
    expect((await db.run(executions.list(c))).executions.map((item) => item.id)).toEqual([e.id])
    const pending = await db.run(
      executions.create(
        { ...c, toolCallId: 'archive-execution' },
        {
          node_id: nodeId,
          working_directory: '/work',
          command: 'sleep 20',
        },
      ),
    )
    await db.run(patchProject(c.employeeId, c.projectId, { status: 'archived' }))
    expect(await db.run(executions.get(c, pending.id))).toMatchObject({
      status: 'pending',
      stop_requested_at: expect.any(String),
    })
    expect((await db.run(executions.claimCommands())).map((item) => item.body.action)).toEqual(['stop'])
  }))

it('reads full output only through the owned Execution and matching stored reference', () =>
  withTestDatabase(async (db) => {
    const { context: c, nodeId } = await projectToolFixture(db)
    const e = await db.run(
      executions.create(c, { node_id: nodeId, working_directory: '/work', command: 'printf done' }),
    )
    const ref = {
      id: randomUUID(),
      storage_generation: e.storage_generation,
      total_bytes: 4,
      expires_at: '2099-01-01T00:00:00.000Z',
    }
    await db.run(executions.processReport(c.source, report(e, { full_output: ref })))
    let requests = 0
    const gateway: Pick<Gateway, 'request'> = {
      request: async (node, employee, body) => {
        requests++
        expect(node).toBe(nodeId)
        expect(employee).toBe(c.employeeId)
        if (body.type !== 'execution.output_request') throw new Error('Unexpected request')
        return {
          type: 'execution.output_result',
          operation_id: body.operation_id,
          execution_id: e.id,
          ok: true,
          full_output: {
            output_id: ref.id,
            storage_generation: ref.storage_generation,
            offset: 0,
            next_offset: 4,
            total_bytes: 4,
            expires_at: ref.expires_at,
            encoding: 'base64',
            data: 'ZG9uZQ==',
            done: true,
          },
        }
      },
    }
    const query = { output_id: ref.id, storage_generation: ref.storage_generation }
    const read = (scope: { employeeId: string; projectId: string }, outputId = ref.id) =>
      db.run(
        executions
          .readOutput(scope, e.id, { ...query, output_id: outputId })
          .pipe(Effect.provideService(executions.ExecutionOutputGateway, () => gateway)),
      )
    expect(await read(c)).toMatchObject({ data: 'ZG9uZQ==', done: true })
    await expect(read(c, randomUUID())).rejects.toMatchObject({ code: 'not_found' })
    const other = await projectToolFixture(db)
    await expect(read(other.context)).rejects.toMatchObject({ code: 'not_found' })
    expect(requests).toBe(1)
  }))
