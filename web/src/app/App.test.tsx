import { createMemoryHistory } from '@tanstack/react-router'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vite-plus/test'
import { createMockClient } from '../data/mock/client'
import type { ScenarioId } from '../data/mock/scenarios'
import { manualScheduler } from '../data/mock/scheduler'
import { browserLatency } from '../data/mock/store'
import { App } from './App'
import { createAppRouter } from './router'

function renderApp(
  path: string,
  scenario: ScenarioId = 'normal',
  configure?: (client: ReturnType<typeof createMockClient>) => void,
) {
  const scheduler = manualScheduler()
  const client = createMockClient(scenario, { scheduler, latency: browserLatency })
  configure?.(client)
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

  it('offers the real empty model ID as Default model when switching back to Pi', async () => {
    const user = userEvent.setup()
    renderApp('/threads', 'normal', (client) => {
      const read = client.listDevices.bind(client)
      client.listDevices = async () =>
        (await read()).map((device) => ({
          ...device,
          agents: device.agents.map((agent) =>
            agent.kind === 'pi' ? { ...agent, models: [], defaultModel: null, problem: null } : agent,
          ),
        }))
    })
    await user.click(await screen.findByRole('button', { name: /Codex ·/ }))
    await user.click(await screen.findByRole('menuitem', { name: 'Default model' }))
    expect(await screen.findByRole('button', { name: 'Pi · Default model' })).toBeInTheDocument()
  })

  it('renders command threads without a chat composer and keeps command output available', async () => {
    renderApp('/threads/thr-webui', 'normal', (client) => {
      const readThreads = client.listThreads.bind(client)
      const readMessages = client.listMessages.bind(client)
      client.listThreads = async () =>
        (await readThreads()).map((thread) => (thread.id === 'thr-webui' ? { ...thread, agent: null } : thread))
      client.listMessages = async (id) => (await readMessages(id)).map((message) => ({ ...message, activity: null }))
    })
    expect(await screen.findByRole('heading', { name: 'Rebuild web UI foundation' })).toBeInTheDocument()
    expect(await screen.findAllByRole('button', { name: 'Command output' })).not.toHaveLength(0)
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument()
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
    const preview = await screen.findByRole('dialog', { name: 'README.md' })
    expect(await within(preview).findByText(/Baton/)).toBeInTheDocument()

    act(() => client.controls.setDeviceConnection('dev-mac', 'offline'))
    expect(await within(preview).findByText('MacBook Pro is offline')).toBeInTheDocument()
    expect(within(preview).queryByText(/^# /)).not.toBeInTheDocument()
    expect(screen.getAllByText('MacBook Pro is offline')).toHaveLength(2)

    act(() => client.controls.setDeviceConnection('dev-ubuntu', 'offline'))
    await act(() => router.navigate({ to: '/projects/$projectId', params: { projectId: 'prj-baton' } }))
    expect(await screen.findByText('Waiting for a device to come online')).toBeInTheDocument()
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

describe('projects', () => {
  async function advance(scheduler: ReturnType<typeof manualScheduler>, ms: number) {
    for (let passed = 0; passed < ms; passed += 50) {
      await act(async () => scheduler.advance(Math.min(50, ms - passed)))
    }
  }

  async function createProject(user: ReturnType<typeof userEvent.setup>, name: string) {
    await user.click(await screen.findByRole('button', { name: 'New project' }))
    const dialog = await screen.findByRole('dialog', { name: 'New project' })
    await user.type(within(dialog).getByLabelText('Name'), name)
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }))
    return dialog
  }

  it('asks for a name, then opens the empty project', async () => {
    const user = userEvent.setup()
    const { scheduler, router } = renderApp('/threads')
    await user.click(await screen.findByRole('button', { name: 'New project' }))
    const dialog = await screen.findByRole('dialog', { name: 'New project' })
    expect(within(dialog).getByText('Uses your ChatGPT account. Signed in on 2 online devices.')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }))
    expect(within(dialog).getByText('Enter a project name.')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Name')).toHaveFocus()

    await user.selectOptions(within(dialog).getByLabelText('Assistant subscription'), 'Claude')
    expect(within(dialog).getByLabelText('Model')).toHaveValue('claude-opus-5-5')
    await user.selectOptions(within(dialog).getByLabelText('Assistant subscription'), 'ChatGPT')
    await user.type(within(dialog).getByLabelText('Name'), 'Release{Enter}')
    await advance(scheduler, 500)
    expect(await screen.findByText(/Ask the assistant to run tests/)).toBeInTheDocument()
    expect(router.state.location.pathname).toMatch(/^\/projects\/prj-/)
    expect(screen.getByLabelText('Message the project assistant')).toHaveAttribute(
      'placeholder',
      'Describe what you want to build or verify…',
    )
    expect(screen.getByText('No chats in this project yet. Ask the assistant to start work.')).toBeInTheDocument()
  })

  it('keeps the entries when saving fails and saves on retry', async () => {
    const user = userEvent.setup()
    const { scheduler, router } = renderApp('/threads', 'error')
    const dialog = await createProject(user, 'Retry me')
    await advance(scheduler, 500)
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Baton could not save this project.')
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Retry me')
    await user.click(within(dialog).getByRole('button', { name: 'Try again' }))
    await advance(scheduler, 500)
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/projects\/prj-/))
    expect(await screen.findAllByText('Retry me')).not.toHaveLength(0)
  })

  it('opens two threads, shows their replies and opens one beside the conversation', async () => {
    const user = userEvent.setup()
    const { scheduler } = renderApp('/threads')
    await createProject(user, 'Compat run')
    await advance(scheduler, 500)
    await user.type(
      await screen.findByLabelText('Message the project assistant'),
      'Run the compat suite on MacBook Pro and Ubuntu Dev.{Enter}',
    )
    await advance(scheduler, browserLatency.save + browserLatency.run / 2)
    const opened = await screen.findByRole('region', { name: 'Opened 2 chats' })
    expect(within(opened).getByText('2 running')).toBeInTheDocument()
    const overview = screen.getByRole('complementary', { name: 'Overview' })
    expect(within(overview).getByRole('tab', { name: /Threads/ })).toHaveTextContent('2')

    await advance(scheduler, browserLatency.run * 2)
    const replies = await screen.findByRole('region', { name: 'Replies from 2 chats' })
    expect(within(replies).getByText('All replied')).toBeInTheDocument()
    expect(screen.getByText(/^Both chats finished\./)).toBeInTheDocument()

    await user.click(within(replies).getAllByRole('button')[0])
    const panel = await screen.findByRole('complementary', { name: /compat/i })
    expect(screen.queryByRole('complementary', { name: 'Overview' })).not.toBeInTheDocument()
    await user.click(within(panel).getByRole('button', { name: 'Back to overview' }))
    expect(await screen.findByRole('complementary', { name: 'Overview' })).toBeInTheDocument()
  })

  it('saves messages while no device can run the assistant', async () => {
    const user = userEvent.setup()
    const { scheduler } = renderApp('/projects/prj-docs', 'waiting')
    expect(await screen.findByText('No device is ready for this model')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'View devices' })).toBeInTheDocument()
    await user.type(screen.getByLabelText('Message the project assistant'), 'Check the install guide.{Enter}')
    await advance(scheduler, browserLatency.save + 100)
    await waitFor(() =>
      expect(screen.getAllByText('Saved · waiting for a device with Claude signed in')).toHaveLength(2),
    )
    expect(screen.getByText(/2 messages waiting/)).toBeInTheDocument()
  })

  it('stops the assistant run and leaves its threads running', async () => {
    const user = userEvent.setup()
    const { scheduler } = renderApp('/projects/prj-baton')
    await user.click(await screen.findByRole('button', { name: 'Stop run' }))
    expect(await screen.findByText('Waiting for the project assistant to stop')).toBeInTheDocument()
    expect(screen.getByText('Stop requested')).toBeInTheDocument()
    await advance(scheduler, browserLatency.device + 100)
    expect(
      await screen.findByText('You stopped the project assistant. Chats it opened keep running.'),
    ).toBeInTheDocument()
    const overview = screen.getByRole('complementary', { name: 'Overview' })
    expect(within(within(overview).getByRole('region', { name: 'Running' })).getByText(/gateway/i)).toBeInTheDocument()
  })
})

