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

describe('devices', () => {
  function deviceRow(name: string) {
    return screen.getByRole('button', { name: new RegExp(`^${name}`) })
  }

  it('connects a device with a setup code and updates the counts', async () => {
    const user = userEvent.setup()
    const { client, scheduler } = renderApp('/devices', 'empty')
    await user.click(await screen.findByRole('button', { name: 'Connect a device' }))
    const dialog = await screen.findByRole('dialog', { name: 'Connect a device' })
    expect(await within(dialog).findByText('Setup code (expires in 10 minutes)')).toBeInTheDocument()

    await user.type(within(dialog).getByLabelText('Device name'), 'Build Server')
    await user.click(within(dialog).getByRole('radio', { name: 'Linux' }))
    const command = within(dialog).getByLabelText('Run this in your terminal')
    expect(command).toHaveTextContent('read -rs BATON_ENROLLMENT_TOKEN && export BATON_ENROLLMENT_TOKEN')
    expect(command).toHaveTextContent('--display-name "Build Server" --system linux')
    expect(command.textContent).not.toMatch(/[A-Za-z0-9]{8}-[A-Za-z0-9]{4}-/)

    await user.click(within(dialog).getByRole('button', { name: 'Copy command' }))
    expect(await within(dialog).findByText(/Command copied/)).toBeInTheDocument()

    act(() => client.controls.connectEnrollment('Build Server', 'Linux'))
    expect(await within(dialog).findByText('Connected')).toBeInTheDocument()
    expect(within(dialog).getByText('Linux · Checking availability…')).toBeInTheDocument()
    act(() => scheduler.advance(browserLatency.device))
    expect(await within(dialog).findByText('Linux · Codex and Pi available')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    expect(screen.getByRole('heading', { name: '1 device, 1 online' })).toHaveFocus()
    const sidebar = screen.getByRole('navigation', { name: 'Workspace' })
    expect(within(sidebar).getByText('1/1 online')).toBeInTheDocument()
    expect(within(deviceRow('Build Server')).getByText('Default device')).toBeInTheDocument()
  })

  it('gets a new code after the old one expires and keeps the form', async () => {
    const user = userEvent.setup()
    const { client } = renderApp('/devices')
    await user.click(await screen.findByRole('button', { name: 'Connect a device' }))
    const dialog = await screen.findByRole('dialog', { name: 'Connect a device' })
    await within(dialog).findByText('Setup code (expires in 10 minutes)')
    await user.type(within(dialog).getByLabelText('Device name'), 'Lab PC')
    await user.click(within(dialog).getByRole('radio', { name: 'Windows' }))

    act(() => client.controls.expireEnrollment())
    expect((await within(dialog).findAllByText('Setup code expired')).length).toBeGreaterThan(0)

    client.controls.setReachable(false)
    await user.click(within(dialog).getByRole('button', { name: 'Get a new code' }))
    expect((await within(dialog).findAllByText('Setup code unavailable')).length).toBeGreaterThan(0)

    client.controls.setReachable(true)
    await user.click(within(dialog).getByRole('button', { name: 'Get a new code' }))
    expect(await within(dialog).findByText('Setup code (expires in 10 minutes)')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Device name')).toHaveValue('Lab PC')
    expect(within(dialog).getByLabelText('Run this in your terminal')).toHaveTextContent(
      '$env:BATON_ENROLLMENT_TOKEN = Read-Host -MaskInput',
    )

    act(() => client.controls.useEnrollmentElsewhere())
    expect((await within(dialog).findAllByText('Setup code already used')).length).toBeGreaterThan(0)
  })

  it('warns before making an offline device the default', async () => {
    const user = userEvent.setup()
    renderApp('/devices')
    await screen.findByRole('heading', { name: '3 devices, 2 online' })
    const row = deviceRow('Windows Desktop')
    await user.click(row)
    const details = document.getElementById(row.getAttribute('aria-controls') ?? '')
    expect(details).not.toBeNull()
    expect(within(details!).getByText('Windows Desktop is offline')).toBeInTheDocument()
    await user.click(within(details!).getByRole('button', { name: 'Set as default' }))

    const dialog = await screen.findByRole('dialog', { name: 'Use Windows Desktop as default?' })
    await user.click(within(dialog).getByRole('button', { name: 'Save default device' }))
    expect(await screen.findByText('Default device saved')).toBeInTheDocument()
    expect(screen.getByText(/Windows Desktop is your default device. It is offline/)).toBeInTheDocument()
    expect(within(deviceRow('Windows Desktop')).getByText('Default device')).toBeInTheDocument()
    expect(within(deviceRow('MacBook Pro')).queryByText('Default device')).not.toBeInTheDocument()
  })

  it('shows a syncing device notice inside its row without agent details', async () => {
    const user = userEvent.setup()
    renderApp('/devices', 'waiting')
    const row = await screen.findByRole('button', { name: /^Windows Desktop/ })
    await user.click(row)
    const details = document.getElementById(row.getAttribute('aria-controls') ?? '')
    expect(details).not.toBeNull()
    expect(within(details!).getByText('Windows Desktop is syncing')).toBeInTheDocument()
    expect(within(details!).queryByText('Agents & subscriptions')).not.toBeInTheDocument()
    expect(within(details!).getByRole('button', { name: 'Disconnect device' })).toBeInTheDocument()
  })

  it('shows the saved command permission and keeps it when saving fails', async () => {
    const user = userEvent.setup()
    const { client } = renderApp('/devices')
    await screen.findByRole('heading', { name: '3 devices, 2 online' })
    await user.click(deviceRow('Ubuntu Dev'))
    const toggle = screen.getByRole('switch', { name: 'Allow project assistant to run commands' })
    expect(toggle).not.toBeChecked()
    expect(screen.getByText(/Commands run as user “kaken” \(bash\)/)).toBeInTheDocument()

    await user.click(toggle)
    expect(await screen.findByText('Saved · command permission is on')).toBeInTheDocument()
    expect(toggle).toBeChecked()

    client.controls.setReachable(false)
    await user.click(toggle)
    expect(await screen.findByText(/Could not save because Baton could not be reached/)).toBeInTheDocument()
    expect(toggle).toBeChecked()
  })

  it('retries disconnecting the default device and asks for a replacement', async () => {
    const user = userEvent.setup()
    const { client } = renderApp('/devices')
    await screen.findByRole('heading', { name: '3 devices, 2 online' })
    await user.click(deviceRow('MacBook Pro'))
    await user.click(screen.getByRole('button', { name: 'Disconnect device' }))
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect “MacBook Pro”?' })
    expect(within(dialog).getByText(/MacBook Pro is your default device/)).toBeInTheDocument()

    client.controls.setReachable(false)
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect device' }))
    expect(await screen.findByRole('dialog', { name: 'Could not confirm disconnection' })).toBeInTheDocument()

    client.controls.setReachable(true)
    await user.click(screen.getByRole('button', { name: 'Retry disconnection' }))
    expect(await screen.findByText('Choose a new default device')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '2 devices, 1 online' })).toHaveFocus()
    const sidebar = screen.getByRole('navigation', { name: 'Workspace' })
    expect(within(sidebar).getByText('1/2 online')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Set Ubuntu Dev as default' }))
    expect(await screen.findByText('Ubuntu Dev is your default for new chats and projects.')).toBeInTheDocument()
    expect(within(deviceRow('Ubuntu Dev')).getByText('Default device')).toBeInTheDocument()
  })

  it('moves the project assistant to another device when its device is removed', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/devices')
    await screen.findByRole('heading', { name: '3 devices, 2 online' })
    expect(within(deviceRow('Ubuntu Dev')).getByText('Online · running Baton Dev')).toBeInTheDocument()
    await user.click(deviceRow('Ubuntu Dev'))
    await user.click(screen.getByRole('button', { name: 'Disconnect device' }))
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect “Ubuntu Dev”?' })
    expect(within(dialog).getByText(/agents still running on it will keep running locally/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect device' }))
    expect(await screen.findByText('Ubuntu Dev disconnected')).toBeInTheDocument()
    expect(within(deviceRow('MacBook Pro')).getByText('Online · running Baton Dev')).toBeInTheDocument()

    await act(() => router.navigate({ to: '/projects/$projectId', params: { projectId: 'prj-baton' } }))
    expect(await screen.findByText('Running on MacBook Pro')).toBeInTheDocument()
  })
})

