import { createMemoryHistory } from '@tanstack/react-router'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientError } from '../data/client'
import { createMockClient } from '../data/mock/client'
import type { ScenarioId } from '../data/mock/scenarios'
import { manualScheduler } from '../data/mock/scheduler'
import { browserLatency } from '../data/mock/store'
import { App } from './App'
import { createAppRouter } from './router'

function setup(
  path = '/inbox',
  scenario: ScenarioId = 'normal',
  configure?: (client: ReturnType<typeof createMockClient>) => void,
) {
  const scheduler = manualScheduler()
  const client = createMockClient(scenario, { scheduler, latency: browserLatency })
  configure?.(client)
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) })
  render(<App client={client} router={router} />)
  return { client, router }
}

const pathsQuestion = 'Skip Windows path tests for now?'
const runnerQuestion = 'Which runner should run nightly?'
beforeEach(() => localStorage.clear())

describe('inbox decisions', () => {
  it.each(['/projects/prj-compat', '/threads/thr-compat'])(
    'retries loading questions without losing the conversation at %s',
    async (path) => {
      const user = userEvent.setup()
      let failing = true
      setup(path, 'normal', (client) => {
        const list = client.listInbox
        vi.spyOn(client, 'listInbox').mockImplementation(() =>
          failing ? Promise.reject(new ClientError('unavailable', 'Could not load')) : list(),
        )
      })
      expect(await screen.findByText('Could not load questions')).toBeInTheDocument()
      const conversation = screen.getByRole('region', {
        name: path.startsWith('/projects') ? 'Conversation' : 'Messages',
      })
      expect(conversation).toHaveTextContent(/Windows|Ubuntu/)
      expect(screen.queryByRole('region', { name: pathsQuestion })).not.toBeInTheDocument()
      failing = false
      await user.click(screen.getByRole('button', { name: 'Retry questions' }))
      expect(await screen.findByRole('region', { name: pathsQuestion })).toBeInTheDocument()
      expect(screen.queryByText('Could not load questions')).not.toBeInTheDocument()
    },
  )

  it('collapses details, shows newest first, and saves one answer across all three locations', async () => {
    const user = userEvent.setup()
    const { router, client } = setup()
    const card = await screen.findByRole('region', { name: pathsQuestion })
    expect(screen.queryByText('2 tests fail only on Windows because of drive letters.')).not.toBeInTheDocument()
    const cards = screen.getAllByRole('region').filter((node) => node.getAttribute('aria-label')?.endsWith('?'))
    expect(cards[0]).toHaveAccessibleName(runnerQuestion)
    expect(document.title).toBe('(2) Baton')
    await user.click(within(card).getByRole('button', { name: /Fix them before merging/ }))
    await user.type(within(card).getByLabelText('Note (optional)'), 'Keep the regression tests.')
    await user.click(within(card).getByRole('button', { name: 'Send reply' }))
    const recent = await screen.findByRole('region', { name: 'Latest result' })
    expect(await within(recent).findByText(/Fix them before merging · Keep the regression tests/)).toBeInTheDocument()
    await waitFor(() => expect(document.title).toBe('(1) Baton'))
    await act(() =>
      router.navigate({
        to: '/projects/$projectId',
        params: { projectId: 'prj-compat' },
        search: { thread: 'thr-compat' },
      }),
    )
    const shared = await screen.findAllByRole('region', { name: pathsQuestion })
    expect(shared).toHaveLength(2)
    for (const item of shared) {
      expect(within(item).getByText('Answered')).toBeInTheDocument()
      expect(within(item).getByText(/Keep the regression tests/)).toBeInTheDocument()
      expect(within(item).queryByRole('button', { name: 'Send reply' })).not.toBeInTheDocument()
    }
    expect(
      (await client.listProjectEntries('prj-compat')).filter(
        (entry) => entry.kind === 'user' && entry.body.includes('itm-compat-paths'),
      ),
    ).toHaveLength(1)
  })

  it('keeps a shared draft on navigation and preserves the effective answer on conflict', async () => {
    const user = userEvent.setup()
    const { router } = setup('/inbox', 'conflict')
    const card = await screen.findByRole('region', { name: pathsQuestion })
    await user.click(within(card).getByRole('button', { name: /Skip them and open a follow-up/ }))
    await user.type(within(card).getByLabelText('Note (optional)'), 'Tomorrow')
    await act(() => router.navigate({ to: '/projects/$projectId', params: { projectId: 'prj-compat' } }))
    const inProject = await screen.findByRole('region', { name: pathsQuestion })
    expect(within(inProject).getByLabelText('Note (optional)')).toHaveValue('Tomorrow')
    await act(() => router.navigate({ to: '/inbox' }))
    const again = await screen.findByRole('region', { name: pathsQuestion })
    await user.click(within(again).getByRole('button', { name: 'Send reply' }))
    const result = await screen.findByRole('region', { name: 'Latest result' })
    expect(await within(result).findByRole('alert')).toHaveTextContent('Already answered: Fix them before merging')
    expect(within(result).getByText(/Fix them before merging · Kaken/)).toBeInTheDocument()
  })

  it('validates text replies, retains them on failure, and saves while paused', async () => {
    const user = userEvent.setup()
    const { client } = setup('/inbox', 'inboxPaused')
    const card = await screen.findByRole('region', { name: 'What should the release notes mention?' })
    await user.click(within(card).getByRole('button', { name: 'Reply with text' }))
    await user.click(within(card).getByRole('button', { name: 'Send reply' }))
    expect(within(card).getByText('Enter a reply.')).toBeInTheDocument()
    await user.type(within(card).getByLabelText('Your reply'), 'Mention Windows support.')
    act(() => client.controls.setReachable(false))
    await user.click(within(card).getByRole('button', { name: 'Send reply' }))
    expect(await within(card).findByText(/Your reply could not be saved/)).toBeInTheDocument()
    expect(within(card).getByLabelText('Your reply')).toHaveValue('Mention Windows support.')
    act(() => client.controls.setReachable(true))
    await user.click(within(card).getByRole('button', { name: 'Send reply' }))
    const result = await screen.findByRole('region', { name: 'Latest result' })
    expect(await within(result).findByText(/when the project resumes/)).toBeInTheDocument()
  })

  it('shows a withdrawal that won while replying and keeps historical details accessible', async () => {
    const user = userEvent.setup()
    const { router } = setup('/inbox', 'inboxWithdrawn')
    const card = await screen.findByRole('region', { name: pathsQuestion })
    await user.click(within(card).getByRole('button', { name: 'Close question' }))
    const result = await screen.findByRole('region', { name: 'Latest result' })
    expect(await within(result).findByText('Withdrawn')).toBeInTheDocument()
    expect(within(result).getByText('A newer test run replaced this question.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Handled items' }))
    expect(router.state.location.search).toMatchObject({ handled: true })
    const history = await screen.findByRole('region', { name: pathsQuestion })
    await user.click(within(history).getByRole('button', { name: 'Show details' }))
    expect(within(history).getByText('2 tests fail only on Windows because of drive letters.')).toBeInTheDocument()
  })

  it('has no reply form for system notices and keeps retry available after closing the notice', async () => {
    const user = userEvent.setup()
    const { router, client } = setup('/inbox', 'error')
    const card = await screen.findByRole('region', { name: 'ChatGPT sign-in expired' })
    expect(within(card).queryByRole('textbox')).not.toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: 'Reply with text' })).not.toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: 'Close notice' }))
    // 场景的第一次保存失败，通知和入口保留。
    expect(await within(card).findByRole('alert')).toHaveTextContent('Could not close')
    await user.click(within(card).getByRole('button', { name: 'Close notice' }))
    const recent = await screen.findByRole('region', { name: 'Latest result' })
    expect(await within(recent).findByText('Closed')).toBeInTheDocument()
    await act(() => router.navigate({ to: '/projects/$projectId', params: { projectId: 'prj-baton' } }))
    expect((await screen.findAllByText('Needs attention')).length).toBeGreaterThan(0)
    act(() => client.controls.setDeviceConnection('dev-mac', 'online'))
    await user.click(await screen.findByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument())
    expect((await client.listProjects()).find((project) => project.id === 'prj-baton')?.agent.state).toBe('running')
    expect((await client.listInbox()).find((item) => item.id === 'itm-baton-signin')?.status).toBe('closed')
  })
})
