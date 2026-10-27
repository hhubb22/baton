import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { Effect, Exit, Scope } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { expect, it } from 'vite-plus/test'
import { WebSocket } from 'ws'
import type { RuntimeReport } from '@baton/protocol'
import { CredentialSigner } from './nodes.ts'
import { startServer } from './server.ts'
import { webSocketText } from './gateway.ts'
import { seedNode, withTestDatabase } from './testing/database.ts'
import * as projects from './project/projects.ts'
import { expireProjectNodeLeases } from './project/scheduling.ts'

const report: RuntimeReport = {
  roots: [],
  repos: [],
  exec: { enabled: false, shell: '/bin/sh' },
  project_runtime: {
    version: '0.1.0',
    memory_protocol: 1,
    max_concurrent_projects: 4,
    providers: [{ provider: 'openai-codex', status: 'available' }],
  },
}

it('the server maintenance loop closes idle credentials and revokes foreground leases without heartbeats', async () => {
  await withTestDatabase(async ({ run }) => {
    const node = await seedNode(run, { online: false, synced: false, report })
    await run(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) =>
          sql`UPDATE node_credentials SET created_at=clock_timestamp()-interval '31 days',last_business_at=clock_timestamp()-interval '31 days' WHERE id=${node.credentialId}`,
      ),
    )
    const signer = CredentialSigner.generate()
    const scope = await Effect.runPromise(Scope.make())
    try {
      const server = await run(
        startServer({
          port: 0,
          signer,
          allowedOrigins: [],
          heartbeatMs: 60_000,
          offlineMs: 120_000,
          projectDispatchMs: 60_000,
        }).pipe(Effect.provideService(Scope.Scope, scope)),
      )
      const ws = new WebSocket(`ws://${server.host}:${server.port}/v1/node`)
      const frames: Array<Record<string, unknown>> = []
      ws.on('message', (data) => frames.push(JSON.parse(webSocketText(data))))
      await once(ws, 'open')
      ws.send(
        JSON.stringify({
          kind: 'auth',
          token: signer.sign({ node_id: node.nodeId, employee_id: node.employeeId, credential_id: node.credentialId }),
          incarnation: randomUUID(),
        }),
      )
      await expect.poll(() => frames.some((f) => f.kind === 'auth_result' && f.ok === true)).toBe(true)
      ws.send(
        JSON.stringify({
          kind: 'envelope',
          envelope: {
            version: 1,
            message_id: randomUUID(),
            route: { to: 'control' },
            priority: 'control',
            body: { type: 'node.sync', display_name: 'Quiet device', system: 'linux', capabilities: [] },
          },
        }),
      )
      await expect.poll(() => frames.some((f) => f.kind === 'envelope')).toBe(true)
      const project = await run(
        projects.createProject(node.employeeId, {
          title: 'Foreground',
          goal: '',
          provider: 'openai-codex',
          model: 'fake-model',
        }),
      )
      await run(
        projects.acceptProjectMessage(node.employeeId, project.id, {
          client_message_id: randomUUID(),
          content: 'Start',
        }),
      )
      expect(await run(projects.listProjectRunCandidates())).toContain(project.agent.id)
      await run(projects.scheduleProjectRun(project.agent.id))
      expect((await run(projects.projectStatus(node.employeeId, project.id))).run?.state).toBe('starting')
      const closed = once(ws, 'close')
      await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`UPDATE node_credentials SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${node.credentialId}`
        }),
      )
      const [code, reason] = await closed
      expect(code).toBe(1008)
      expect(String(reason)).toBe('node_idle_expired')
      await expect
        .poll(async () => (await run(projects.projectStatus(node.employeeId, project.id))).run?.end_reason)
        .toBe('node_idle_expired')
      expect(await run(projects.claimProjectCommands('project_run_start'))).toEqual([])
      expect(await run(projects.claimProjectCommands('project_run_stop'))).toEqual([])
      await run(projects.scheduleProjectRun(project.agent.id))
      const leases = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql<{
            lease_run_id: string | null
          }>`SELECT lease_run_id FROM project_agents WHERE id=${project.agent.id}`
        }),
      )
      expect(leases[0].lease_run_id).toBeNull()
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  })
})

it('memory placement and dispatch exclude expired credentials and maintenance releases their claims', async () => {
  await withTestDatabase(async ({ run }) => {
    const node = await seedNode(run, { report })
    await run(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) =>
          sql`UPDATE node_credentials SET created_at=clock_timestamp()-interval '31 days',last_business_at=clock_timestamp()-interval '31 days' WHERE id=${node.credentialId}`,
      ),
    )
    const project = await run(
      projects.createProject(node.employeeId, {
        title: 'Background',
        goal: '',
        provider: 'openai-codex',
        model: 'fake-model',
      }),
    )
    const jobId = randomUUID()
    const sqlRun = <A, E>(query: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
      run(Effect.flatMap(SqlClient.SqlClient, query))
    await sqlRun(
      (sql) =>
        sql`INSERT INTO project_memory_jobs(id,employee_id,project_id,conversation_id,kind,input_seq,through_seq) VALUES(${jobId},${node.employeeId},${project.id},${project.conversation.id},'consolidation',1,2)`,
    )
    await sqlRun(
      (sql) =>
        sql`UPDATE node_credentials SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${node.credentialId}`,
    )
    await run(projects.scheduleMemoryJobs())
    const state = () =>
      sqlRun(
        (sql) =>
          sql<{
            state: string
            attempt_id: string | null
            waiting_reason: string
          }>`SELECT state,attempt_id,waiting_reason FROM project_memory_jobs WHERE id=${jobId}`,
      )
    expect((await state())[0]).toMatchObject({ state: 'pending', attempt_id: null })
    await sqlRun(
      (sql) =>
        sql`UPDATE node_credentials SET expires_at=clock_timestamp()+interval '1 day' WHERE id=${node.credentialId}`,
    )
    await run(projects.scheduleMemoryJobs())
    const [claimed] = await state()
    expect(claimed.state).toBe('claimed')
    expect(await run(projects.claimProjectCommands('project_memory_start'))).toHaveLength(1)
    await sqlRun(
      (sql) =>
        sql`UPDATE node_credentials SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${node.credentialId}`,
    )
    expect(await run(projects.claimProjectCommands('project_memory_start'))).toEqual([])
    await run(expireProjectNodeLeases())
    expect((await state())[0]).toMatchObject({
      state: 'pending',
      attempt_id: null,
      waiting_reason: 'node_idle_expired',
    })
    expect(await run(projects.claimProjectCommands('project_memory_stop'))).toEqual([])
  })
})
