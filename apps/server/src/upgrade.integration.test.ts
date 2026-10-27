import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import type * as P from '@baton/protocol'
import { expect, it } from 'vite-plus/test'
import * as Nodes from './nodes.ts'
import * as Threads from './threads/index.ts'
import * as Projects from './project/projects.ts'
import { seedNode, withTestDatabase } from './testing/database.ts'

const report: P.RuntimeReport = {
  upgrade_protocol: 1,
  roots: [{ root_id: 'work', path: '/workspace' }],
  repos: [],
  exec: { enabled: false, shell: '/bin/sh' },
  agents: [
    {
      agent_type: 'cursor',
      status: 'available',
      version: 'offline',
      models: [],
      default_model: '',
      capabilities: { create: true, queue: true, steer: false, stop: true, resume: true, switch_model: false },
    },
  ],
  project_runtime: {
    version: 'offline',
    memory_protocol: 1,
    max_concurrent_projects: 8,
    providers: [{ provider: 'openai-codex', status: 'available' }],
  },
}

it('persists upgrade receipts without phase rollback and accepts reports only from the current connection', () =>
  withTestDatabase(async ({ run }) => {
    const node = await seedNode(run, { report })
    const operation: P.NodeUpgradeStateRequest = {
      type: 'node.upgrade_state',
      operation_id: randomUUID(),
      source_version: 'development',
      target_version: 'v2',
      phase: 'draining',
    }
    const fromDisk = { ...operation, target_path: '/private/package' }
    const first = await run(Nodes.saveNodeUpgradeState(node.source, fromDisk))
    expect(first).toEqual({
      type: 'node.upgrade_state_result',
      operation_id: operation.operation_id,
      phase: 'draining',
      ok: true,
    })
    expect(await run(Nodes.saveNodeUpgradeState(node.source, operation))).toEqual(first)
    await expect(
      run(Nodes.saveNodeUpgradeState(node.source, { ...operation, target_version: 'v3' })),
    ).rejects.toMatchObject({ code: 'upgrade_conflict' })
    await expect(run(Nodes.saveNodeUpgradeState({ ...node.source, conn_id: 'old' }, operation))).rejects.toMatchObject({
      code: 'node_source_rejected',
    })
    const ready = await run(Nodes.saveNodeUpgradeState(node.source, { ...operation, phase: 'ready' }))
    await run(Nodes.saveRuntimeReport(node.source, { roots: [], repos: [], exec: report.exec }))
    await run(Nodes.syncNode(node.source, { display_name: 'Reconnected', system: 'linux', capabilities: [] }))
    expect(await run(Nodes.saveNodeUpgradeState(node.source, operation))).toEqual(first)
    expect(await run(Nodes.getNode(node.employeeId, node.nodeId))).toMatchObject({
      upgrade_state: {
        operation_id: operation.operation_id,
        source_version: operation.source_version,
        target_version: operation.target_version,
        phase: 'ready',
      },
      executable: false,
    })
    expect(JSON.stringify(await run(Nodes.getNode(node.employeeId, node.nodeId)))).not.toContain('/private/package')
    const cancelled = { ...operation, phase: 'cancelled' as const }
    await run(Nodes.saveNodeUpgradeState(node.source, cancelled))
    expect(await run(Nodes.saveNodeUpgradeState(node.source, { ...operation, phase: 'ready' }))).toEqual(ready)
    expect(await run(Nodes.getNode(node.employeeId, node.nodeId))).toMatchObject({
      upgrade_state: { phase: 'cancelled' },
      executable: true,
    })
    const next = { ...operation, operation_id: randomUUID(), phase: 'ready' as const, target_version: 'v3' }
    await run(Nodes.saveNodeUpgradeState(node.source, next))
    await expect(run(Nodes.saveNodeUpgradeState(node.source, { ...next, phase: 'draining' }))).rejects.toMatchObject({
      code: 'upgrade_conflict',
    })
    expect(await run(Nodes.saveNodeUpgradeState(node.source, cancelled))).toMatchObject({
      operation_id: operation.operation_id,
      ok: true,
    })
    expect(await run(Nodes.getNode(node.employeeId, node.nodeId))).toMatchObject({
      upgrade_state: { operation_id: next.operation_id, phase: 'ready' },
      executable: false,
    })
    await run(Nodes.saveNodeUpgradeState(node.source, { ...next, phase: 'failed' }))
    await expect(run(Nodes.saveNodeUpgradeState(node.source, { ...next, phase: 'draining' }))).rejects.toMatchObject({
      code: 'upgrade_conflict',
    })
    await run(Nodes.saveNodeUpgradeState(node.source, { ...next, phase: 'cancelled' }))
    const offline = { ...operation, operation_id: randomUUID() }
    await run(Nodes.saveNodeUpgradeState(node.source, offline))
    // 离线取消后立即准备新操作，文件只保留新操作，旧 cancelled 不一定送达。
    const replacement = { ...offline, operation_id: randomUUID(), target_version: 'v4' }
    await run(Nodes.saveNodeUpgradeState(node.source, replacement))
    await expect(run(Nodes.saveNodeUpgradeState(node.source, { ...offline, phase: 'ready' }))).rejects.toMatchObject({
      code: 'upgrade_conflict',
    })
    await run(Nodes.saveNodeUpgradeState(node.source, { ...replacement, phase: 'cancelled' }))
    await run(Nodes.saveNodeUpgradeState(node.source, offline))
    expect(await run(Nodes.getNode(node.employeeId, node.nodeId))).toMatchObject({
      upgrade_state: { operation_id: replacement.operation_id, phase: 'cancelled' },
      executable: true,
    })
  }))

