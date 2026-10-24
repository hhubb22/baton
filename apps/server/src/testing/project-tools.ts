import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as P from '@baton/protocol'
import { seedNode, type TestDatabase } from './database.ts'
import type { ProjectToolContext } from '../project-tools.ts'

export async function projectToolFixture(db: TestDatabase) {
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
  const { employeeId, nodeId, source } = await seedNode(db.run, { report })
  const context: ProjectToolContext = {
    employeeId,
    projectId,
    agentId,
    conversationId,
    runId: randomUUID(),
    leaseEpoch: 1,
    assistantSeq: 1,
    toolCallId: 'tool-1',
  }
  await db.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO projects(id,employee_id,title) VALUES(${projectId},${employeeId},'Project')`
      yield* sql`INSERT INTO project_agents(id,employee_id,project_id,provider,model) VALUES(${agentId},${employeeId},${projectId},'test','model')`
      yield* sql`INSERT INTO conversations(id,employee_id,agent_id,next_seq) VALUES(${conversationId},${employeeId},${agentId},2)`
      yield* sql`INSERT INTO conversation_events(conversation_id,seq,employee_id,kind,payload) VALUES(${conversationId},1,${employeeId},'assistant','{"format":"pi-ai/1","message":{"role":"assistant","content":[]}}'::jsonb)`
    }),
  )
  return { context, nodeId, source }
}
