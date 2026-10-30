import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vite-plus/test'
import type { Execution } from '../data/types'
import { ClientProvider } from '../data/queries'
import type { BatonClient } from '../data/client'
import { ExecutionDetail } from './ExecutionDetail'

it('shows the execution and waits for the stop response before displaying the new state', async () => {
  const execution: Execution = {
    id: 'execution-1',
    projectId: 'project-1',
    deviceId: 'node-1',
    originConversationId: 'conversation-1',
    originToolCallId: 'call-1',
    command: 'pwd',
    workingDirectory: '/work',
    timeoutSeconds: 60,
    status: 'running',
    createdAt: 1,
  }
  const stop = vi.fn(async () => ({ ...execution, status: 'cancelled' as const, exitCode: 130 }))
  const client = {
    getExecution: async () => execution,
    stopExecution: stop,
    listDevices: async () => [],
    subscribe: () => () => {},
  } as unknown as BatonClient
  render(
    <ClientProvider client={client}>
      <ExecutionDetail id="execution-1" projectId="project-1" onClose={() => {}} />
    </ClientProvider>,
  )
  expect(await screen.findByText('pwd')).toBeInTheDocument()
  await userEvent.setup().click(screen.getByRole('button', { name: '停止执行' }))
  expect(await screen.findByText('已停止')).toBeInTheDocument()
  expect(screen.getByText('退出码 130')).toBeInTheDocument()
  expect(stop).toHaveBeenCalledWith('execution-1')
})
