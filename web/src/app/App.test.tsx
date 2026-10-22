import { createMemoryHistory } from '@tanstack/react-router'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
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

  it('asks for sign-in and accepts the sample account', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/inbox', 'signedOut')
    await user.type(await screen.findByLabelText('Username'), 'kaken')
    await user.type(screen.getByLabelText('Password'), 'wrong')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Username or password is incorrect.')).toBeInTheDocument()

    await user.clear(screen.getByLabelText('Password'))
    await user.type(screen.getByLabelText('Password'), 'sample-password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('link', { name: /Rebuild web UI foundation/ })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/threads')
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
