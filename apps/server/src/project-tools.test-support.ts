import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as P from '@baton/protocol'
import { openTestDatabase, type TestDatabase } from './test-database.ts'
import type { ProjectToolContext } from './project-tools.ts'
import type { NodeSource } from './errors.ts'

export async function projectToolFixture(db: TestDatabase) {
  const employeeId = randomUUID(),
    projectId = randomUUID(),
    agentId = randomUUID(),
    conversationId = randomUUID(),
    nodeId = randomUUID(),
    credentialId = randomUUID()
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
  const source: NodeSource = {
    employee_id: employeeId,
    node_id: nodeId,
    credential_id: credentialId,
    incarnation: 'inc',
    conn_id: 'conn',
  }
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
  await db.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO employees(id,username,display_name,auth_source,external_subject,must_change_password,created_at,updated_at) VALUES(${employeeId},${'u' + employeeId.replaceAll('-', '')},'Employee','test',${employeeId},false,now(),now())`
      yield* sql`INSERT INTO projects(id,employee_id,title) VALUES(${projectId},${employeeId},'Project')`
      yield* sql`INSERT INTO project_agents(id,employee_id,project_id,provider,model) VALUES(${agentId},${employeeId},${projectId},'test','model')`
      yield* sql`INSERT INTO conversations(id,employee_id,agent_id,next_seq) VALUES(${conversationId},${employeeId},${agentId},2)`
      yield* sql`INSERT INTO conversation_events(conversation_id,seq,employee_id,kind,payload) VALUES(${conversationId},1,${employeeId},'assistant','{"format":"pi-ai/1","message":{"role":"assistant","content":[]}}'::jsonb)`
      yield* sql`INSERT INTO nodes(id,employee_id,display_name,system_name,capabilities,registration_seq,registered_at,credential_version) VALUES(${nodeId},${employeeId},'Device','linux',ARRAY[]::text[],nextval('node_registration_seq'),now(),1)`
      yield* sql`INSERT INTO node_credentials(id,node_id,employee_id,version,created_at,expires_at) VALUES(${credentialId},${nodeId},${employeeId},1,now(),now()+interval '1 day')`
      yield* sql`INSERT INTO node_presence(node_id,employee_id,online,synced,incarnation,conn_id,status_updated_at) VALUES(${nodeId},${employeeId},true,true,'inc','conn',now())`
      yield* sql`INSERT INTO node_runtime_reports(node_id,employee_id,report_version,reported_at,report) VALUES(${nodeId},${employeeId},1,now(),${JSON.stringify(report)}::jsonb)`
    }),
  )
  return { context, nodeId, source }
}
export const withProjectToolDatabase = async (test: (db: TestDatabase) => Promise<void>) => {
  const db = await openTestDatabase()
  try {
    await test(db)
  } finally {
    await db.close()
  }
}
