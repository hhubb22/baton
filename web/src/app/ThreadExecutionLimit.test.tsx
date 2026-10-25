import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vite-plus/test'
import { createMockClient } from '../data/mock/client'
import { ClientProvider } from '../data/queries'
import type { Thread } from '../data/types'
import { ThreadExecutionLimit } from './ThreadExecutionLimit'

it('keeps edits made while a previous time limit is being saved', async () => {
  const client = createMockClient('normal', { latency: { read: 0, save: 0, device: 0, run: 0 } })
  const thread = (await client.listThreads()).find((item) => item.status !== 'archived')
  if (!thread) throw new Error('Expected an editable Thread')
  let complete: (value: Thread) => void = () => {
    throw new Error('Save has not started')
  }
  const saved = new Promise<Thread>((resolve) => {
    complete = resolve
  })
  client.setThreadExecutionLimit = () => saved
  const user = userEvent.setup()
  render(
    <ClientProvider client={client}>
      <ThreadExecutionLimit thread={thread} />
    </ClientProvider>,
  )
  await user.click(screen.getByText(/Time per reply ·/))
  const input = screen.getByLabelText('Time per reply (seconds)')
  await user.clear(input)
  await user.type(input, '3600')
  await user.click(screen.getByRole('button', { name: 'Save time limit' }))
  await user.clear(input)
  await user.type(input, '14400')
  await act(async () => complete({ ...thread, executionTimeoutSeconds: 3600 }))
  await screen.findByRole('status')
  expect(input).toHaveValue(14400)
})
