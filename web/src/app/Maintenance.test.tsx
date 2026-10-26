import { createMemoryHistory } from '@tanstack/react-router'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vite-plus/test'
import { ClientError } from '../data/client'
import { createMockClient } from '../data/mock/client'
import type { ScenarioId } from '../data/mock/scenarios'
import { manualScheduler } from '../data/mock/scheduler'
import { browserLatency } from '../data/mock/store'
import { App } from './App'
import { createAppRouter } from './router'

const projectPath = '/projects/prj-compat'
const settingsPath = `${projectPath}?settings=true`
const memoryPath = `${projectPath}?view=memory`
const originalMemory = 'Compat suite is in `C:\\src\\compat-suite` on Windows Desktop.'

function setup(
  path = projectPath,
  scenario: ScenarioId = 'normal',
  configure?: (client: ReturnType<typeof createMockClient>, scheduler: ReturnType<typeof manualScheduler>) => void,
) {
  const scheduler = manualScheduler()
  const client = createMockClient(scenario, { scheduler, latency: browserLatency })
  configure?.(client, scheduler)
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) })
  render(<App client={client} router={router} />)
  return { client, scheduler, router }
}

async function advance(scheduler: ReturnType<typeof manualScheduler>, ms: number) {
  for (let passed = 0; passed < ms; passed += 50) {
    await act(async () => scheduler.advance(Math.min(50, ms - passed)))
  }
}

async function replace(user: ReturnType<typeof userEvent.setup>, field: HTMLElement, value: string) {
  await user.clear(field)
  if (value) await user.type(field, value)
}

async function openSettings(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Project actions' }))
  await user.click(await screen.findByRole('menuitem', { name: 'Settings' }))
  return screen.findByRole('dialog', { name: /· settings$/ })
}

beforeEach(() => localStorage.clear())