it.each(['cancelled', 'completed'] as const)('delivers queued execution after %s', (finalPhase) =>
  withTestDatabase(async ({ run }) => {
    const node = await seedNode(run, { report })
    const createThread = () =>
      run(
        Threads.create(node.employeeId, {
          client_thread_id: randomUUID(),
          node_id: node.nodeId,
          agent_type: 'cursor',
          working_directory: '/workspace',
          message: { client_message_id: randomUUID(), content: 'Keep this queued input' },
        }),
      )
    const { thread: opened } = await createThread()
    const [open] = await run(Threads.claimCommands())
    await run(
      Threads.processReceipt(node.source, open!.message_id, {
        type: 'thread.command_result',
        thread_id: opened.id,
        ok: true,
        storage_generation: 'generation',
      }),
    )
    await run(
      Threads.processReport(node.source, {
        type: 'thread.report',
        thread_id: opened.id,
        event_id: randomUUID(),
        worker_seq: 1,
        kind: 'thread.opened',
        storage_generation: 'generation',
      }),
    )
    await run(Threads.resume(node.employeeId, opened.id))
    const { thread: unopened } = await createThread()
    const foreground = async (title: string) => {
      const p = await run(
        Projects.createProject(node.employeeId, { title, goal: '', provider: 'openai-codex', model: 'offline' }),
      )
      await run(
        Projects.acceptProjectMessage(node.employeeId, p.id, {
          client_message_id: randomUUID(),
          content: 'Keep this Project input',
        }),
      )
      await run(Projects.scheduleProjectRun(p.agent.id))
      return p
    }
    const project = await foreground('Queued foreground')
    const cleanup = await foreground('Cleanup foreground')
    const state: P.NodeUpgradeStateRequest = {
      type: 'node.upgrade_state',
      operation_id: randomUUID(),
      source_version: 'development',
      target_version: 'v2',
      phase: 'draining',
    }
    await run(Nodes.saveNodeUpgradeState(node.source, state))
    const waiting = await foreground('Placed after cancellation')
    expect((await run(Projects.projectStatus(node.employeeId, waiting.id))).run).toBeUndefined()
    const background = await run(
      Projects.createProject(node.employeeId, {
        title: 'Queued memory',
        goal: '',
        provider: 'openai-codex',
        model: 'offline',
      }),
    )
    const jobId = randomUUID(),
      runId = randomUUID()
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO project_memory_jobs(id,employee_id,project_id,conversation_id,kind,input_seq,through_seq,state,attempt_id) VALUES(${jobId},${node.employeeId},${background.id},${background.conversation.id},'consolidation',1,2,'claimed',${runId})`
        yield* sql`INSERT INTO agent_runs(id,employee_id,agent_id,node_id,lease_epoch,state,provider,model,placement_reason,memory_job_id,memory_claim_until) VALUES(${runId},${node.employeeId},${background.agent.id},${node.nodeId},1,'starting','openai-codex','offline','idle_device',${jobId},clock_timestamp()+interval '60 seconds')`
      }),
    )
    expect(await run(Threads.claimCommands())).toEqual([])
    expect(await run(Projects.claimProjectCommands('project_run_start'))).toEqual([])
    expect(await run(Projects.claimProjectCommands('project_memory_start'))).toEqual([])
    await run(Threads.stop(node.employeeId, opened.id))
    const stops = await run(Threads.claimCommands())
    expect(stops.map(({ body }) => ({ action: body.action, thread_id: body.thread_id }))).toEqual([
      { action: 'stop', thread_id: opened.id },
    ])
    await run(
      Threads.processReceipt(node.source, stops[0]!.message_id, {
        type: 'thread.command_result',
        thread_id: opened.id,
        ok: true,
        storage_generation: 'generation',
      }),
    )
    await run(Projects.stopProject(node.employeeId, cleanup.id))
    expect(
      (await run(Projects.claimProjectCommands('project_run_stop'))).map((delivery) => delivery.command.project_id),
    ).toEqual([cleanup.id])
    await run(Nodes.saveNodeUpgradeState(node.source, { ...state, phase: 'ready' }))
    expect(await run(Threads.claimCommands())).toEqual([])
    expect(await run(Projects.claimProjectCommands('project_memory_start'))).toEqual([])
    if (finalPhase === 'completed') {
      for (const phase of ['migrating', 'syncing'] as const) {
        await run(Nodes.saveNodeUpgradeState(node.source, { ...state, phase }))
        expect(await run(Threads.claimCommands())).toEqual([])
        expect(await run(Projects.claimProjectCommands('project_run_start'))).toEqual([])
        expect(await run(Projects.claimProjectCommands('project_memory_start'))).toEqual([])
        await expect(
          run(Nodes.saveNodeUpgradeState(node.source, { ...state, phase: 'cancelled' })),
        ).rejects.toMatchObject({ code: 'upgrade_conflict' })
        expect(await run(Nodes.saveNodeUpgradeState(node.source, { ...state, phase: 'ready' }))).toMatchObject({
          phase: 'ready',
          ok: true,
        })
        expect(await run(Nodes.getNode(node.employeeId, node.nodeId))).toMatchObject({
          upgrade_state: { phase },
          executable: false,
        })
        if (phase === 'migrating') {
          await run(Nodes.saveNodeUpgradeState(node.source, { ...state, phase: 'failed' }))
          await expect(
            run(Nodes.saveNodeUpgradeState(node.source, { ...state, phase: 'cancelled' })),
          ).rejects.toMatchObject({ code: 'upgrade_conflict' })
        }
      }
    }
    const final = { ...state, phase: finalPhase }
    const receipt = await run(Nodes.saveNodeUpgradeState(node.source, final))
    expect(await run(Nodes.saveNodeUpgradeState(node.source, final))).toEqual(receipt)
    if (finalPhase === 'completed') {
      await expect(
        run(Nodes.saveNodeUpgradeState(node.source, { ...state, phase: 'cancelled' })),
      ).rejects.toMatchObject({ code: 'upgrade_conflict' })
      for (const phase of ['draining', 'ready', 'migrating', 'syncing', 'failed'] as const) {
        expect(await run(Nodes.saveNodeUpgradeState(node.source, { ...state, phase }))).toMatchObject({
          phase,
          ok: true,
        })
      }
    }
    expect(await run(Nodes.getNode(node.employeeId, node.nodeId))).toMatchObject({
      upgrade_state: { phase: finalPhase },
      executable: true,
    })
    const delivered = await run(Threads.claimCommands())
    expect(delivered).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ body: expect.objectContaining({ action: 'message', thread_id: opened.id }) }),
        expect.objectContaining({ body: expect.objectContaining({ action: 'open', thread_id: unopened.id }) }),
      ]),
    )
    const message = delivered.find(({ body }) => body.action === 'message' && body.thread_id === opened.id)!
    await run(
      Threads.processReceipt(node.source, message.message_id, {
        type: 'thread.command_result',
        thread_id: opened.id,
        ok: true,
        storage_generation: 'generation',
      }),
    )
    expect(await run(Threads.claimCommands())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ body: expect.objectContaining({ action: 'resume', thread_id: opened.id }) }),
      ]),
    )
    expect(
      (await run(Projects.claimProjectCommands('project_run_start'))).map((delivery) => delivery.command.project_id),
    ).toEqual([project.id])
    expect(
      (await run(Projects.claimProjectCommands('project_memory_start'))).map((delivery) => delivery.command.run_id),
    ).toEqual([runId])
    await run(Projects.scheduleProjectRun(waiting.agent.id))
    expect((await run(Projects.projectStatus(node.employeeId, waiting.id))).run?.state).toBe('starting')
    if (finalPhase === 'completed') {
      const skipped = { ...state, operation_id: randomUUID(), phase: 'ready' as const }
      await run(Nodes.saveNodeUpgradeState(node.source, skipped))
      await run(Nodes.saveNodeUpgradeState(node.source, { ...skipped, phase: 'failed' }))
      expect(await run(Nodes.saveNodeUpgradeState(node.source, skipped))).toMatchObject({ phase: 'ready', ok: true })
      expect(await run(Nodes.getNode(node.employeeId, node.nodeId))).toMatchObject({
        upgrade_state: { operation_id: skipped.operation_id, phase: 'failed' },
        executable: false,
      })
      await run(Nodes.saveNodeUpgradeState(node.source, { ...skipped, phase: 'syncing' }))
      expect(await run(Nodes.saveNodeUpgradeState(node.source, { ...skipped, phase: 'failed' }))).toMatchObject({
        phase: 'failed',
        ok: true,
      })
      expect(await run(Nodes.getNode(node.employeeId, node.nodeId))).toMatchObject({
        upgrade_state: { operation_id: skipped.operation_id, phase: 'syncing' },
        executable: false,
      })
      for (const phase of ['draining', 'migrating', 'cancelled'] as const) {
        await expect(run(Nodes.saveNodeUpgradeState(node.source, { ...skipped, phase }))).rejects.toMatchObject({
          code: 'upgrade_conflict',
        })
      }
      await run(Nodes.saveNodeUpgradeState(node.source, { ...skipped, phase: 'completed' }))
      for (const phase of ['ready', 'failed'] as const) {
        expect(await run(Nodes.saveNodeUpgradeState(node.source, { ...skipped, phase }))).toMatchObject({
          phase,
          ok: true,
        })
      }
      await expect(
        run(Nodes.saveNodeUpgradeState(node.source, { ...skipped, phase: 'migrating' })),
      ).rejects.toMatchObject({ code: 'upgrade_conflict' })
      expect(await run(Nodes.getNode(node.employeeId, node.nodeId))).toMatchObject({
        upgrade_state: { operation_id: skipped.operation_id, phase: 'completed' },
        executable: true,
      })
    }
  }),
)
