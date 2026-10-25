import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vite-plus/test'
import type { Trace } from '../data/types'
import { ActivityTrace } from './ReplyParts'

vi.mock('../data/queries', () => ({
  useTrace: () => ({
    isPending: false,
    isError: false,
    data: {
      state: 'ready',
      messageId: 'reply',
      steps: [
        { kind: 'command', command: 'printf', output: 'Saved fragment', truncated: true },
        { kind: 'tool', name: 'Read', detail: 'Saved detail', truncated: true },
        { kind: 'file', action: 'edited', path: '/work/source.ts', truncated: false },
      ],
    } satisfies Trace,
  }),
}))

it('shows available trace content and marks only truncated steps', async () => {
  const user = userEvent.setup()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ActivityTrace
        device={undefined}
        message={{
          id: 'reply',
          threadId: 'thread',
          role: 'agent',
          sender: 'agent',
          body: 'Reply',
          createdAt: 0,
          delivery: 'delivered',
          activity: { commands: 1, tools: 1, files: 1 },
          attachments: [],
        }}
      />
    </QueryClientProvider>,
  )
  await user.click(screen.getByRole('button'))
  expect(screen.getByText('Saved fragment')).toBeInTheDocument()
  expect(screen.getByText('Read · Saved detail')).toBeInTheDocument()
  expect(screen.getByText('Edited source.ts')).toBeInTheDocument()
  expect(screen.getAllByText('Activity truncated')).toHaveLength(2)
  expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
})
