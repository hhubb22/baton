import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vite-plus/test'
import type { Project, RuntimeProvider, RuntimeReport } from '@baton/protocol'
import { seedNode, withTestDatabase } from '../testing/database.ts'
import * as projects from './projects.ts'

const report = (status: RuntimeProvider['status'], capacity = 4): RuntimeReport => ({
  project_runtime: {
    version: '0.1.0',
    max_concurrent_projects: capacity,
    providers: [{ provider: 'openai-codex', status }],
  },
  roots: [],
  repos: [],
  exec: { enabled: false, shell: '/bin/sh' },
})

const statuses: RuntimeProvider['status'][] = ['unknown', 'login_required']
describe('Project provider admission and capacity', () => {
  it('binds an API connection to its owning device and rejects another employee’s device', async () => {
    await withTestDatabase(async ({ run }) => {
      const provider = `api-${randomUUID()}`
      const apiReport: RuntimeReport = {
        ...report('available'),
        project_runtime: { version: '0.1.0', providers: [{ provider, status: 'available' }] },
      }
      const owner = await seedNode(run, { report: apiReport, online: false })
      await seedNode(run, { employeeId: owner.employeeId, report: apiReport })
      const other = await seedNode(run, { report: apiReport })
      await expect(
        run(
          projects.createProject(owner.employeeId, {
            title: 'Foreign',
            provider,
            model: 'test',
            source_node_id: other.nodeId,
          }),
        ),
      ).rejects.toBeDefined()
      const project = await run(
        projects.createProject(owner.employeeId, {
          title: 'Local',
          provider,
          model: 'test',
          source_node_id: owner.nodeId,
        }),
      )
      await run(
        projects.acceptProjectMessage(owner.employeeId, project.id, {
          client_message_id: randomUUID(),
          content: 'start',
        }),
      )
      await run(projects.scheduleProjectRun(project.agent.id))
      const state = await run(projects.projectStatus(owner.employeeId, project.id))
      expect(state.run).toBeUndefined()
      expect(state.waiting_reason).toBe('all_devices_offline')
      await expect(
        run(projects.patchProject(owner.employeeId, project.id, { source_node_id: other.nodeId })),
      ).rejects.toBeDefined()
    })
  })
  it.each(statuses)('uses the declared provider authentication state %s', async (status) => {
    await withTestDatabase(async ({ run }) => {
      const node = await seedNode(run, { report: report(status) })
      const project = await run(
        projects.createProject(node.employeeId, {
          title: 'Admission',
          goal: '',
          provider: 'openai-codex',
          model: 'gpt-5',
        }),
      )
      await run(
        projects.acceptProjectMessage(node.employeeId, project.id, {
          client_message_id: randomUUID(),
          content: 'start',
        }),
      )
      await run(projects.scheduleProjectRun(project.agent.id))
      const state = await run(projects.projectStatus(node.employeeId, project.id))
      if (status === 'unknown') expect(state.run?.state).toBe('starting')
      else expect(state.waiting_reason).toBe('login_required')
    })
  })

  it('shows a concrete credential security failure in the run end reason', async () => {
    await withTestDatabase(async ({ run }) => {
      const node = await seedNode(run, { report: report('unknown') })
      const project = await run(
        projects.createProject(node.employeeId, {
          title: 'Credentials',
          goal: '',
          provider: 'openai-codex',
          model: 'gpt-5',
        }),
      )
      await run(
        projects.acceptProjectMessage(node.employeeId, project.id, {
          client_message_id: randomUUID(),
          content: 'start',
        }),
      )
      await run(projects.scheduleProjectRun(project.agent.id))
      const [delivery] = await run(projects.claimProjectCommands('project_run_start'))
      if (!delivery) throw new Error('启动命令缺失')
      await run(
        projects.runtimeRequest(node.source, {
          type: 'project_runtime.request',
          run_id: delivery.command.run_id,
          lease_epoch: delivery.command.lease_epoch,
          operation: 'start_failed',
          reason: 'credential_permissions_invalid',
        }),
      )
      expect((await run(projects.projectStatus(node.employeeId, project.id))).run?.end_reason).toBe(
        'credential_permissions_invalid',
      )
    })
  })

  it('uses the advertised capacity and retains a slot until stopped is acknowledged', async () => {
    await withTestDatabase(async ({ run }) => {
      const node = await seedNode(run, { report: report('available', 6) })
      const pending: Project[] = []
      for (let index = 0; index < 7; index++) {
        const project = await run(
          projects.createProject(node.employeeId, {
            title: `Capacity ${index}`,
            goal: '',
            provider: 'openai-codex',
            model: 'gpt-5',
          }),
        )
        await run(
          projects.acceptProjectMessage(node.employeeId, project.id, {
            client_message_id: randomUUID(),
            content: 'start',
          }),
        )
        pending.push(project)
      }
      await Promise.all(pending.map((project) => run(projects.scheduleProjectRun(project.agent.id))))
      const deliveries = await run(projects.claimProjectCommands('project_run_start'))
      expect(deliveries.length).toBeGreaterThan(0)
      let running = 0
      const waiting: Project[] = []
      for (const project of pending) {
        const state = await run(projects.projectStatus(node.employeeId, project.id))
        if (!state.run) {
          expect(state.waiting_reason).toBe('capacity')
          waiting.push(project)
        } else running++
      }
      expect(running).toBe(6)
      expect(waiting).toHaveLength(1)
      const [blocked] = waiting
      const [active] = deliveries
      if (!blocked || !active || !active.command.project_id) throw new Error('调度结果缺失')
      await run(projects.patchProject(node.employeeId, active.command.project_id, { status: 'paused' }))
      await run(projects.scheduleProjectRun(blocked.agent.id))
      expect((await run(projects.projectStatus(node.employeeId, blocked.id))).waiting_reason).toBe('capacity')
      await run(
        projects.runtimeRequest(node.source, {
          type: 'project_runtime.request',
          run_id: active.command.run_id,
          lease_epoch: active.command.lease_epoch,
          operation: 'stopped',
        }),
      )
      await run(projects.scheduleProjectRun(blocked.agent.id))
      expect((await run(projects.projectStatus(node.employeeId, blocked.id))).run?.state).toBe('starting')
    })
  }, 30000)
})
