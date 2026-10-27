import { createMemoryHistory } from '@tanstack/react-router'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
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

  it('renders command threads without a thread composer and keeps command output available', async () => {
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
    expect(await screen.findByText("Can't reach Baton")).toBeInTheDocument()
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
    expect(await screen.findByRole('heading', { name: "Couldn't sign out" })).toBeInTheDocument()

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
    expect(within(sidebar).getByRole('button', { name: 'New thread' })).toBeInTheDocument()
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
    expect(await screen.findByText('All devices offline')).toBeInTheDocument()
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
    expect(within(dialog).queryByText(/signed in/)).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }))
    expect(within(dialog).getByText('Enter a project name.')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Name')).toHaveFocus()

    await user.selectOptions(within(dialog).getByLabelText('Assistant subscription'), 'Claude')
    expect(within(dialog).getByLabelText('Model')).toHaveValue('claude-opus-5-5')
    await user.selectOptions(within(dialog).getByLabelText('Assistant subscription'), 'ChatGPT')
    await user.type(within(dialog).getByLabelText('Name'), 'Release{Enter}')
    await advance(scheduler, 500)
    expect(await screen.findByText('No threads')).toBeInTheDocument()
    expect(router.state.location.pathname).toMatch(/^\/projects\/prj-/)
    expect(screen.getByLabelText('Message the project assistant')).toHaveAttribute(
      'placeholder',
      'Describe what you want to build or verify…',
    )
  })

  it('keeps the entries when saving fails and saves on retry', async () => {
    const user = userEvent.setup()
    const { scheduler, router } = renderApp('/threads', 'error')
    const dialog = await createProject(user, 'Retry me')
    await advance(scheduler, 500)
    expect(await within(dialog).findByRole('alert')).toHaveTextContent("Couldn't create the project. Try again.")
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
    const opened = await screen.findByRole('region', { name: 'Opened 2 threads' })
    expect(within(opened).getByText('2 running')).toBeInTheDocument()
    const overview = screen.getByRole('complementary', { name: 'Overview' })
    expect(within(overview).getByRole('tab', { name: /Threads/ })).toHaveTextContent('2')

    await advance(scheduler, browserLatency.run * 2)
    const replies = await screen.findByRole('region', { name: 'Replies from 2 threads' })
    expect(within(replies).getByText('All replied')).toBeInTheDocument()
    expect(screen.getByText(/^Both threads finished\./)).toBeInTheDocument()

    await user.click(within(replies).getAllByRole('button')[0])
    const panel = await screen.findByRole('complementary', { name: /compat/i })
    expect(screen.queryByRole('complementary', { name: 'Overview' })).not.toBeInTheDocument()
    await user.click(within(panel).getByRole('button', { name: 'Back to overview' }))
    expect(await screen.findByRole('complementary', { name: 'Overview' })).toBeInTheDocument()
  })

  it('saves messages while no device can run the assistant', async () => {
    const user = userEvent.setup()
    const { scheduler } = renderApp('/projects/prj-docs', 'waiting')
    expect(await screen.findByText('No device has Claude signed in')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'View devices' })).toBeInTheDocument()
    await user.type(screen.getByLabelText('Message the project assistant'), 'Check the install guide.{Enter}')
    await advance(scheduler, browserLatency.save + 100)
    await waitFor(() => expect(screen.getAllByText('Waiting for a device')).toHaveLength(2))
    expect(screen.getByText(/2 messages waiting/)).toBeInTheDocument()
  })

  it('stops the assistant run and leaves its threads running', async () => {
    const user = userEvent.setup()
    const { scheduler } = renderApp('/projects/prj-baton')
    await user.click(await screen.findByRole('button', { name: 'Stop run' }))
    expect(await screen.findByText(/to stop the assistant$/)).toBeInTheDocument()
    expect(screen.getByText('Stop requested')).toBeInTheDocument()
    await advance(scheduler, browserLatency.device + 100)
    expect(await screen.findByText('You stopped the project assistant')).toBeInTheDocument()
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

  it('starts a thread from an empty list, continues it and archives it', async () => {
    const user = userEvent.setup()
    const { scheduler } = renderApp('/threads', 'noChats')
    expect(await screen.findByText('No threads yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /baton · MacBook Pro/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Codex · gpt-6.1-sol/ })).toBeInTheDocument()

    await user.type(screen.getByLabelText('New thread message'), 'Add a health check{Enter}')
    await advance(scheduler, browserLatency.read + browserLatency.save)
    const detail = await panel('Add a health check')
    expect(await within(detail).findByText('Running')).toBeInTheDocument()
    expect(screen.getByLabelText('New thread message')).toHaveValue('')

    await advance(scheduler, browserLatency.read + browserLatency.run)
    expect(await within(detail).findByText('Idle')).toBeInTheDocument()
    expect(within(detail).getByText('Done. The change is ready for review.')).toBeInTheDocument()

    await user.type(within(detail).getByLabelText('Message'), 'Also document it{Enter}')
    await advance(scheduler, browserLatency.save + browserLatency.run)
    await waitFor(() => expect(within(detail).getAllByText('Done. The change is ready for review.')).toHaveLength(2))

    await user.click(within(detail).getByRole('button', { name: 'Close thread' }))
    const row = await screen.findByRole('link', { name: /Add a health check/ })
    expect(within(row).getByText('No project')).toBeInTheDocument()

    await user.click(row)
    const reopened = await panel('Add a health check')
    await user.click(within(reopened).getByRole('button', { name: 'Thread actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Archive thread' }))
    const dialog = await screen.findByRole('dialog', { name: 'Archive this thread?' })
    await user.click(within(dialog).getByRole('button', { name: 'Archive thread' }))
    await advance(scheduler, browserLatency.read + browserLatency.save)
    expect((await within(reopened).findAllByText('Archived')).length).toBeGreaterThan(0)
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
    expect((await within(detail).findAllByText('Stopping…')).length).toBeGreaterThan(0)

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

    await user.click(within(detail).getByRole('button', { name: 'New thread in this folder' }))
    expect(screen.getByRole('button', { name: /baton · Windows Desktop/ })).toBeInTheDocument()
    expect(screen.getByLabelText('New thread message')).toHaveFocus()
    expect(screen.getByLabelText('New thread message')).toHaveValue('')
  })

  it('adds and selects a folder path directly from the folder dialog', async () => {
    const user = userEvent.setup()
    const { client } = renderApp('/threads/thr-compat', 'error')
    await user.click(await screen.findByRole('button', { name: 'Choose folder' }))
    const dialog = await screen.findByRole('dialog', { name: 'Choose folder' })
    await user.selectOptions(within(dialog).getByLabelText('Device'), 'dev-mac')
    await user.type(within(dialog).getByLabelText('Folder path'), '  /Users/kaken/new-project  ')
    expect(within(dialog).getByText('Adds this folder to MacBook Pro.')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Add and select' }))
    expect(await screen.findByRole('button', { name: /new-project · MacBook Pro/ })).toBeInTheDocument()
    expect((await client.listDevices()).find((device) => device.id === 'dev-mac')?.folders).toContain(
      '/Users/kaken/new-project',
    )
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
    expect(screen.getByLabelText('New thread message')).toHaveFocus()
  })
})

describe('devices', () => {
  function deviceRow(name: string) {
    return screen.getByRole('button', { name: new RegExp(`^${name}`) })
  }

  it.each([
    ['draining', 'Waiting for upgrade'],
    ['ready', 'Waiting for upgrade'],
    ['failed', 'Upgrade paused'],
    ['cancelled', 'Running Baton Dev'],
  ] as const)('shows upgrade phase %s in the existing device status row', async (phase, label) => {
    const user = userEvent.setup()
    renderApp('/devices', 'normal', (client) => {
      const read = client.listDevices.bind(client)
      client.listDevices = async () =>
        (await read()).map((device) =>
          device.id === 'dev-ubuntu'
            ? {
                ...device,
                upgradeState: {
                  operationId: 'upgrade-one',
                  sourceVersion: '0.9.1',
                  targetVersion: '0.9.2',
                  phase,
                },
              }
            : device,
        )
    })
    await screen.findByRole('button', { name: /^Ubuntu Dev/ })
    const row = deviceRow('Ubuntu Dev')
    expect(within(row).getByText(label)).toBeInTheDocument()
    expect(within(row).queryByText('Online')).not.toBeInTheDocument()
    if (phase !== 'cancelled') expect(within(row).queryByText('Running Baton Dev')).not.toBeInTheDocument()
    await user.click(row)
    const cancellation = screen.queryByText('Waiting for the upgrade to be cancelled.')
    if (phase === 'failed') expect(cancellation).toBeInTheDocument()
    else expect(cancellation).not.toBeInTheDocument()
  })

  it.each([
    ['dev-windows', 'Windows Desktop', '$env:BATON_ENROLLMENT_TOKEN = Read-Host -MaskInput'],
    ['dev-ubuntu', 'Ubuntu Dev', 'read -rs BATON_ENROLLMENT_TOKEN && export BATON_ENROLLMENT_TOKEN'],
  ])('reconnects the original device %s with a new setup code', async (id, name, tokenInput) => {
    const user = userEvent.setup()
    const { client, scheduler } = renderApp('/devices', 'normal', (client) => {
      const read = client.listDevices.bind(client)
      client.listDevices = async () =>
        (await read()).map((device) =>
          device.id === id && !device.credentialState
            ? { ...device, connection: 'offline', credentialState: 'idle_expired' }
            : device,
        )
    })
    const create = vi.spyOn(client, 'createEnrollment')
    await screen.findByRole('button', { name: new RegExp(`^${name}`) })
    expect(within(deviceRow(name)).getByText('Needs sign-in')).toBeInTheDocument()
    const before = (await client.listDevices()).find((device) => device.id === id)!
    const defaultId = (await client.getSession()).defaultDeviceId
    const threadIds = (await client.listThreads()).map((thread) => thread.id)

    await user.click(deviceRow(name))
    expect(screen.getAllByText('Needs sign-in')).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: 'Reconnect device' }))
    const dialog = await screen.findByRole('dialog', { name: 'Reconnect device' })
    await within(dialog).findByText('Waiting for device…')
    expect(within(dialog).getByText(name)).toBeInTheDocument()
    expect(within(dialog).queryByLabelText('Device name')).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('radiogroup', { name: 'Operating system' })).not.toBeInTheDocument()
    const command = within(dialog).getByLabelText('Run in terminal')
    expect(command.textContent).toBe(`${tokenInput}\nbatond reauth && batond up`)
    expect(command.textContent).not.toContain(within(dialog).getByLabelText('Setup code').textContent!)
    const firstCode = within(dialog).getByLabelText('Setup code').textContent

    act(() => client.controls.expireEnrollment())
    await within(dialog).findByRole('button', { name: 'Get a new code' })
    client.controls.setReachable(false)
    await user.click(within(dialog).getByRole('button', { name: 'Get a new code' }))
    expect(await within(dialog).findByText("Can't reach Baton")).toBeInTheDocument()
    client.controls.setReachable(true)
    await user.click(within(dialog).getByRole('button', { name: 'Get a new code' }))
    await within(dialog).findByText('Waiting for device…')
    expect(within(dialog).getByLabelText('Setup code').textContent).not.toBe(firstCode)
    expect(create.mock.calls.map(([nodeId]) => nodeId)).toEqual([id, id, id])

    act(() => client.controls.connectEnrollment('Another name', 'macOS'))
    expect(await within(dialog).findByText('Connected')).toBeInTheDocument()
    expect(within(dialog).getByText(name)).toBeInTheDocument()
    act(() => scheduler.advance(browserLatency.device))
    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByText('Needs sign-in')).not.toBeInTheDocument())
    const devices = await client.listDevices()
    expect(devices).toHaveLength(3)
    expect(devices.find((device) => device.id === id)).toMatchObject({
      ...before,
      connection: 'online',
      credentialState: 'active',
      lastSeenAt: expect.any(Number),
    })
    expect((await client.getSession()).defaultDeviceId).toBe(defaultId)
    expect((await client.listThreads()).map((thread) => thread.id)).toEqual(threadIds)
    expect(screen.queryByRole('button', { name: 'Reconnect device' })).not.toBeInTheDocument()
  })

  it('connects a device with a setup code and updates the counts', async () => {
    const user = userEvent.setup()
    const { client, scheduler } = renderApp('/devices', 'empty')
    await user.click(await screen.findByRole('button', { name: 'Connect a device' }))
    const dialog = await screen.findByRole('dialog', { name: 'Connect a device' })
    expect(await within(dialog).findByText('Waiting for device…')).toBeInTheDocument()

    await user.type(within(dialog).getByLabelText('Device name'), 'Build Server')
    await user.click(within(dialog).getByRole('radio', { name: 'Linux' }))
    const command = within(dialog).getByLabelText('Run in terminal')
    expect(command).toHaveTextContent('read -rs BATON_ENROLLMENT_TOKEN && export BATON_ENROLLMENT_TOKEN')
    expect(command).toHaveTextContent('batond up --coordinator')
    expect(command).toHaveTextContent('--display-name "Build Server" --system linux')
    expect(command.textContent).not.toMatch(/[A-Za-z0-9]{8}-[A-Za-z0-9]{4}-/)

    await user.click(within(dialog).getByRole('button', { name: 'Copy command' }))
    expect(within(dialog).queryByText(/Clipboard blocked/)).not.toBeInTheDocument()

    act(() => client.controls.connectEnrollment('Build Server', 'Linux'))
    expect(await within(dialog).findByText('Connected')).toBeInTheDocument()
    expect(within(dialog).getByText('Linux · Checking availability…')).toBeInTheDocument()
    act(() => scheduler.advance(browserLatency.device))
    await waitFor(() => expect(within(dialog).queryByText(/Checking availability/)).not.toBeInTheDocument())
    expect(within(dialog).queryByText(/No agents available/)).not.toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    expect(screen.getByRole('heading', { name: '1 device, 1 online' })).toHaveFocus()
    const sidebar = screen.getByRole('navigation', { name: 'Workspace' })
    expect(within(sidebar).getByText('1/1 online')).toBeInTheDocument()
    expect(within(deviceRow('Build Server')).getByText('Default')).toBeInTheDocument()
  })

  it('gets a new code after the old one expires and keeps the form', async () => {
    const user = userEvent.setup()
    const { client } = renderApp('/devices')
    await user.click(await screen.findByRole('button', { name: 'Connect a device' }))
    const dialog = await screen.findByRole('dialog', { name: 'Connect a device' })
    await within(dialog).findByText('Waiting for device…')
    await user.type(within(dialog).getByLabelText('Device name'), 'Lab PC')
    await user.click(within(dialog).getByRole('radio', { name: 'Windows' }))

    act(() => client.controls.expireEnrollment())
    expect((await within(dialog).findAllByText('Setup code expired')).length).toBeGreaterThan(0)

    client.controls.setReachable(false)
    await user.click(within(dialog).getByRole('button', { name: 'Get a new code' }))
    expect(await within(dialog).findByText("Can't reach Baton")).toBeInTheDocument()

    client.controls.setReachable(true)
    await user.click(within(dialog).getByRole('button', { name: 'Get a new code' }))
    expect(await within(dialog).findByText('Waiting for device…')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Device name')).toHaveValue('Lab PC')
    expect(within(dialog).getByLabelText('Run in terminal')).toHaveTextContent(
      '$env:BATON_ENROLLMENT_TOKEN = Read-Host -MaskInput',
    )

    act(() => client.controls.useEnrollmentElsewhere())
    expect((await within(dialog).findAllByText('Setup code already used')).length).toBeGreaterThan(0)
  })

  it('removes device folders and keeps a folder when removal fails', async () => {
    const user = userEvent.setup()
    const { client } = renderApp('/devices')
    await user.click(await screen.findByRole('button', { name: /^Ubuntu Dev/ }))
    await user.click(screen.getByRole('button', { name: 'Folders…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Folders on Ubuntu Dev' })
    const remove = await within(dialog).findByRole('button', { name: 'Remove /home/kaken/work' })

    client.controls.setReachable(false)
    await user.click(remove)
    expect(await within(dialog).findByText("Couldn't remove the folder. Try again.")).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Remove /home/kaken/work' })).toBeInTheDocument()

    client.controls.setReachable(true)
    await user.click(within(dialog).getByRole('button', { name: 'Remove /home/kaken/work' }))
    await waitFor(() =>
      expect(within(dialog).queryByRole('button', { name: 'Remove /home/kaken/work' })).not.toBeInTheDocument(),
    )
    expect(await client.listFolders('dev-ubuntu', '/home/kaken/work')).toMatchObject({
      state: 'unavailable',
      reason: 'outsideFolders',
    })
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
    expect(await within(dialog).findByRole('alert')).toHaveTextContent("Couldn't start sign-in")
    client.controls.setReachable(true)
    await user.click(within(dialog).getByRole('button', { name: 'Retry sign-in' }))
    expect(await within(dialog).findByText('BATON-1234')).toBeInTheDocument()
  })

  it('confirms an offline default device before saving it', async () => {
    const user = userEvent.setup()
    renderApp('/devices')
    await screen.findByRole('heading', { name: '3 devices, 2 online' })
    const row = deviceRow('Windows Desktop')
    await user.click(row)
    const details = document.getElementById(row.getAttribute('aria-controls') ?? '')
    expect(details).not.toBeNull()
    expect(within(details!).getByText('New threads wait for it.')).toBeInTheDocument()
    await user.click(within(details!).getByRole('button', { name: 'Set as default' }))

    const dialog = await screen.findByRole('dialog', { name: 'Use Windows Desktop as default?' })
    await user.click(within(dialog).getByRole('button', { name: 'Save default device' }))
    await waitFor(() => expect(within(deviceRow('Windows Desktop')).getByText('Default')).toBeInTheDocument())
    expect(within(deviceRow('MacBook Pro')).queryByText('Default')).not.toBeInTheDocument()
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
    expect(screen.queryByText('Agents & subscriptions')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign in to ChatGPT' })).not.toBeInTheDocument()
    expect(screen.queryByText('Finish setup on Ubuntu Dev')).not.toBeInTheDocument()
  })

  it('shows a syncing device in its row without agent details', async () => {
    const user = userEvent.setup()
    renderApp('/devices', 'waiting')
    const row = await screen.findByRole('button', { name: /^Windows Desktop/ })
    expect(within(row).getByText('Syncing…')).toBeInTheDocument()
    await user.click(row)
    const details = document.getElementById(row.getAttribute('aria-controls') ?? '')
    expect(details).not.toBeNull()
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

    await user.click(toggle)
    const confirm = await screen.findByRole('dialog', { name: 'Let the project assistant run commands on Ubuntu Dev?' })
    expect(within(confirm).getByText(/Commands run directly as kaken/)).toBeInTheDocument()
    await user.click(within(confirm).getByRole('button', { name: 'Allow commands' }))
    expect(await screen.findByText('Saved')).toBeInTheDocument()
    expect(toggle).toBeChecked()

    client.controls.setReachable(false)
    await user.click(toggle)
    expect(await screen.findByText("Couldn't save. Commands are still allowed.")).toBeInTheDocument()
    expect(toggle).toBeChecked()
  })

  it('retries disconnecting the default device and asks for a replacement', async () => {
    const user = userEvent.setup()
    const { client } = renderApp('/devices')
    await screen.findByRole('heading', { name: '3 devices, 2 online' })
    await user.click(deviceRow('MacBook Pro'))
    await user.click(screen.getByRole('button', { name: 'Disconnect device' }))
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect “MacBook Pro”?' })
    expect(within(dialog).getByText(/You'll need to choose a new default/)).toBeInTheDocument()

    client.controls.setReachable(false)
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect device' }))
    expect(await screen.findByRole('dialog', { name: "Couldn't confirm disconnection" })).toBeInTheDocument()

    client.controls.setReachable(true)
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Choose a new default device')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '2 devices, 1 online' })).toHaveFocus()
    const sidebar = screen.getByRole('navigation', { name: 'Workspace' })
    expect(within(sidebar).getByText('1/2 online')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Set Ubuntu Dev as default' }))
    await waitFor(() => expect(within(deviceRow('Ubuntu Dev')).getByText('Default')).toBeInTheDocument())
    expect(screen.queryByText('Choose a new default device')).not.toBeInTheDocument()
  })

  it('moves the project assistant to another device when its device is removed', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/devices')
    await screen.findByRole('heading', { name: '3 devices, 2 online' })
    expect(within(deviceRow('Ubuntu Dev')).getByText('Running Baton Dev')).toBeInTheDocument()
    await user.click(deviceRow('Ubuntu Dev'))
    await user.click(screen.getByRole('button', { name: 'Disconnect device' }))
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect “Ubuntu Dev”?' })
    expect(within(dialog).getByText('Agents already running on it keep running locally.')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect device' }))
    expect(await screen.findByText('Ubuntu Dev disconnected')).toBeInTheDocument()
    expect(within(deviceRow('MacBook Pro')).getByText('Running Baton Dev')).toBeInTheDocument()

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
    expect(await screen.findByText("Couldn't load activity")).toBeInTheDocument()

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
    expect(await within(detail).findByText('Connection lost')).toBeInTheDocument()
    expect(within(detail).getByText(/No report since/)).toBeInTheDocument()

    act(() => client.controls.setDeviceConnection('dev-ubuntu', 'online'))
    expect(await within(detail).findByText('Earlier output not kept')).toBeInTheDocument()
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
    expect(await within(preview).findByText("Couldn't read this file")).toBeInTheDocument()
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

  it('copies a selection in a thread outside any project', async () => {
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
    await screen.findByRole('region', { name: 'Which runner should run nightly?' })
    select(await screen.findByText('MacBook Pro sleeps at night. Ubuntu Dev is always on.'))
    await user.click(await screen.findByRole('button', { name: 'Ask project assistant' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/projects/prj-compat'))
    const reference = await screen.findByRole('figure', { name: 'Reference from Which runner should run nightly?' })
    expect(within(reference).getByText(/MacBook Pro sleeps at night/)).toBeInTheDocument()
  })
})