describe('threads', () => {
  // 模拟请求先等读取延迟，再安排保存等后续步骤，所以分小步推进时间，每步之间让 Promise 继续执行。
  async function advance(scheduler: ReturnType<typeof manualScheduler>, ms: number) {
    for (let passed = 0; passed < ms; passed += 50) {
      await act(async () => scheduler.advance(Math.min(50, ms - passed)))
    }
  }

  function panel(name: string | RegExp) {
    return screen.findByRole('complementary', { name })
  }

  it('starts a chat from an empty list, continues it and archives it', async () => {
    const user = userEvent.setup()
    const { scheduler } = renderApp('/threads', 'noChats')
    expect(await screen.findByText('No chats yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /baton · MacBook Pro/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Codex · gpt-6.1-sol/ })).toBeInTheDocument()

    await user.type(screen.getByLabelText('New chat message'), 'Add a health check{Enter}')
    await advance(scheduler, browserLatency.read + browserLatency.save)
    const detail = await panel('Add a health check')
    expect(await within(detail).findByText('Running')).toBeInTheDocument()
    expect(screen.getByLabelText('New chat message')).toHaveValue('')

    await advance(scheduler, browserLatency.read + browserLatency.run)
    expect(await within(detail).findByText('Idle')).toBeInTheDocument()
    expect(within(detail).getByText('Done. The change is ready for review.')).toBeInTheDocument()

    await user.type(within(detail).getByLabelText('Message'), 'Also document it{Enter}')
    await advance(scheduler, browserLatency.save + browserLatency.run)
    await waitFor(() => expect(within(detail).getAllByText('Done. The change is ready for review.')).toHaveLength(2))

    await user.click(within(detail).getByRole('button', { name: 'Close chat' }))
    const row = await screen.findByRole('link', { name: /Add a health check/ })
    expect(within(row).getByText('No project')).toBeInTheDocument()

    await user.click(row)
    const reopened = await panel('Add a health check')
    await user.click(within(reopened).getByRole('button', { name: 'Chat actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Archive chat' }))
    const dialog = await screen.findByRole('dialog', { name: 'Archive this chat?' })
    await user.click(within(dialog).getByRole('button', { name: 'Archive chat' }))
    await advance(scheduler, browserLatency.read + browserLatency.save)
    expect(
      await within(reopened).findByText(
        'This chat is closed to new messages. Past replies and attachment links are kept.',
      ),
    ).toBeInTheDocument()
    expect(within(reopened).queryByLabelText('Message')).not.toBeInTheDocument()
  })

  it('queues the next message and cancels it before it is sent', async () => {
    const user = userEvent.setup()
    const { scheduler } = renderApp('/threads?thread=thr-gateway')
    const detail = await panel('Fix gateway reconnect race')
    expect(within(detail).getByText('Sends after current reply')).toBeInTheDocument()
    await user.type(within(detail).getByLabelText('Message'), 'Also add a regression test{Enter}')
    await advance(scheduler, browserLatency.read + browserLatency.save)
    expect(await within(detail).findByText(/Sending next/)).toBeInTheDocument()

    await user.click(within(detail).getByRole('button', { name: 'Cancel' }))
    await advance(scheduler, browserLatency.read + browserLatency.save)
    expect(await within(detail).findByText('Not sent')).toBeInTheDocument()
  })

  it('explains why Kiro cannot read messages during a reply', async () => {
    const user = userEvent.setup()
    renderApp('/threads?thread=thr-patrol')
    const detail = await panel('Organize switch patrol scripts')
    await user.click(within(detail).getByRole('button', { name: 'Send now' }))
    expect(within(detail).getByText(/Kiro can't read messages during a reply/)).toBeInTheDocument()
    expect(within(detail).getByRole('button', { name: 'Send next' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('stops a reply only after the device confirms', async () => {
    const user = userEvent.setup()
    const { scheduler } = renderApp('/threads?thread=thr-gateway')
    const detail = await panel('Fix gateway reconnect race')
    await user.click(within(detail).getByRole('button', { name: 'Stop current reply' }))
    const dialog = await screen.findByRole('dialog', { name: 'Stop current reply?' })
    await user.click(within(dialog).getByRole('button', { name: 'Stop reply' }))
    await advance(scheduler, browserLatency.read + browserLatency.save)
    expect(await within(detail).findByText('Stopping… (forces quit in 1m)')).toBeInTheDocument()

    await advance(scheduler, browserLatency.read + browserLatency.device)
    expect(await within(detail).findByText('Stopped by you')).toBeInTheDocument()
    expect(within(detail).getByLabelText('Message')).toBeInTheDocument()
  })

  it('keeps the last report while the device is offline and waits on the same device', async () => {
    const user = userEvent.setup()
    const { client } = renderApp('/threads?thread=thr-gateway')
    const detail = await panel('Fix gateway reconnect race')
    act(() => client.controls.setDeviceConnection('dev-ubuntu', 'offline'))
    expect(await within(detail).findByText('Ubuntu Dev is offline')).toBeInTheDocument()
    expect(within(detail).getAllByText('Last seen running').length).toBeGreaterThan(0)

    await user.click(within(detail).getByRole('button', { name: 'View devices' }))
    expect(await screen.findByRole('heading', { name: 'Devices' })).toBeInTheDocument()
  })

  it('offers recovery without resending anything', async () => {
    const user = userEvent.setup()
    renderApp('/threads?thread=thr-sleep', 'error')
    const detail = await panel('Run sleep tests on Windows')
    expect(within(detail).getByText('Codex could not start')).toBeInTheDocument()
    expect(within(detail).queryByLabelText('Message')).not.toBeInTheDocument()

    await user.click(within(detail).getByRole('button', { name: 'New chat in this folder' }))
    expect(screen.getByRole('button', { name: /baton · Windows Desktop/ })).toBeInTheDocument()
    expect(screen.getByLabelText('New chat message')).toHaveFocus()
    expect(screen.getByLabelText('New chat message')).toHaveValue('')
  })

  it('adds and selects a folder path directly from the folder dialog', async () => {
    const user = userEvent.setup()
    const { client } = renderApp('/threads/thr-compat', 'error')
    await user.click(await screen.findByRole('button', { name: 'Choose folder' }))
    const dialog = await screen.findByRole('dialog', { name: 'Choose folder' })
    await user.selectOptions(within(dialog).getByLabelText('Device'), 'dev-mac')
    await user.type(within(dialog).getByLabelText('Folder path'), '  /Users/kaken/new-project  {Enter}')
    expect(await within(dialog).findByText('No subfolders')).toBeInTheDocument()
    expect(
      within(dialog).getByText('Add a folder path above or choose from shared folders on this device.'),
    ).toBeInTheDocument()
    expect((await client.listDevices()).find((device) => device.id === 'dev-mac')?.folders).toContain(
      '/Users/kaken/new-project',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Select folder' }))
    expect(await screen.findByRole('button', { name: /new-project · MacBook Pro/ })).toBeInTheDocument()
  })

  it('asks for another folder when the old one is missing', async () => {
    const user = userEvent.setup()
    renderApp('/threads/thr-compat', 'error')
    await user.click(await screen.findByRole('button', { name: 'Choose folder' }))
    const dialog = await screen.findByRole('dialog', { name: 'Choose folder' })
    expect(within(dialog).getByLabelText('Device')).toHaveValue('dev-windows')
    expect(await within(dialog).findByText('Windows Desktop is offline')).toBeInTheDocument()

    await user.selectOptions(within(dialog).getByLabelText('Device'), 'dev-mac')
    await user.click(await within(dialog).findByRole('button', { name: '~/src' }))
    await user.click(await within(dialog).findByRole('button', { name: 'compat-suite' }))
    await user.click(within(dialog).getByRole('button', { name: 'Select folder' }))
    expect(await screen.findByRole('button', { name: /compat-suite · MacBook Pro/ })).toBeInTheDocument()
    expect(screen.getByLabelText('New chat message')).toHaveFocus()
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
    expect(command).toHaveTextContent('batond up --coordinator')
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

  it('adds and removes allowed folders on the device page', async () => {
    const user = userEvent.setup()
    const { client } = renderApp('/devices')
    await user.click(await screen.findByRole('button', { name: /^Ubuntu Dev/ }))
    const input = screen.getByLabelText('Folder path')
    await user.type(input, '  /home/kaken/new-project  ')
    await user.click(screen.getByRole('button', { name: 'Add folder' }))
    expect(await screen.findByRole('button', { name: 'Remove /home/kaken/new-project' })).toBeInTheDocument()
    expect(input).toHaveValue('')
    await user.type(input, '/home/kaken/new-project')
    await user.click(screen.getByRole('button', { name: 'Add folder' }))
    await waitFor(() => expect(input).toHaveValue(''))
    expect(screen.getAllByRole('button', { name: 'Remove /home/kaken/new-project' })).toHaveLength(1)
    expect(await client.listFolders('dev-ubuntu', '/home/kaken/new-project')).toMatchObject({
      state: 'ready',
      folders: [],
    })
    await user.click(screen.getByRole('button', { name: 'Remove /home/kaken/new-project' }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove /home/kaken/new-project' })).not.toBeInTheDocument(),
    )
    expect(await client.listFolders('dev-ubuntu', '/home/kaken/new-project')).toMatchObject({
      state: 'unavailable',
      reason: 'outsideFolders',
    })
  })

  it('keeps the folder path when adding fails and preserves a folder when removal fails', async () => {
    const user = userEvent.setup()
    const { client } = renderApp('/devices')
    await user.click(await screen.findByRole('button', { name: /^Ubuntu Dev/ }))
    await user.type(screen.getByLabelText('Folder path'), '/home/kaken/new-project')
    client.controls.setReachable(false)
    await user.click(screen.getByRole('button', { name: 'Add folder' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not add folder')
    expect(screen.getByLabelText('Folder path')).toHaveValue('/home/kaken/new-project')
    await user.click(screen.getByRole('button', { name: 'Remove /home/kaken/work' }))
    expect(await screen.findByText(/Could not remove folder/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove /home/kaken/work' })).toBeInTheDocument()
    client.controls.setReachable(true)
    await user.click(screen.getByRole('button', { name: 'Add folder' }))
    expect(await screen.findByRole('button', { name: 'Remove /home/kaken/new-project' })).toBeInTheDocument()
  })

  it('signs in to a subscription with a device code and waits for the device report', async () => {
    const user = userEvent.setup()
    const { client } = renderApp('/devices', 'error')
    await user.click(await screen.findByRole('button', { name: /^Ubuntu Dev/ }))
    await user.click(screen.getByRole('button', { name: 'Sign in to ChatGPT' }))
    const dialog = await screen.findByRole('dialog', { name: 'Sign in to ChatGPT on Ubuntu Dev' })
    expect(await within(dialog).findByText('BATON-1234')).toBeInTheDocument()
    expect(within(dialog).getByText(/Expires in 15m|Expires in 14m/)).toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: 'Open sign-in page' })).toHaveAttribute(
      'href',
      'https://auth.openai.com/codex/device',
    )
    expect(within(dialog).getByRole('link', { name: 'Open sign-in page' })).toHaveAttribute('target', '_blank')
    expect(within(dialog).getByRole('link', { name: 'Open sign-in page' })).toHaveAttribute('rel', 'noreferrer')
    await user.click(within(dialog).getByRole('button', { name: 'Copy code' }))
    expect(await within(dialog).findByText('Code copied')).toBeInTheDocument()
    expect(await navigator.clipboard.readText()).toBe('BATON-1234')
    expect(within(dialog).queryByText('Signed in')).not.toBeInTheDocument()
    act(() => client.controls.completeSubscriptionLogin('Ubuntu Dev', 'openai-codex'))
    expect(await within(dialog).findByText('Signed in')).toBeInTheDocument()
    expect(within(dialog).queryByText('BATON-1234')).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(deviceRow('Ubuntu Dev')).toHaveFocus()
    expect(screen.queryByRole('button', { name: 'Sign in to ChatGPT' })).not.toBeInTheDocument()
  })

  it.each([true, false])('shows local API key setup for Claude with signedIn=%s', async (signedIn) => {
    const user = userEvent.setup()
    let loginCalls = 0
    renderApp('/devices', 'normal', (client) => {
      const list = client.listDevices.bind(client)
      client.listDevices = async () =>
        (await list()).map((device) => ({
          ...device,
          subscriptions: device.subscriptions.map((sub) =>
            sub.provider === 'Claude' ? { ...sub, signedIn, status: signedIn ? 'available' : 'login_required' } : sub,
          ),
        }))
      const login = client.startSubscriptionLogin.bind(client)
      client.startSubscriptionLogin = async (input) => {
        loginCalls++
        return login(input)
      }
    })
    await user.click(await screen.findByRole('button', { name: /^Ubuntu Dev/ }))
    await user.click(screen.getByRole('button', { name: signedIn ? 'Use API key for Claude' : 'Set up Claude' }))
    const dialog = await screen.findByRole('dialog', { name: 'Set up Claude on Ubuntu Dev' })
    expect(within(dialog).getByText('baton-project-runtime login anthropic')).toBeInTheDocument()
    expect(within(dialog).getByText('baton-project-runtime login-api-key anthropic < key-file')).toBeInTheDocument()
    expect(within(dialog).getByText(/The key stays on Ubuntu Dev/)).toBeInTheDocument()
    expect(within(dialog).queryByText('Getting sign-in code…')).not.toBeInTheDocument()
    expect(loginCalls).toBe(0)
    await user.click(within(dialog).getByRole('button', { name: signedIn ? 'Done' : 'Close' }))
    expect(deviceRow('Ubuntu Dev')).toHaveFocus()
  })

  it('retries a subscription login after the device could not be reached', async () => {
    const user = userEvent.setup()
    const { client } = renderApp('/devices', 'error')
    await user.click(await screen.findByRole('button', { name: /^Ubuntu Dev/ }))
    client.controls.setReachable(false)
    await user.click(screen.getByRole('button', { name: 'Sign in to ChatGPT' }))
    const dialog = await screen.findByRole('dialog', { name: 'Sign in to ChatGPT on Ubuntu Dev' })
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Could not start sign-in')
    client.controls.setReachable(true)
    await user.click(within(dialog).getByRole('button', { name: 'Retry sign-in' }))
    expect(await within(dialog).findByText('BATON-1234')).toBeInTheDocument()
  })

  it('saves an offline default device in one click and explains the waiting behavior', async () => {
    const user = userEvent.setup()
    renderApp('/devices')
    await screen.findByRole('heading', { name: '3 devices, 2 online' })
    const row = deviceRow('Windows Desktop')
    await user.click(row)
    const details = document.getElementById(row.getAttribute('aria-controls') ?? '')
    expect(details).not.toBeNull()
    expect(within(details!).getByText('Windows Desktop is offline')).toBeInTheDocument()
    await user.click(within(details!).getByRole('button', { name: 'Set as default' }))

    expect(screen.queryByRole('dialog', { name: 'Use Windows Desktop as default?' })).not.toBeInTheDocument()
    expect(await screen.findByText('Default device saved')).toBeInTheDocument()
    expect(screen.getByText(/Windows Desktop is your default device. It is offline/)).toBeInTheDocument()
    expect(within(deviceRow('Windows Desktop')).getByText('Default device')).toBeInTheDocument()
    expect(within(deviceRow('MacBook Pro')).queryByText('Default device')).not.toBeInTheDocument()
  })

  it('shows an unknown subscription check as available to try without asking for sign-in', async () => {
    const user = userEvent.setup()
    renderApp('/devices', 'normal', (client) => {
      const list = client.listDevices.bind(client)
      client.listDevices = async () =>
        (await list()).map((device) =>
          device.name === 'Ubuntu Dev'
            ? {
                ...device,
                subscriptions: [
                  { provider: 'ChatGPT', signedIn: false, status: 'unknown', reason: 'credential_read_failed' },
                ],
              }
            : device,
        )
    })
    await user.click(await screen.findByRole('button', { name: /^Ubuntu Dev/ }))
    expect(screen.getByText('ChatGPT sign-in check unavailable · can try')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign in to ChatGPT' })).not.toBeInTheDocument()
    expect(screen.queryByText('Finish setup on Ubuntu Dev')).not.toBeInTheDocument()
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

  it('allows reviewing command permission before subscription sign-in is repaired', async () => {
    const user = userEvent.setup()
    renderApp('/devices', 'error')
    await screen.findByRole('heading', { name: '3 devices, 2 online' })
    await user.click(deviceRow('Ubuntu Dev'))
    expect(screen.getAllByText('ChatGPT sign-in expired').length).toBeGreaterThan(0)
    expect(screen.getByRole('switch', { name: 'Allow project assistant to run commands' })).not.toBeChecked()
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

describe('execution details', () => {
  async function advance(scheduler: ReturnType<typeof manualScheduler>, ms: number) {
    for (let passed = 0; passed < ms; passed += 50) {
      await act(async () => scheduler.advance(Math.min(50, ms - passed)))
    }
  }

  // 选中节点里的全部文字，再像松开鼠标一样通知选区菜单。
  function select(node: Node) {
    const range = document.createRange()
    range.selectNodeContents(node)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    const target = node instanceof Element ? node : node.parentElement!
    act(() => {
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
  }

  it('expands a reply trace and reads it again after a failure', async () => {
    const user = userEvent.setup()
    renderApp('/threads/thr-webui', 'error')
    const toggle = await screen.findByRole('button', { name: /Ran 2 commands, used 1 tool, wrote 2 files/ })
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByText(/MacBook Pro did not return this activity/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('pnpm --dir web build')).toBeInTheDocument()
    expect(screen.getByText(/✓ built in 1.84s/)).toBeInTheDocument()

    await user.click(toggle)
    expect(screen.queryByText('pnpm --dir web build')).not.toBeInTheDocument()
  })

  it('opens attachments that are online and copies the full commit SHA', async () => {
    const user = userEvent.setup()
    const { client } = renderApp('/threads?thread=thr-gateway')
    const detail = await screen.findByRole('complementary', { name: 'Fix gateway reconnect race' })
    const attachments = await within(detail).findByRole('list', { name: 'Attachments' })
    expect(within(attachments).getByText('9b1e4d7a2c5f8e0b3d6a9c2f5e8b1d4a7c0e3f62')).toBeInTheDocument()

    await user.click(within(attachments).getByRole('button', { name: 'Copy commit SHA' }))
    expect(await navigator.clipboard.readText()).toBe('9b1e4d7a2c5f8e0b3d6a9c2f5e8b1d4a7c0e3f62')
    expect(within(attachments).getByRole('button', { name: 'Copied commit SHA' })).toBeInTheDocument()

    act(() => client.controls.setDeviceConnection('dev-windows', 'offline'))
    expect(await within(attachments).findByText(/offline, unavailable/)).toBeInTheDocument()
    expect(within(attachments).queryByRole('button', { name: 'View windows-reconnect.log' })).not.toBeInTheDocument()

    await user.click(within(attachments).getByRole('button', { name: 'View reconnect.log' }))
    const preview = await screen.findByRole('dialog', { name: 'logs/reconnect.log' })
    expect(await within(preview).findByText(/FAIL reconnects after sleep/)).toBeInTheDocument()
  })

  it('marks lost live output after the device reconnects', async () => {
    const { client } = renderApp('/threads?thread=thr-gateway', 'offline')
    const detail = await screen.findByRole('complementary', { name: 'Fix gateway reconnect race' })
    expect(await within(detail).findByText('Connection lost · output resumes when reconnected')).toBeInTheDocument()
    expect(within(detail).getByText(/No report since/)).toBeInTheDocument()

    act(() => client.controls.setDeviceConnection('dev-ubuntu', 'online'))
    expect(
      await within(detail).findByText('Earlier output is no longer available on this computer'),
    ).toBeInTheDocument()
    expect(within(detail).getByLabelText('Live output')).toHaveTextContent(/waiting for resume/)
  })

  it('browses folders in the file preview and explains files it cannot show', async () => {
    const user = userEvent.setup()
    renderApp('/threads?thread=thr-gateway', 'error')
    const detail = await screen.findByRole('complementary', { name: 'Fix gateway reconnect race' })
    await user.click(await within(detail).findByRole('button', { name: 'View reconnect.log' }))
    const preview = await screen.findByRole('dialog', { name: 'logs/reconnect.log' })
    const folders = within(preview).getByRole('navigation', { name: 'Folders' })

    await user.click(await within(folders).findByRole('button', { name: /gateway-soak.log/ }))
    expect(await within(preview).findByText('Showing first 64 KB')).toBeInTheDocument()

    await user.click(within(folders).getByRole('button', { name: 'Parent folder' }))
    await user.click(await within(folders).findByRole('button', { name: /^apps/ }))
    await user.click(await within(folders).findByRole('button', { name: /^server/ }))
    await user.click(await within(folders).findByRole('button', { name: /^src/ }))
    await user.click(await within(folders).findByRole('button', { name: /gateway\.test\.ts/ }))
    expect(await within(preview).findByText(/did not return/)).toBeInTheDocument()
    await user.click(within(preview).getByRole('button', { name: 'Retry' }))
    expect(await within(preview).findByText(/test\('decodes WebSocket data'/)).toBeInTheDocument()

    await user.click(await within(folders).findByRole('button', { name: /^testing/ }))
    await user.click(await within(folders).findByRole('button', { name: /^data/ }))
    await user.click(await within(folders).findByRole('button', { name: /capture.bin/ }))
    expect(await within(preview).findByText(/binary/i)).toBeInTheDocument()
    expect(within(preview).queryByRole('region', { name: /Contents of/ })).not.toBeInTheDocument()
  })

  it('shows a failed reply in a project thread without changing reply numbering', async () => {
    const reason = 'Send your message again or check Codex on this device.'
    renderApp('/projects/prj-baton?thread=thr-gateway', 'normal', (client) => {
      const read = client.listMessages.bind(client)
      client.listMessages = async (id) => {
        const messages = await read(id)
        const reply = messages.find((message) => message.role === 'agent')
        if (id !== 'thr-gateway' || !reply) return messages
        return [
          {
            ...reply,
            id: 'failed-reply',
            role: 'failure',
            body: reason,
            createdAt: reply.createdAt - 1,
            activity: null,
            attachments: [],
          },
          ...messages,
        ]
      }
    })
    const detail = await screen.findByRole('complementary', { name: 'Fix gateway reconnect race' })
    expect(
      await within(detail).findByRole('heading', { name: 'Codex could not finish this reply' }),
    ).toBeInTheDocument()
    const failure = within(detail).getByText(reason)
    expect(failure.closest('[data-reply]')).toBeNull()
    const reply = await within(detail).findByText(/did not reconnect within 30s/)
    expect(reply.closest('[data-reply]')).toHaveAttribute('data-reply', '1')
  })

  it('asks the project assistant about a selected reply and sends the reference', async () => {
    const user = userEvent.setup()
    const { router, scheduler } = renderApp('/threads?thread=thr-gateway')
    const detail = await screen.findByRole('complementary', { name: 'Fix gateway reconnect race' })
    select(await within(detail).findByText(/did not reconnect within 30s/))
    await user.click(await within(detail).findByRole('button', { name: 'Ask project assistant' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/projects/prj-baton'))
    const reference = await screen.findByRole('figure', { name: 'Reference from Fix gateway reconnect race' })
    expect(within(reference).getByText(/Reply 1/)).toBeInTheDocument()
    const input = screen.getByLabelText('Message the project assistant')
    expect(input).toHaveFocus()

    await user.click(within(reference).getByRole('button', { name: 'Remove reference' }))
    expect(screen.queryByRole('figure', { name: /Reference from/ })).not.toBeInTheDocument()
    expect(input).toHaveFocus()

    await act(() => router.navigate({ to: '/threads', search: { thread: 'thr-gateway' } }))
    const again = await screen.findByRole('complementary', { name: 'Fix gateway reconnect race' })
    select(await within(again).findByText(/did not reconnect within 30s/))
    await user.click(await within(again).findByRole('button', { name: 'Ask project assistant' }))
    await user.type(await screen.findByLabelText('Message the project assistant'), 'Why only after sleep?{Enter}')
    await advance(scheduler, browserLatency.save + 100)
    expect(await screen.findByText('Why only after sleep?')).toBeInTheDocument()
    expect(screen.getAllByRole('figure', { name: 'Reference from Fix gateway reconnect race' })).toHaveLength(1)
  })

  it('copies a selection in a chat outside any project', async () => {
    const user = userEvent.setup()
    renderApp('/threads/thr-webui')
    select(await screen.findByText(/Scaffold is in place/))
    await user.click(await screen.findByRole('button', { name: 'Copy selection' }))
    expect(await screen.findByText('Copied')).toBeInTheDocument()
    expect(await navigator.clipboard.readText()).toMatch(/Scaffold is in place/)
  })

  it('asks the project assistant about an inbox question', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/inbox')
    const card = await screen.findByRole('region', { name: 'Which runner should run nightly?' })
    await user.click(within(card).getByRole('button', { name: 'Show details' }))
    select(await screen.findByText('MacBook Pro sleeps at night. Ubuntu Dev is always on.'))
    await user.click(await screen.findByRole('button', { name: 'Ask project assistant' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/projects/prj-compat'))
    const reference = await screen.findByRole('figure', { name: 'Reference from Which runner should run nightly?' })
    expect(within(reference).getByText(/MacBook Pro sleeps at night/)).toBeInTheDocument()
  })
})
