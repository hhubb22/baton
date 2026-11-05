import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { expect, it } from 'vite-plus/test'
import { seedNode, withTestDatabase } from './testing/database.ts'
import { readDiagnostics } from './diagnostics.ts'
import { createProject } from './project/projects.ts'

const gateway = {
  nodes: 1,
  browsers: 2,
  pending_rpc: 0,
  connections: 3,
  pending_disconnects: 0,
  received_bytes: 12,
  sent_bytes: 34,
  queued_control_messages: 0,
  queued_control_bytes: 0,
}

it('reads live devices, outbox backlog, Thread states and memory jobs without conversation text', async () => {
  await withTestDatabase(async ({ run }) => {
    const node = await seedNode(run)
    const project = await run(
      createProject(node.employeeId, { title: 'Diagnostics', provider: 'openai-codex', model: 'gpt-5' }),
    )
    const threadId = randomUUID()
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO threads(id,employee_id,client_thread_id,request_hash,node_id,agent_type,runtime_mode,working_directory,status,created_by,storage_generation,opened_at) VALUES(${threadId},${node.employeeId},'diagnostics',${Buffer.alloc(32)},${node.nodeId},'codex','auto','/work','running','employee','generation',now())`
        yield* sql`INSERT INTO thread_outbox(employee_id,thread_id,node_id,message_id,action,payload,created_at) VALUES(${node.employeeId},${threadId},${node.nodeId},${randomUUID()},'message','{}'::jsonb,clock_timestamp()-interval '12 seconds')`
        yield* sql`INSERT INTO project_memory_jobs(id,employee_id,project_id,conversation_id,kind,input_seq,through_seq,waiting_reason,updated_at) VALUES(${randomUUID()},${node.employeeId},${project.id},${project.conversation.id},'embedding',0,0,'login_required',clock_timestamp()-interval '4 seconds')`
        const first = yield* readDiagnostics(node.employeeId, gateway)
        yield* sql`UPDATE node_presence SET online=false WHERE node_id=${node.nodeId}`
        const second = yield* readDiagnostics(node.employeeId, gateway)
        return { first, second }
      }),
    )
    expect(result.first).toMatchObject({
      ...gateway,
      online_devices: 1,
      active_runs: 0,
      outbox: [{ action: 'message', pending: 1 }],
      thread_statuses: [{ status: 'running', count: 1 }],
      memory_jobs: [{ state: 'pending', waiting_reason: 'login_required', backoff: false, count: 1 }],
    })
    expect(result.first.outbox[0]!.oldest_unacked_seconds).toBeGreaterThanOrEqual(11)
    expect(result.first.memory_jobs[0]!.oldest_seconds).toBeGreaterThanOrEqual(3)
    expect(result.second.online_devices).toBe(0)
    expect(JSON.stringify(result.first)).not.toContain('conversation')
  })
})
