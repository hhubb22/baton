import { createMemoryHistory } from '@tanstack/react-router'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMockClient } from '../data/mock/client'
import type { ScenarioId } from '../data/mock/scenarios'
import { manualScheduler } from '../data/mock/scheduler'
import { browserLatency } from '../data/mock/store'
import { App } from './App'
import { createAppRouter } from './router'

function renderApp(path: string, scenario: ScenarioId = 'normal') {
  const scheduler = manualScheduler()
  const client = createMockClient(scenario, { scheduler, latency: browserLatency })
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) })
  render(<App client={client} router={router} />)
  return { client, scheduler, router }
}

beforeEach(() => localStorage.clear())

async function signIn(user: ReturnType<typeof userEvent.setup>, password = 'sample-password') {
  await user.type(screen.getByLabelText('Password'), password)
  await user.click(screen.getByRole('button', { name: /Sign in|Try signing in again/ }))
}

async function openAccountMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /Kaken He/ }))
}

describe('app', () => {
  it('shows the first-visit guide when no device is connected', async () => {
    renderApp('/', 'empty')
    expect(await screen.findByRole('heading', { name: 'Connect your first device' })).toBeInTheDocument()
    expect(screen.getByText('No projects yet')).toBeInTheDocument()
  })

  it('opens Threads when devices exist', async () => {
    const { router } = renderApp('/')
    expect(await screen.findByRole('link', { name: /Rebuild web UI foundation/ })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/threads')
  })

  it('keeps the username after invalid credentials and returns to the requested page', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/inbox', 'signedOut')
    await user.type(await screen.findByLabelText('Username'), 'kaken')
    await signIn(user, 'wrong')
    expect(await screen.findByText('Invalid username or password.')).toBeInTheDocument()
    expect(screen.getByLabelText('Username')).toHaveValue('kaken')
    expect(screen.getByLabelText('Password')).toHaveValue('')
    expect(screen.getByLabelText('Password')).toHaveFocus()

    await signIn(user)
    expect(await screen.findByRole('heading', { name: 'Inbox' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/inbox')
  })

  it('explains an expired sign-in and returns to the same thread', async () => {
    const user = userEvent.setup()
    const { client, router } = renderApp('/threads/thr-webui')
    expect(await screen.findByRole('heading', { name: 'Rebuild web UI foundation' })).toBeInTheDocument()

    act(() => client.controls.endSession('expired'))
    expect(await screen.findByText('Your sign-in expired')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Username'), 'kaken')
    await signIn(user)
    expect(await screen.findByRole('heading', { name: 'Rebuild web UI foundation' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/threads/thr-webui')
  })

  it('asks for the new password after an administrator reset', async () => {
    const { client } = renderApp('/devices')
    expect(await screen.findByRole('heading', { name: 'Devices' })).toBeInTheDocument()
    act(() => client.controls.endSession('passwordReset'))
    expect(await screen.findByText('Password reset by administrator')).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toHaveAttribute('placeholder', 'New password')
  })

  it('keeps the form when Baton cannot be reached', async () => {
    const user = userEvent.setup()
    const { client, router } = renderApp('/login', 'signedOut')
    await user.type(await screen.findByLabelText('Username'), 'kaken')
    client.controls.setReachable(false)
    await signIn(user)
    expect(await screen.findByText('Baton could not be reached')).toBeInTheDocument()
    expect(screen.getByLabelText('Username')).toHaveValue('kaken')
    expect(screen.getByLabelText('Password')).toHaveValue('sample-password')

    client.controls.setReachable(true)
    await user.click(screen.getByRole('button', { name: 'Try signing in again' }))
    expect(await screen.findByRole('link', { name: /Rebuild web UI foundation/ })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/threads')
  })

  it('signs out to an empty sign-in form', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/threads')
    await openAccountMenu(user)
    await user.click(await screen.findByRole('button', { name: 'Sign out' }))
    expect(await screen.findByText('You are signed out')).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toHaveValue('')
    expect(router.state.location.search).toEqual({ notice: 'signedOut' })
  })

  it('stays signed in and offers a retry when sign-out cannot be confirmed', async () => {
    const user = userEvent.setup()
    const { client } = renderApp('/threads')
    await openAccountMenu(user)
    client.controls.setReachable(false)
    await user.click(await screen.findByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('heading', { name: 'Could not sign out' })).toBeInTheDocument()

    client.controls.setReachable(true)
    await user.click(screen.getByRole('button', { name: 'Retry sign-out' }))
    expect(await screen.findByText('You are signed out')).toBeInTheDocument()
  })

  it('collapses the sidebar to icons and remembers it', async () => {
    const user = userEvent.setup()
    renderApp('/threads')
    const sidebar = await screen.findByRole('navigation', { name: 'Workspace' })
    expect(await within(sidebar).findByRole('link', { name: /Baton/ })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument()
    expect(within(sidebar).queryByText('Projects')).not.toBeInTheDocument()
    expect(within(sidebar).getByRole('link', { name: 'Threads' })).toHaveAttribute('aria-current', 'page')
    expect(within(sidebar).getByRole('button', { name: 'New chat' })).toBeInTheDocument()
    expect(localStorage.getItem('baton.sidebar.collapsed')).toBe('true')

    await user.click(screen.getByRole('button', { name: 'Expand sidebar' }))
    expect(within(sidebar).getByText('Projects')).toBeInTheDocument()
  })

  it('moves between pages and projects with the current one selected', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/threads')
    const sidebar = await screen.findByRole('navigation', { name: 'Workspace' })
    await user.click(await within(sidebar).findByRole('link', { name: /Baton/ }))
    expect(router.state.location.pathname).toBe('/projects/prj-baton')
    expect(within(sidebar).getByRole('link', { name: /Baton/ })).toHaveAttribute('aria-current', 'page')
    expect(within(sidebar).getByRole('link', { name: /Threads/ })).not.toHaveAttribute('aria-current')

    await user.click(within(sidebar).getByRole('link', { name: /Inbox/ }))
    expect(router.state.location.pathname).toBe('/inbox')
    expect(within(sidebar).getByRole('link', { name: /Inbox/ })).toHaveAttribute('aria-current', 'page')
  })

  it('updates thread, project and file preview when a device goes offline', async () => {
    const user = userEvent.setup()
    const { client, router } = renderApp('/threads/thr-webui')
    await user.click(await screen.findByRole('button', { name: '~/src/baton/README.md' }))
    const preview = await screen.findByRole('complementary', { name: 'File preview' })
    expect(await within(preview).findByText(/Baton/)).toBeInTheDocument()

    act(() => client.controls.setDeviceConnection('dev-mac', 'offline'))
    expect(await within(preview).findByText('MacBook Pro is offline')).toBeInTheDocument()
    expect(within(preview).queryByText(/^# /)).not.toBeInTheDocument()
    expect(screen.getAllByText('MacBook Pro is offline')).toHaveLength(2)

    act(() => client.controls.setDeviceConnection('dev-ubuntu', 'offline'))
    await act(() => router.navigate({ to: '/projects/$projectId', params: { projectId: 'prj-baton' } }))
    expect(await screen.findByText('Project assistant is waiting for a device')).toBeInTheDocument()
  })

  it('shows send phases until the agent replies', async () => {
    const user = userEvent.setup()
    const { scheduler } = renderApp('/threads/thr-webui')
    await user.type(await screen.findByLabelText('Message'), 'Add dark theme{Enter}')
    expect(await screen.findByText('Add dark theme')).toBeInTheDocument()

    act(() => scheduler.advance(browserLatency.save))
    expect(await screen.findByRole('heading', { name: 'Rebuild web UI foundation' })).toBeInTheDocument()
    expect(await screen.findByText('Running')).toBeInTheDocument()

    act(() => scheduler.advance(browserLatency.run))
    expect(await screen.findByText('Idle')).toBeInTheDocument()
  })
})
