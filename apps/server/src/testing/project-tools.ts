import { randomUUID } from 'node:crypto'
import { Effect, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as P from '@baton/protocol'
import { seedNode, type TestDatabase } from './database.ts'
import type { NodeSource } from '../errors.ts'
import { runtimeRequest } from '../project/runtime.ts'

interface ToolRun {
  employeeId: string
  projectId: string
  agentId: string
  conversationId: string
  runId: string
  leaseEpoch: number
  toolCallId: string
  source: NodeSource
}
const toolMessage = Schema.Struct({
  message: Schema.Struct({
    isError: Schema.Boolean,
    content: Schema.Array(Schema.Struct({ type: Schema.Literal('text'), text: Schema.String })),
  }),
})
const toolResponse = (response: unknown) => {
  const event = Schema.decodeUnknownOption(P.ProjectEvent)(response)
  if (event._tag === 'None') return { pending: true, value: response, seq: undefined, isError: undefined }
  const { message } = Schema.decodeUnknownSync(toolMessage)(event.value.payload)
  return {
    value: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(message.content[0]!.text),
    isError: message.isError || undefined,
    seq: event.value.seq,
    pending: undefined,
  }
}
export const callProjectTool = Effect.fnUntraced(function* (c: ToolRun, name: string, args: unknown) {
  const sql = yield* SqlClient.SqlClient
  const argumentsValue = Schema.decodeUnknownSync(Schema.Json)(args)
  const [row] = yield* sql<{
    last_seq: number
  }>`SELECT (next_seq-1)::float8 AS last_seq FROM conversations WHERE id=${c.conversationId}`
  const request = (operation: P.ProjectRuntimeRequest['operation'], extra: Partial<P.ProjectRuntimeRequest>) =>
    runtimeRequest(c.source, {
      type: 'project_runtime.request',
      run_id: c.runId,
      lease_epoch: c.leaseEpoch,
      operation,
      ...extra,
    })
  const assistant = Schema.decodeUnknownSync(P.ProjectEvent)(
    yield* request('append_event', {
      last_seq: row!.last_seq,
      client_event_id: c.toolCallId,
      payload: {
        format: 'pi-ai/1',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: c.toolCallId, name, arguments: argumentsValue }],
        },
      },
    }),
  )
  return toolResponse(
    yield* request('call_tool', {
      last_seq: assistant.seq,
      tool_call_id: c.toolCallId,
      tool_name: name,
      arguments: argumentsValue,
    }),
  )
})
export const waitForProjectTool = Effect.fnUntraced(function* (c: ToolRun, finishWait = false) {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{
    last_seq: number
  }>`SELECT (next_seq-1)::float8 AS last_seq FROM conversations WHERE id=${c.conversationId}`
  return toolResponse(
    yield* runtimeRequest(c.source, {
      type: 'project_runtime.request',
      run_id: c.runId,
      lease_epoch: c.leaseEpoch,
      operation: 'wait_tool',
      last_seq: row!.last_seq,
      tool_call_id: c.toolCallId,
      payload: { finish_wait: finishWait },
    }),
  )
})

export async function projectToolFixture(db: TestDatabase, existing?: Pick<ToolRun, 'employeeId' | 'source'>) {
  const projectId = randomUUID(),
    agentId = randomUUID(),
    conversationId = randomUUID()
  const report: P.RuntimeReport = {
    exec: { enabled: true, shell: '/bin/sh' },
    roots: [{ root_id: 'root', path: '/work' }],
    repos: [],
    agents: [
      {
        agent_type: 'cursor',
        version: '1',
        status: 'available',
        models: [{ id: 'model', name: 'Model' }],
        default_model: 'model',
        capabilities: { create: true, queue: true, steer: false, stop: true, resume: true, switch_model: true },
      },
    ],
  }
  const { employeeId, nodeId, source } = existing
    ? { ...existing, nodeId: existing.source.node_id }
    : await seedNode(db.run, { report })
  const context: ToolRun = {
    employeeId,
    projectId,
    agentId,
    conversationId,
    runId: randomUUID(),
    leaseEpoch: 1,
    toolCallId: 'tool-1',
    source,
  }
  await db.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO projects(id,employee_id,title) VALUES(${projectId},${employeeId},'Project')`
      yield* sql`INSERT INTO project_agents(id,employee_id,project_id,provider,model) VALUES(${agentId},${employeeId},${projectId},'test','model')`
      yield* sql`INSERT INTO conversations(id,employee_id,agent_id,next_seq) VALUES(${conversationId},${employeeId},${agentId},1)`
      yield* sql`INSERT INTO agent_runs(id,employee_id,agent_id,node_id,lease_epoch,state,provider,model,placement_reason) VALUES(${context.runId},${employeeId},${agentId},${nodeId},${context.leaseEpoch},'running','test','model','test')`
      yield* sql`UPDATE project_agents SET lease_run_id=${context.runId},lease_epoch=${context.leaseEpoch},lease_until=clock_timestamp()+interval '60 seconds' WHERE id=${agentId}`
    }),
  )
  await db.run(
    runtimeRequest(source, {
      type: 'project_runtime.request',
      run_id: context.runId,
      lease_epoch: context.leaseEpoch,
      operation: 'append_event',
      last_seq: 0,
      client_event_id: 'fixture',
      payload: { format: 'pi-ai/1', message: { role: 'assistant', content: [] } },
    }),
  )
  return { context, nodeId, source }
}
