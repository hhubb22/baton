import { expect, it, vi } from 'vite-plus/test'
import { createExecutionAPI } from './executions'
import type { HttpContext } from './context'

it('reads project executions and stops an execution through its own endpoints', async () => {
  const execution = {
    id: 'execution-1',
    project_id: 'project-1',
    node_id: 'node-1',
    origin_conversation_id: 'conversation-1',
    origin_tool_call_id: 'call-1',
    command: 'pwd',
    working_directory: '/work',
    timeout_seconds: 60,
    status: 'running',
    created_at: '2026-10-30T00:00:00Z',
  }
  const request = vi.fn(async (path: string) =>
    path.startsWith('/executions?') ? { executions: [execution] } : execution,
  )
  const emit = vi.fn()
  const api = createExecutionAPI({ request, emit } as unknown as HttpContext)
  expect(await api.listProjectExecutions!('project-1')).toMatchObject([
    { id: 'execution-1', command: 'pwd', status: 'running' },
  ])
  expect(await api.getExecution!('execution-1')).toMatchObject({ deviceId: 'node-1' })
  await api.stopExecution!('execution-1')
  expect(request).toHaveBeenCalledWith('/executions/execution-1/stop', { method: 'POST' })
  expect(emit).toHaveBeenCalledWith('projects')
})