describe('project maintenance', () => {
  it('opens settings from project actions and syncs name and goal after blur', async () => {
    const user = userEvent.setup()
    const { router } = setup()
    const dialog = await openSettings(user)
    expect(router.state.location.search).toMatchObject({ settings: true })
    await replace(user, within(dialog).getByLabelText('Project name'), 'Release compatibility')
    await user.click(within(dialog).getByLabelText(/^Goal/))
    await waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent('Saved'))
    await replace(user, within(dialog).getByLabelText(/^Goal/), 'Verify Windows and Linux before release.')
    await user.click(within(dialog).getByLabelText('Project name'))
    await waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent('Saved'))
    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    expect(await screen.findByRole('heading', { name: 'Release compatibility' })).toBeInTheDocument()
    expect(
      within(screen.getByRole('navigation', { name: 'Workspace' })).getByRole('link', {
        name: /Release compatibility/,
      }),
    ).toBeInTheDocument()
    expect(
      within(screen.getByRole('complementary', { name: 'Overview' })).getByText(
        'Verify Windows and Linux before release.',
      ),
    ).toBeInTheDocument()
    expect(router.state.location.search.settings).toBeUndefined()
    const reopened = await openSettings(user)
    expect(within(reopened).getByLabelText('Project name')).toHaveValue('Release compatibility')
    expect(within(reopened).getByLabelText(/^Goal/)).toHaveValue('Verify Windows and Linux before release.')
  })

  it('closes with an invalid draft, pauses the saved project and lets the draft be discarded', async () => {
    const user = userEvent.setup()
    const { client } = setup(settingsPath)
    const update = vi.spyOn(client, 'updateProject')
    const dialog = await screen.findByRole('dialog', { name: 'Compatibility · settings' })
    await replace(user, within(dialog).getByLabelText('Project name'), '   ')
    await user.click(within(dialog).getByRole('button', { name: 'Pause' }))
    expect(await within(dialog).findByRole('button', { name: 'Resume' })).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Project name')).toHaveValue('   ')
    expect(update).not.toHaveBeenCalled()
    expect((await client.listProjects()).find((project) => project.id === 'prj-compat')?.status).toBe('paused')
    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const reopened = await openSettings(user)
    expect(within(reopened).getByLabelText('Project name')).toHaveValue('   ')
    await user.click(within(reopened).getByRole('button', { name: 'Discard changes' }))
    expect(within(reopened).getByLabelText('Project name')).toHaveValue('Compatibility')
    expect(update).not.toHaveBeenCalled()
  })

  it('retains failed settings across closing and saves the same edits after reopening', async () => {
    const user = userEvent.setup()
    const { router } = setup(settingsPath, 'normal', (client) => {
      vi.spyOn(client, 'updateProject').mockRejectedValueOnce(new ClientError('unavailable', 'Disconnected'))
    })
    const dialog = await screen.findByRole('dialog', { name: 'Compatibility · settings' })
    await replace(user, within(dialog).getByLabelText(/^Goal/), 'Keep this goal after failure.')
    await user.click(within(dialog).getByLabelText('Project name'))
    expect(
      await within(dialog).findByText('Could not save changes. Your edits are kept. Try again.'),
    ).toBeInTheDocument()
    expect(within(dialog).getByLabelText(/^Goal/)).toHaveValue('Keep this goal after failure.')
    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await act(() =>
      router.navigate({ to: '/projects/$projectId', params: { projectId: 'prj-compat' }, search: { settings: true } }),
    )
    const reopened = await screen.findByRole('dialog', { name: 'Compatibility · settings' })
    expect(within(reopened).getByLabelText(/^Goal/)).toHaveValue('Keep this goal after failure.')
    await user.click(within(reopened).getByLabelText('Project name'))
    await user.click(within(reopened).getByLabelText(/^Goal/))
    await waitFor(() => expect(within(reopened).getByRole('status')).toHaveTextContent('Saved'))
    await user.click(within(reopened).getByRole('button', { name: 'Done' }))
    expect(
      await within(screen.getByRole('complementary', { name: 'Overview' })).findByText('Keep this goal after failure.'),
    ).toBeInTheDocument()
  })

  it('keeps newer drafts and the paused status when an earlier settings response arrives later', async () => {
    const user = userEvent.setup()
    let release: (() => void) | undefined
    const { client } = setup(settingsPath, 'normal', (client) => {
      const update = client.updateProject.bind(client)
      vi.spyOn(client, 'updateProject').mockImplementationOnce(async (input) => {
        const saved = await update(input)
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return saved
      })
    })
    const dialog = await screen.findByRole('dialog', { name: 'Compatibility · settings' })
    await replace(user, within(dialog).getByLabelText('Project name'), 'Earlier name')
    await user.click(within(dialog).getByLabelText(/^Goal/))
    await waitFor(() => expect(release).toBeDefined())
    await replace(user, within(dialog).getByLabelText('Project name'), '   ')
    await user.click(within(dialog).getByRole('button', { name: 'Pause' }))
    expect(await within(dialog).findByRole('button', { name: 'Resume' })).toBeInTheDocument()
    await act(async () => release?.())
    expect(await within(dialog).findByText('Enter a project name.', { selector: 'p' })).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Project name')).toHaveValue('   ')
    expect(within(dialog).getByRole('button', { name: 'Resume' })).toBeInTheDocument()
    expect((await client.listProjects()).find((project) => project.id === 'prj-compat')).toMatchObject({
      name: 'Earlier name',
      status: 'paused',
    })
  })

  it('preserves newer settings during delayed saves and after browser back and reopening', async () => {
    const user = userEvent.setup()
    let updateSpy!: MockInstance<ReturnType<typeof createMockClient>['updateProject']>
    const { client, scheduler, router } = setup(settingsPath, 'normal', (client, clock) => {
      const update = client.updateProject.bind(client)
      updateSpy = vi.spyOn(client, 'updateProject').mockImplementation(async (input) => {
        const snapshot = structuredClone(input)
        await new Promise<void>((resolve) => clock.after(browserLatency.save, resolve))
        return update(snapshot)
      })
    })
    const dialog = await screen.findByRole('dialog', { name: 'Compatibility · settings' })
    const name = within(dialog).getByLabelText('Project name')
    await replace(user, name, 'First name')
    await user.click(within(dialog).getByLabelText(/^Goal/))
    expect(within(dialog).getByRole('status')).toHaveTextContent('Saving…')
    await replace(user, name, 'Latest name')
    await replace(user, within(dialog).getByLabelText(/^Goal/), 'The latest goal must survive.')
    await user.click(name)
    await advance(scheduler, browserLatency.save)
    expect(within(dialog).getByLabelText('Project name')).toHaveValue('Latest name')
    expect(within(dialog).getByLabelText(/^Goal/)).toHaveValue('The latest goal must survive.')
    await advance(scheduler, browserLatency.save)
    await waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent('Saved'))
    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    expect(await screen.findByRole('heading', { name: 'Latest name' })).toBeInTheDocument()
    const reopened = await openSettings(user)
    expect(within(reopened).getByLabelText(/^Goal/)).toHaveValue('The latest goal must survive.')

    await replace(user, within(reopened).getByLabelText('Project name'), 'Before navigating back')
    await user.click(within(reopened).getByLabelText(/^Goal/))
    expect(within(reopened).getByRole('status')).toHaveTextContent('Saving…')
    await replace(user, within(reopened).getByLabelText('Project name'), 'Queued in old dialog')
    await act(async () => router.history.back())
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const remounted = await openSettings(user)
    expect(within(remounted).getByLabelText('Project name')).toHaveValue('Queued in old dialog')
    await replace(user, within(remounted).getByLabelText('Project name'), 'After reopening settings')
    await user.click(within(remounted).getByLabelText(/^Goal/))
    await advance(scheduler, browserLatency.save)
    expect(within(remounted).getByLabelText('Project name')).toHaveValue('After reopening settings')
    await advance(scheduler, browserLatency.save)
    await waitFor(() => expect(within(remounted).getByRole('status')).toHaveTextContent('Saved'))
    await user.click(within(remounted).getByRole('button', { name: 'Done' }))
    expect(await screen.findByRole('heading', { name: 'After reopening settings' })).toBeInTheDocument()
    await advance(scheduler, browserLatency.save * 3)
    expect((await client.listProjects()).find((project) => project.id === 'prj-compat')?.name).toBe(
      'After reopening settings',
    )
    expect(updateSpy.mock.calls.map(([input]) => input.patch.name)).not.toContain('Queued in old dialog')
  })

  it('keeps new memory drafts in their own project across browser history', async () => {
    const user = userEvent.setup()
    const { client, router } = setup('/projects/prj-baton?view=memory')
    await screen.findByRole('button', { name: 'Add memory' })
    await act(() =>
      router.navigate({ to: '/projects/$projectId', params: { projectId: 'prj-compat' }, search: { view: 'memory' } }),
    )
    await user.click(await screen.findByRole('button', { name: 'Add memory' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add memory' })
    await user.type(within(dialog).getByLabelText('Memory'), 'Only the Compatibility project should get this memory.')
    await act(async () => router.history.back())
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await user.click(await screen.findByRole('button', { name: 'Add memory' }))
    const other = await screen.findByRole('dialog', { name: 'Add memory' })
    expect(within(other).getByLabelText('Memory')).toHaveValue('')
    await user.click(within(other).getByRole('button', { name: 'Cancel' }))
    await act(async () => router.history.forward())
    await user.click(await screen.findByRole('button', { name: 'Add memory' }))
    const restored = await screen.findByRole('dialog', { name: 'Add memory' })
    expect(within(restored).getByLabelText('Memory')).toHaveValue(
      'Only the Compatibility project should get this memory.',
    )
    await user.click(within(restored).getByRole('button', { name: 'Save memory' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(
      (await client.listProjectMemory('prj-compat')).filter(
        (note) => note.body === 'Only the Compatibility project should get this memory.',
      ),
    ).toHaveLength(1)
    expect(
      (await client.listProjectMemory('prj-baton')).some(
        (note) => note.body === 'Only the Compatibility project should get this memory.',
      ),
    ).toBe(false)
  })

  it('explains when a model change takes effect and preserves the active run', async () => {
    const user = userEvent.setup()
    const { client } = setup('/projects/prj-baton?settings=true')
    const dialog = await screen.findByRole('dialog', { name: 'Baton Dev · settings' })
    expect(within(dialog).getByText('Applies to the next run. The current run keeps its model.')).toBeInTheDocument()
    await user.selectOptions(within(dialog).getByLabelText('Subscription'), 'Claude')
    expect(within(dialog).getByLabelText('Project assistant model')).toHaveValue('claude-opus-5-5')
    await user.selectOptions(within(dialog).getByLabelText('Project assistant model'), 'claude-sonnet-5-5')
    await waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent('Saved'))
    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    expect(await screen.findByRole('button', { name: 'Stop run' })).toBeInTheDocument()
    const project = (await client.listProjects()).find((item) => item.id === 'prj-baton')!
    expect(project).toMatchObject({
      subscription: 'Claude',
      model: 'claude-sonnet-5-5',
      agent: { state: 'running', deviceId: 'dev-ubuntu' },
    })
    const reopened = await openSettings(user)
    expect(within(reopened).getByLabelText('Project assistant model')).toHaveValue('claude-sonnet-5-5')
  })

  it('recovers failed project and memory reads with Retry project and Retry memory', async () => {
    const user = userEvent.setup()
    let failing = true
    let memorySpy!: MockInstance<ReturnType<typeof createMockClient>['listProjectMemory']>
    setup(projectPath, 'maintenanceError', (client) => {
      const listMemory = client.listProjectMemory.bind(client)
      memorySpy = vi.spyOn(client, 'listProjectMemory').mockImplementation(async (projectId) => {
        const notes = await listMemory(projectId)
        if (failing) throw new ClientError('unavailable', 'Could not load memory')
        return notes
      })
    })
    expect(await screen.findByText('Could not load project', { exact: true })).toBeInTheDocument()
    expect(screen.queryByLabelText('Message the project assistant')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry project' }))
    expect(await screen.findByRole('heading', { name: 'Compatibility' })).toBeInTheDocument()
    expect(screen.queryByText('Could not load project', { exact: true })).not.toBeInTheDocument()
    await waitFor(() => expect(memorySpy).toHaveBeenCalledWith('prj-compat'))
    await act(async () => {
      await Promise.allSettled(memorySpy.mock.results.map((result) => result.value))
    })
    expect(memorySpy).toHaveBeenCalledTimes(1)

    failing = false
    await user.click(screen.getByRole('tab', { name: /Memory/ }))
    const memory = await screen.findByRole('region', { name: 'Project memory' })
    expect(await within(memory).findByText('Could not load project memory')).toBeInTheDocument()
    expect(within(memory).queryByRole('article')).not.toBeInTheDocument()
    expect(memorySpy).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('region', { name: 'Conversation' })).toHaveTextContent(
      'Run the compat suite on Windows Desktop and report failures.',
    )

    await user.click(within(memory).getByRole('button', { name: 'Retry memory' }))
    expect(await within(memory).findByRole('button', { name: originalMemory })).toBeInTheDocument()
    expect(within(memory).queryByText('Could not load project memory')).not.toBeInTheDocument()
    expect(within(memory).queryByRole('button', { name: 'Retry memory' })).not.toBeInTheDocument()
    expect(memorySpy).toHaveBeenCalledTimes(2)
  })

  it('adds memory and records the author and previous version when editing assistant memory', async () => {
    const user = userEvent.setup()
    const { router } = setup()
    await user.click(await screen.findByRole('button', { name: 'Project actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Memory' }))
    expect(router.state.location.search).toMatchObject({ view: 'memory' })
    const memory = await screen.findByRole('region', { name: 'Project memory' })
    await user.click(within(memory).getByRole('button', { name: 'Add memory' }))
    const add = await screen.findByRole('dialog', { name: 'Add memory' })
    await user.type(within(add).getByLabelText('Memory'), 'Release only after all supported OS tests pass.')
    await user.click(within(add).getByRole('button', { name: 'Save memory' }))
    expect(
      await within(memory).findByRole('button', { name: 'Release only after all supported OS tests pass.' }),
    ).toBeInTheDocument()
    const added = screen
      .getAllByRole('article', { name: 'Memory v1' })
      .find((item) => item.textContent?.includes('Release only'))!
    expect(within(added).getByText(/^v1 · You ·/)).toBeInTheDocument()
    await user.click(within(memory).getByRole('button', { name: originalMemory }))
    const edit = await screen.findByRole('dialog', { name: 'Edit memory' })
    expect(within(edit).getByText(/v1 · Project assistant ·/)).toBeInTheDocument()
    await replace(user, within(edit).getByLabelText('Memory'), 'The Windows suite lives in C:\\src\\compat-suite.')
    await user.click(within(edit).getByRole('button', { name: 'Save memory' }))
    const version = await within(memory).findByRole('article', { name: 'Memory v2' })
    expect(within(version).getByText(/^v2 · You ·/)).toBeInTheDocument()
    await user.click(within(version).getByText('Version history'))
    expect(within(version).getByText(originalMemory)).toBeVisible()
    expect(within(version).getByText(/^v1 · Project assistant ·/)).toBeVisible()
  })

  it('keeps a memory draft after validation and save failure, then retries without duplication', async () => {
    const user = userEvent.setup()
    const { client } = setup(memoryPath, 'normal', (client) => {
      vi.spyOn(client, 'saveMemory').mockRejectedValueOnce(new ClientError('unavailable', 'Disconnected'))
    })
    await user.click(await screen.findByRole('button', { name: 'Add memory' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add memory' })
    await user.click(within(dialog).getByRole('button', { name: 'Save memory' }))
    expect(await within(dialog).findByText('Enter a memory.')).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText('Memory'), 'Never skip Windows regressions.')
    await user.click(within(dialog).getByRole('button', { name: 'Save memory' }))
    expect(
      await within(dialog).findByText('Could not save this memory. Your draft is kept. Try again.'),
    ).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Memory')).toHaveValue('Never skip Windows regressions.')
    await user.click(within(dialog).getByRole('button', { name: 'Save memory' }))
    expect(await screen.findByRole('button', { name: 'Never skip Windows regressions.' })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(
      (await client.listProjectMemory('prj-compat')).filter((note) => note.body === 'Never skip Windows regressions.'),
    ).toHaveLength(1)
  })

  it('reviews a conflicting memory version while keeping the draft, then saves a new version', async () => {
    const user = userEvent.setup()
    setup(memoryPath, 'memoryConflict')
    await user.click(await screen.findByRole('button', { name: originalMemory }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit memory' })
    await replace(user, within(dialog).getByLabelText('Memory'), 'Run all Windows path regressions before release.')
    await user.click(within(dialog).getByRole('button', { name: 'Save memory' }))
    expect(
      await within(dialog).findByText('Run the Windows drive-letter tests before every release.'),
    ).toBeInTheDocument()
    expect(within(dialog).getByText(/Latest · v2 · Project assistant/)).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Memory')).toHaveValue('Run all Windows path regressions before release.')
    expect(within(dialog).queryByRole('button', { name: 'Save memory' })).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Review latest' }))
    expect(within(dialog).getByRole('status')).toHaveTextContent('Editing v2')
    expect(within(dialog).getByLabelText('Memory')).toHaveValue('Run all Windows path regressions before release.')
    await user.click(within(dialog).getByRole('button', { name: 'Save memory' }))
    const note = await screen.findByRole('article', { name: 'Memory v3' })
    expect(
      within(note).getByRole('button', { name: 'Run all Windows path regressions before release.' }),
    ).toBeInTheDocument()
    expect(within(note).getByText(/^v3 · You ·/)).toBeInTheDocument()
    await user.click(within(note).getByText('Version history'))
    expect(within(note).getByText('Run the Windows drive-letter tests before every release.')).toBeVisible()
    expect(within(note).getByText(originalMemory)).toBeVisible()
  })

  it('saves messages and Inbox answers while paused, lets threads run, and reads the backlog on resume', async () => {
    const user = userEvent.setup()
    const { client, scheduler, router } = setup(projectPath, 'inboxPaused')
    expect(await screen.findByText('This project is paused')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Message the project assistant'), 'Read this after resuming.{Enter}')
    expect(await screen.findByText('Read this after resuming.')).toBeInTheDocument()
    await advance(scheduler, browserLatency.save)
    expect(
      (await client.listProjectEntries('prj-compat')).find(
        (entry) => entry.kind === 'user' && entry.body === 'Read this after resuming.',
      ),
    ).toMatchObject({ delivery: 'saved' })
    await act(() => router.navigate({ to: '/inbox' }))
    const question = await screen.findByRole('region', { name: 'What should the release notes mention?' })
    await user.click(within(question).getByRole('button', { name: /Other…/ }))
    await user.type(within(question).getByLabelText('Your reply'), 'Mention Windows support.')
    await user.click(within(question).getByRole('button', { name: 'Send reply' }))
    expect(
      await within(await screen.findByRole('region', { name: 'Latest result' })).findByText(/when the project resumes/),
    ).toBeInTheDocument()
    await act(() =>
      router.navigate({
        to: '/projects/$projectId',
        params: { projectId: 'prj-compat' },
        search: { thread: 'thr-compat' },
      }),
    )
    const thread = await screen.findByRole('complementary', { name: 'Run compat suite on Windows' })
    act(() => client.controls.setDeviceConnection('dev-windows', 'online'))
    await user.type(within(thread).getByLabelText('Message'), 'Keep running the suite.{Enter}')
    await advance(scheduler, browserLatency.save + browserLatency.run)
    expect(await within(thread).findByText('Done. The change is ready for review.')).toBeInTheDocument()
    expect(screen.getByText('This project is paused')).toBeInTheDocument()
    expect((await client.listProjects()).find((project) => project.id === 'prj-compat')?.agent.state).toBe('idle')
    await user.click(screen.getByRole('button', { name: 'Resume project' }))
    await waitFor(() => expect(screen.queryByText('This project is paused')).not.toBeInTheDocument())
    await advance(scheduler, browserLatency.run * 2)
    const entries = await client.listProjectEntries('prj-compat')
    expect(entries.find((entry) => entry.kind === 'user' && entry.body === 'Read this after resuming.')).toMatchObject({
      delivery: 'delivered',
    })
    expect(
      entries.some(
        (entry) =>
          entry.kind === 'user' && entry.body.includes('Mention Windows support.') && entry.delivery === 'delivered',
      ),
    ).toBe(true)
    expect(screen.getByRole('region', { name: 'Conversation' })).toHaveTextContent('Read this after resuming.')
  })

  it('explains archiving and lets cancellation return to the unchanged project', async () => {
    const user = userEvent.setup()
    const { client, router } = setup()
    await user.click(await screen.findByRole('button', { name: 'Project actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Archive project' }))
    expect(router.state.location.search).toMatchObject({ settings: true, archive: true })
    const dialog = await screen.findByRole('dialog', { name: 'Archive “Compatibility”?' })
    expect(
      within(dialog).getByText(
        'Stops the project assistant and withdraws 2 open questions. The main chat and memory are kept. Existing threads continue.',
      ),
    ).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    const settings = await screen.findByRole('dialog', { name: 'Compatibility · settings' })
    await user.click(within(settings).getByRole('button', { name: 'Done' }))
    expect(screen.getByLabelText('Message the project assistant')).toBeInTheDocument()
    expect((await client.listProjects()).find((project) => project.id === 'prj-compat')?.status).toBe('active')
    expect(
      (await client.listInbox()).filter((item) => item.projectId === 'prj-compat' && item.status === 'pending'),
    ).toHaveLength(2)
  })

  it('retries a failed archive, hides the project composer and keeps conversation, memory and threads', async () => {
    const user = userEvent.setup()
    const { scheduler, router, client } = setup(`${settingsPath}&archive=true`, 'normal', (client) => {
      vi.spyOn(client, 'setProjectStatus').mockRejectedValueOnce(new ClientError('unavailable', 'Disconnected'))
    })
    const dialog = await screen.findByRole('dialog', { name: 'Archive “Compatibility”?' })
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Could not archive this project. Try again.')
    expect((await client.listProjects()).find((project) => project.id === 'prj-compat')?.status).toBe('active')
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }))
    const settings = await screen.findByRole('dialog', { name: 'Compatibility · settings' })
    expect(within(settings).getByText('Read only')).toBeInTheDocument()
    await user.click(within(settings).getByRole('button', { name: 'Done' }))
    expect(await screen.findByText('This project is archived')).toBeInTheDocument()
    expect(screen.queryByLabelText('Message the project assistant')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Conversation' })).toHaveTextContent(
      'Run the compat suite on Windows Desktop and report failures.',
    )
    expect(
      within(screen.getByRole('navigation', { name: 'Workspace' })).queryByRole('link', { name: /Compatibility/ }),
    ).not.toBeInTheDocument()
    expect(
      (await client.listInbox())
        .filter((item) => item.projectId === 'prj-compat')
        .every((item) => item.status === 'withdrawn'),
    ).toBe(true)
    await user.click(screen.getByRole('tab', { name: /Memory/ }))
    const memory = await screen.findByRole('region', { name: 'Project memory' })
    expect(within(memory).getByText(originalMemory)).toBeInTheDocument()
    await act(() =>
      router.navigate({
        to: '/projects/$projectId',
        params: { projectId: 'prj-compat' },
        search: { thread: 'thr-compat' },
      }),
    )
    const thread = await screen.findByRole('complementary', { name: 'Run compat suite on Windows' })
    act(() => client.controls.setDeviceConnection('dev-windows', 'online'))
    await user.type(within(thread).getByLabelText('Message'), 'Continue after project archive.{Enter}')
    await advance(scheduler, browserLatency.save + browserLatency.run)
    expect(await within(thread).findByText('Done. The change is ready for review.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Message the project assistant')).not.toBeInTheDocument()
  })

  it('opens archived projects from the sidebar with read-only settings and memory', async () => {
    const user = userEvent.setup()
    const { router } = setup('/threads', 'archived')
    const sidebar = await screen.findByRole('navigation', { name: 'Workspace' })
    await user.click(within(sidebar).getByRole('link', { name: 'Archived projects' }))
    expect(await screen.findByRole('heading', { name: 'Archived projects' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/projects/archived')
    await user.click(screen.getByRole('link', { name: /Compatibility/ }))
    expect(await screen.findByText('This project is archived')).toBeInTheDocument()
    const dialog = await openSettings(user)
    for (const label of ['Project name', 'Goal', 'Subscription', 'Project assistant model']) {
      expect(within(dialog).getByLabelText(label, { exact: false })).toHaveAttribute('readonly')
    }
    expect(within(dialog).queryByRole('button', { name: /^(Pause|Resume|Archive)$/ })).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    await user.click(screen.getByRole('tab', { name: /Memory/ }))
    const memory = await screen.findByRole('region', { name: 'Project memory' })
    expect(within(memory).getByText('Project memory is read only.')).toBeInTheDocument()
    expect(within(memory).getByText(originalMemory)).toBeInTheDocument()
    expect(within(memory).queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Message the project assistant')).not.toBeInTheDocument()
  })
})
