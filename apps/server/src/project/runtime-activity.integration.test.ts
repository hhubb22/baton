import { randomUUID } from 'node:crypto'
import { Effect, type Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import type * as P from '@baton/protocol'
import { expect, it } from 'vite-plus/test'
import { seedNode, withTestDatabase } from '../testing/database.ts'
import { contextualRuntimeRequest } from '../testing/project-context.ts'
import * as projects from './projects.ts'
import { scheduleMemoryJobs } from './memory-jobs.ts'

it('renews new foreground claims, first successful tools and live leases, excluding duplicates, failures and memory work', () =>
  withTestDatabase(async ({ run }) => {
    const node = await seedNode(run, {
      report: {
        roots: [],
        repos: [],
        exec: { enabled: false, shell: '/bin/sh' },
        project_runtime: {
          version: 'offline',
          memory_protocol: 1,
          providers: [{ provider: 'openai-codex', status: 'available' }],
        },
      },
    })
    const project = await run(
      projects.createProject(node.employeeId, {
        title: 'Activity',
        goal: '',
        provider: 'openai-codex',
        model: 'offline',
      }),
    )
    await run(
      projects.acceptProjectMessage(node.employeeId, project.id, { client_message_id: randomUUID(), content: 'hello' }),
    )
    await run(projects.scheduleProjectRun(project.agent.id))
    const [delivery] = await run(projects.claimProjectCommands('project_run_start'))
    const identity = { run_id: delivery!.command.run_id, lease_epoch: delivery!.command.lease_epoch }
    const rpc = (operation: P.ProjectRuntimeRequest['operation'], extra: Partial<P.ProjectRuntimeRequest> = {}) =>
      run(contextualRuntimeRequest(node.source, { type: 'project_runtime.request', ...identity, operation, ...extra }))
    const state = () =>
      run(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) =>
            sql`SELECT expires_at::text,last_business_at::text FROM node_credentials WHERE id=${node.credentialId}`,
        ),
      )
    const reset = async () => {
      await run(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) =>
            sql`UPDATE node_credentials SET expires_at=clock_timestamp()+interval '1 day',last_business_at=clock_timestamp()-interval '29 days' WHERE id=${node.credentialId}`,
        ),
      )
      return state()
    }
    await rpc('started')
    const claimBefore = await reset()
    await rpc('claim_inputs', { last_seq: 0 })
    expect(await state()).not.toEqual(claimBefore)
    const emptyBefore = await reset()
    expect(await rpc('claim_inputs', { last_seq: 1 })).toMatchObject({ input_count: 0 })
    await rpc('bootstrap')
    expect(await state()).toEqual(emptyBefore)
    const assistant = (content: Schema.Json[]) => ({
      format: 'pi-ai/1',
      message: { role: 'assistant', stopReason: 'stop', content },
    })
    await rpc('append_event', {
      last_seq: 1,
      client_event_id: 'tools',
      payload: assistant([
        { type: 'toolCall', id: 'list', name: 'devices.list', arguments: {} },
        { type: 'toolCall', id: 'bad', name: 'threads.get', arguments: {} },
      ]),
    })
    const toolBefore = await reset()
    const request = { last_seq: 2, tool_call_id: 'list', tool_name: 'devices.list', arguments: {} }
    const tool = await rpc('call_tool', request)
    expect(await state()).not.toEqual(toolBefore)
    const duplicateBefore = await reset()
    expect(await rpc('call_tool', request)).toEqual(tool)
    await rpc('call_tool', { last_seq: 3, tool_call_id: 'bad', tool_name: 'threads.get', arguments: {} })
    expect(await state()).toEqual(duplicateBefore)
    await rpc('started')
    await rpc('renew')
    expect(await state()).toEqual(duplicateBefore)
    await rpc('renew', { payload: { host_check_seq: 1 } })
    expect(await state()).not.toEqual(duplicateBefore)
    const renewed = await reset()
    await rpc('renew', { payload: { host_check_seq: 1 } })
    expect(await state()).toEqual(renewed)
    await rpc('renew', { payload: { host_check_seq: 2 } })
    expect(await state()).not.toEqual(renewed)
    await rpc('append_event', {
      last_seq: 4,
      client_event_id: 'done',
      payload: assistant([{ type: 'text', text: 'done' }]),
    })
    await rpc('finish')
    await rpc('stopped')
    await run(scheduleMemoryJobs())
    const [background] = await run(projects.claimProjectCommands('project_memory_start'))
    expect(background).toBeDefined()
    const memoryBefore = await reset()
    for (const operation of ['started', 'renew', 'memory_bootstrap'] as const) {
      await run(
        projects.runtimeRequest(node.source, {
          type: 'project_runtime.request',
          run_id: background!.command.run_id,
          lease_epoch: background!.command.lease_epoch,
          operation,
        }),
      )
    }
    expect(await state()).toEqual(memoryBefore)
  }))
