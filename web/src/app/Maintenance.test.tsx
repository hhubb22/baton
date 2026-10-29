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
  if (value) await user.paste(value)
}

async function openSettings(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Project actions' }))
  await user.click(await screen.findByRole('menuitem', { name: 'Settings' }))
  await screen.findByRole('heading', { name: 'Project settings' })
}

async function save(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Save changes' }))
}

function settingsStatus() {
  return screen.getByRole('status')
}

async function back(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Back to project' }))
  await waitFor(() => expect(screen.queryByRole('heading', { name: 'Project settings' })).not.toBeInTheDocument())
}

beforeEach(() => localStorage.clear())

describe('project maintenance', () => {
  it('saves name and goal only when Save changes is clicked', async () => {
    const user = userEvent.setup()
    const { router, client } = setup()
    const update = vi.spyOn(client, 'updateProject')
    await openSettings(user)
    expect(router.state.location.search).toMatchObject({ settings: true })
    await replace(user, screen.getByLabelText('Name'), 'Release compatibility')
    await user.click(screen.getByLabelText(/^Goal/))
    await replace(user, screen.getByLabelText(/^Goal/), 'Verify Windows and Linux before release.')
    await user.click(screen.getByLabelText('Name'))
    expect(settingsStatus()).toHaveTextContent('Changes not saved')
    expect(update).not.toHaveBeenCalled()
    await save(user)
    await waitFor(() => expect(settingsStatus()).toHaveTextContent('Saved'))
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({
      projectId: 'prj-compat',
      patch: { name: 'Release compatibility', goal: 'Verify Windows and Linux before release.' },
    })
    await back(user)
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
    await openSettings(user)
    expect(screen.getByLabelText('Name')).toHaveValue('Release compatibility')
    expect(screen.getByLabelText(/^Goal/)).toHaveValue('Verify Windows and Linux before release.')
  })

  it('saves optional memory embeddings, retains a failed draft and turns them off', async () => {
    const user = userEvent.setup()
    const { client } = setup(settingsPath, 'normal', (client) => {
      vi.spyOn(client, 'updateProject').mockRejectedValueOnce(new ClientError('unavailable', 'Disconnected'))
    })
    const update = vi.spyOn(client, 'updateProject')
    await screen.findByRole('heading', { name: 'Project settings' })
    expect(screen.getByRole('switch', { name: 'Memory embeddings' })).not.toBeChecked()
    await user.click(screen.getByRole('switch', { name: 'Memory embeddings' }))
    await replace(user, screen.getByLabelText('Embedding base URL'), 'http://localhost:11434/v1')
    await replace(user, screen.getByLabelText(/^Device credential name/), 'local-embeddings')
    await replace(user, screen.getByLabelText('Embedding model'), 'local-embed')
    await user.click(screen.getByLabelText('Name'))
    expect(update).not.toHaveBeenCalled()
    await save(user)
    expect(await screen.findByText("Couldn't save. Try again.")).toBeInTheDocument()
    expect(screen.getByLabelText('Embedding model')).toHaveValue('local-embed')
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(settingsStatus()).toHaveTextContent('Saved'))
    expect((await client.listProjects()).find((project) => project.id === 'prj-compat')?.memoryEmbedding).toEqual({
      base_url: 'http://localhost:11434/v1',
      model: 'local-embed',
      credential_profile: 'local-embeddings',
      config_id: expect.any(String),
    })
    await replace(user, screen.getByLabelText('Embedding model'), 'another-embed')
    await save(user)
    await waitFor(() => expect(settingsStatus()).toHaveTextContent('Saved'))
    expect(update).toHaveBeenLastCalledWith({
      projectId: 'prj-compat',
      patch: {
        memoryEmbedding: {
          base_url: 'http://localhost:11434/v1',
          model: 'another-embed',
          credential_profile: 'local-embeddings',
        },
      },
    })
    await user.click(screen.getByRole('switch', { name: 'Memory embeddings' }))
    expect(settingsStatus()).toHaveTextContent('Changes not saved')
    await save(user)
    await waitFor(() => expect(settingsStatus()).toHaveTextContent('Saved'))
    expect(update).toHaveBeenLastCalledWith({ projectId: 'prj-compat', patch: { memoryEmbedding: null } })
    expect(screen.queryByLabelText('Embedding model')).not.toBeInTheDocument()
    expect((await client.listProjects()).find((project) => project.id === 'prj-compat')?.memoryEmbedding).toBeNull()
  })

  it('keeps an invalid name draft, pauses the saved project and lets the draft be discarded', async () => {
    const user = userEvent.setup()
    const { client } = setup(settingsPath)
    const update = vi.spyOn(client, 'updateProject')
    await screen.findByRole('heading', { name: 'Project settings' })
    await replace(user, screen.getByLabelText('Name'), '   ')
    await save(user)
    expect(await screen.findByText('Enter a project name.', { selector: 'p' })).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true')
    expect(settingsStatus()).toHaveTextContent('Changes not saved')
    await user.click(screen.getByRole('button', { name: 'Pause' }))
    expect(await screen.findByRole('button', { name: 'Resume' })).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveValue('   ')
    expect(update).not.toHaveBeenCalled()
    expect((await client.listProjects()).find((project) => project.id === 'prj-compat')?.status).toBe('paused')
    await back(user)
    await openSettings(user)
    expect(screen.getByLabelText('Name')).toHaveValue('   ')
    await user.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(screen.getByLabelText('Name')).toHaveValue('Compatibility')
    expect(settingsStatus()).toHaveTextContent('')
    expect(update).not.toHaveBeenCalled()
  })

  it('keeps failed settings when leaving and saves the same edits after returning', async () => {
    const user = userEvent.setup()
    const { router } = setup(settingsPath, 'normal', (client) => {
      vi.spyOn(client, 'updateProject').mockRejectedValueOnce(new ClientError('unavailable', 'Disconnected'))
    })
    await screen.findByRole('heading', { name: 'Project settings' })
    await replace(user, screen.getByLabelText(/^Goal/), 'Keep this goal after failure.')
    await save(user)
    expect(await screen.findByText("Couldn't save. Try again.")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.getByLabelText(/^Goal/)).toHaveValue('Keep this goal after failure.')
    await back(user)
    await act(() =>
      router.navigate({ to: '/projects/$projectId', params: { projectId: 'prj-compat' }, search: { settings: true } }),
    )
    await screen.findByRole('heading', { name: 'Project settings' })
    expect(screen.getByLabelText(/^Goal/)).toHaveValue('Keep this goal after failure.')
    expect(settingsStatus()).toHaveTextContent('Changes not saved')
    await save(user)
    await waitFor(() => expect(settingsStatus()).toHaveTextContent('Saved'))
    await back(user)
    expect(
      await within(screen.getByRole('complementary', { name: 'Overview' })).findByText('Keep this goal after failure.'),
    ).toBeInTheDocument()
  })

  it('asks the browser to confirm before unloading unsaved settings', async () => {
    const user = userEvent.setup()
    setup(settingsPath)
    await screen.findByRole('heading', { name: 'Project settings' })
    const unload = () => {
      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    }
    expect(unload()).toBe(false)
    await replace(user, screen.getByLabelText('Name'), 'Unsaved name')
    expect(unload()).toBe(true)
    await save(user)
    await waitFor(() => expect(settingsStatus()).toHaveTextContent('Saved'))
    expect(unload()).toBe(false)
  })

  it('preserves edits made while saving and after browser back and returning', async () => {
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
    await screen.findByRole('heading', { name: 'Project settings' })
    await replace(user, screen.getByLabelText('Name'), 'First name')
    await save(user)
    expect(settingsStatus()).toHaveTextContent('Saving…')
    await replace(user, screen.getByLabelText('Name'), 'Latest name')
    await replace(user, screen.getByLabelText(/^Goal/), 'The latest goal must survive.')
    await advance(scheduler, browserLatency.save)
    await waitFor(() => expect(settingsStatus()).toHaveTextContent('Changes not saved'))
    expect(screen.getByLabelText('Name')).toHaveValue('Latest name')
    expect(screen.getByLabelText(/^Goal/)).toHaveValue('The latest goal must survive.')
    expect(updateSpy.mock.calls.map(([input]) => input.patch)).toEqual([{ name: 'First name' }])
    await save(user)
    await advance(scheduler, browserLatency.save)
    await waitFor(() => expect(settingsStatus()).toHaveTextContent('Saved'))
    await back(user)
    expect(await screen.findByRole('heading', { name: 'Latest name' })).toBeInTheDocument()

    await openSettings(user)
    await replace(user, screen.getByLabelText('Name'), 'Unsaved before navigating back')
    await act(async () => router.history.back())
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Project settings' })).not.toBeInTheDocument())
    await openSettings(user)
    expect(screen.getByLabelText('Name')).toHaveValue('Unsaved before navigating back')
    expect(settingsStatus()).toHaveTextContent('Changes not saved')
    expect(updateSpy).toHaveBeenCalledTimes(2)
    expect((await client.listProjects()).find((project) => project.id === 'prj-compat')?.name).toBe('Latest name')
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
    await screen.findByRole('heading', { name: 'Project settings' })
    expect(screen.getByText('Changes apply from the next run.')).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Model source'), '|Claude')
    expect(screen.getByLabelText('Project assistant model')).toHaveValue('claude-opus-5-5')
    await user.selectOptions(screen.getByLabelText('Project assistant model'), 'claude-sonnet-5-5')
    await save(user)
    await waitFor(() => expect(settingsStatus()).toHaveTextContent('Saved'))
    await back(user)
    expect(await screen.findByRole('button', { name: 'Stop run' })).toBeInTheDocument()
    const project = (await client.listProjects()).find((item) => item.id === 'prj-baton')!
    expect(project).toMatchObject({
      subscription: 'Claude',
      model: 'claude-sonnet-5-5',
      agent: { state: 'running', deviceId: 'dev-ubuntu' },
    })
    await openSettings(user)
    expect(screen.getByLabelText('Project assistant model')).toHaveValue('claude-sonnet-5-5')
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
    expect(await screen.findByText("Couldn't load project", { exact: true })).toBeInTheDocument()
    expect(screen.queryByLabelText('Message the project assistant')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry project' }))
    expect(await screen.findByRole('heading', { name: 'Compatibility' })).toBeInTheDocument()
    expect(screen.queryByText("Couldn't load project", { exact: true })).not.toBeInTheDocument()
    await waitFor(() => expect(memorySpy).toHaveBeenCalledWith('prj-compat'))
    await act(async () => {
      await Promise.allSettled(memorySpy.mock.results.map((result) => result.value))
    })
    expect(memorySpy).toHaveBeenCalledTimes(1)

    failing = false
    await user.click(screen.getByRole('tab', { name: /Memory/ }))
    const memory = await screen.findByRole('region', { name: 'Project memory' })
    expect(await within(memory).findByText("Couldn't load project memory")).toBeInTheDocument()
    expect(within(memory).queryByRole('article')).not.toBeInTheDocument()
    expect(memorySpy).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('region', { name: 'Conversation' })).toHaveTextContent(
      'Run the compat suite on Windows Desktop and report failures.',
    )

    await user.click(within(memory).getByRole('button', { name: 'Retry memory' }))
    expect(await within(memory).findByRole('button', { name: originalMemory })).toBeInTheDocument()
    expect(within(memory).queryByText("Couldn't load project memory")).not.toBeInTheDocument()
    expect(within(memory).queryByRole('button', { name: 'Retry memory' })).not.toBeInTheDocument()
    expect(memorySpy).toHaveBeenCalledTimes(2)
  })

  it('shows one actionable memory warning and clears it after sign-in without adding chat notices', async () => {
    const user = userEvent.setup()
    let attention: ('login_required' | 'credential_missing')[] = ['login_required']
    const { client } = setup(memoryPath, 'normal', (client) => {
      vi.spyOn(client, 'getMemoryStatus').mockImplementation(async () => ({
        pending_batches: 2,
        attention,
        jobs: [],
        has_more: false,
      }))
    })
    const memory = await screen.findByRole('region', { name: 'Project memory' })
    expect(await within(memory).findByText('Memory updates need sign-in')).toBeInTheDocument()
    expect(screen.getAllByText('Memory updates need sign-in')).toHaveLength(1)
    expect(screen.getByRole('region', { name: 'Conversation' })).not.toHaveTextContent('Memory updates need sign-in')
    expect((await client.listInbox()).some((item) => item.title.includes('Memory updates'))).toBe(false)
    attention = []
    await user.click(screen.getByRole('tab', { name: /Threads/ }))
    await user.click(screen.getByRole('tab', { name: /Memory/ }))
    await waitFor(() => expect(screen.queryByText('Memory updates need sign-in')).not.toBeInTheDocument())
    expect(within(memory).queryByText('Processing')).not.toBeInTheDocument()
  })

  it('offers settings for missing embedding credentials', async () => {
    const user = userEvent.setup()
    setup(memoryPath, 'normal', (client) => {
      vi.spyOn(client, 'getMemoryStatus').mockResolvedValue({
        pending_batches: 0,
        attention: ['credential_missing'],
        jobs: [],
        has_more: false,
      })
    })
    const memory = await screen.findByRole('region', { name: 'Project memory' })
    expect(await within(memory).findByText('Memory search needs device credentials')).toBeInTheDocument()
    await user.click(within(memory).getByRole('button', { name: 'Open settings' }))
    expect(await screen.findByRole('heading', { name: 'Project settings' })).toBeInTheDocument()
  })

  it('keeps routine waiting and transient memory failures out of the interface', async () => {
    setup(memoryPath, 'normal', (client) => {
      vi.spyOn(client, 'getMemoryStatus').mockResolvedValue({
        pending_batches: 3,
        attention: [],
        has_more: false,
        jobs: [
          {
            id: 'job',
            kind: 'consolidation',
            state: 'pending',
            input_seq: 1,
            through_seq: 2,
            cursor_index: 0,
            cursor_offset: 0,
            source_count: 2,
            node_id: null,
            node_name: null,
            waiting_reason: 'device_unavailable',
            last_error: 'model_request_failed',
            attempts: 1,
            updated_at: '2026-01-01T00:00:00Z',
          },
        ],
      })
    })
    expect(await screen.findByRole('button', { name: originalMemory })).toBeInTheDocument()
    expect(screen.queryByText('Memory updates need sign-in')).not.toBeInTheDocument()
    expect(screen.queryByText('device_unavailable')).not.toBeInTheDocument()
    expect(screen.queryByText('model_request_failed')).not.toBeInTheDocument()
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
    await user.click(within(memory).getByRole('button', { name: 'Release only after all supported OS tests pass.' }))
    const added = await screen.findByRole('dialog', { name: 'Edit memory' })
    await user.click(within(added).getByText('View source and history'))
    expect(within(added).getByText(/^v1 · You ·/)).toBeVisible()
    await user.click(within(added).getByRole('button', { name: 'Cancel' }))
    await user.click(within(memory).getByRole('button', { name: originalMemory }))
    const edit = await screen.findByRole('dialog', { name: 'Edit memory' })
    await replace(user, within(edit).getByLabelText('Memory'), 'The Windows suite lives in C:\\src\\compat-suite.')
    await user.click(within(edit).getByRole('button', { name: 'Save memory' }))
    await within(memory).findByRole('button', { name: 'The Windows suite lives in C:\\src\\compat-suite.' })
    await user.click(within(memory).getByRole('button', { name: 'The Windows suite lives in C:\\src\\compat-suite.' }))
    const version = await screen.findByRole('dialog', { name: 'Edit memory' })
    await user.click(within(version).getByText('View source and history'))
    expect(within(version).getByText(/^v2 · You ·/)).toBeVisible()
    expect(within(version).getByText(originalMemory)).toBeVisible()
    expect(within(version).getByText(/^v1 · Project assistant ·/)).toBeVisible()
  })

  it('opens sources on demand, retires an entry and explicitly restores it from No longer used', async () => {
    const user = userEvent.setup()
    let readSources!: ReturnType<typeof vi.fn>
    const { client } = setup(memoryPath, 'normal', (client) => {
      readSources = vi
        .spyOn(client, 'memorySources')
        .mockResolvedValue([
          { id: 'source', role: 'user', text: 'Keep Windows coverage.', source_seq: 12, suppressed: false },
        ])
    })
    await user.click(await screen.findByRole('button', { name: originalMemory }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit memory' })
    expect(readSources).not.toHaveBeenCalled()
    await user.click(within(dialog).getByText('View source and history'))
    expect(await within(dialog).findByText('Keep Windows coverage.')).toBeVisible()
    await user.click(within(dialog).getByRole('button', { name: 'Stop using' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect((await client.listProjectMemory('prj-compat')).find((n) => n.body === originalMemory)?.status).toBe(
      'retired',
    )
    await user.click(screen.getByText('No longer used'))
    await user.click(screen.getByRole('button', { name: originalMemory }))
    const retired = await screen.findByRole('dialog', { name: 'Edit memory' })
    await user.click(within(retired).getByRole('button', { name: 'Restore memory' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect((await client.listProjectMemory('prj-compat')).find((n) => n.body === originalMemory)?.status).toBe('active')
    expect(screen.queryByText('No longer used')).not.toBeInTheDocument()
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
    expect(await within(dialog).findByText('Not saved. Your draft is kept.')).toBeInTheDocument()
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
    expect(within(dialog).getByRole('status')).toHaveTextContent('Updated while you edited. Your draft is kept.')
    await user.click(within(dialog).getByRole('button', { name: 'Review latest' }))
    expect(within(dialog).getByLabelText('Memory')).toHaveValue('Run all Windows path regressions before release.')
    await user.click(within(dialog).getByRole('button', { name: 'Save memory' }))
    const note = (
      await screen.findByRole('button', { name: 'Run all Windows path regressions before release.' })
    ).closest('article')!
    await user.click(within(note).getByRole('button', { name: 'Run all Windows path regressions before release.' }))
    const history = await screen.findByRole('dialog', { name: 'Edit memory' })
    await user.click(within(history).getByText('View source and history'))
    expect(within(history).getByText(/^v3 · You ·/)).toBeVisible()
    expect(within(history).getByText('Run the Windows drive-letter tests before every release.')).toBeVisible()
    expect(within(history).getByText(originalMemory)).toBeVisible()
  })

  it('saves messages and Inbox answers while paused, lets threads run, and reads the backlog on resume', async () => {
    const user = userEvent.setup()
    const { client, scheduler, router } = setup(projectPath, 'inboxPaused')
    expect(await screen.findByText('Project paused')).toBeInTheDocument()
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
    await user.click(within(question).getByRole('radio', { name: /Other…/ }))
    await user.type(within(question).getByLabelText('Your reply'), 'Mention Windows support.')
    await user.click(within(question).getByRole('button', { name: 'Send reply' }))
    expect(
      await within(await screen.findByRole('region', { name: 'Latest result' })).findByText(
        'Reply saved · read after you resume',
      ),
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
    expect(screen.getByText('Project paused')).toBeInTheDocument()
    expect((await client.listProjects()).find((project) => project.id === 'prj-compat')?.agent.state).toBe('idle')
    await user.click(screen.getByRole('button', { name: 'Resume project' }))
    await waitFor(() => expect(screen.queryByText('Project paused')).not.toBeInTheDocument())
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
    const dialog = await screen.findByRole('dialog', { name: 'Archive project?' })
    expect(
      within(dialog).getByText(
        'Stops the project assistant and its running threads, and closes 2 open questions. Chat, memory, and thread history are kept.',
      ),
    ).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('heading', { name: 'Project settings' })).toBeInTheDocument()
    await back(user)
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
    const dialog = await screen.findByRole('dialog', { name: 'Archive project?' })
    await user.click(within(dialog).getByRole('button', { name: 'Archive project' }))
    const failed = await screen.findByRole('dialog', { name: 'Archive project?' })
    expect(await within(failed).findByRole('alert')).toHaveTextContent("Couldn't archive. Try again.")
    expect((await client.listProjects()).find((project) => project.id === 'prj-compat')?.status).toBe('active')
    await user.click(within(failed).getByRole('button', { name: 'Archive project' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByText('Read-only. Chat, memory, and thread history are kept.')).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveAttribute('readonly')
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument()
    await back(user)
    expect((await screen.findAllByText('Project archived')).length).toBeGreaterThan(0)
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

  it('opens archived projects from the account menu with read-only settings and memory', async () => {
    const user = userEvent.setup()
    const { router } = setup('/threads', 'archived')
    const sidebar = await screen.findByRole('navigation', { name: 'Workspace' })
    await user.click(within(sidebar).getByRole('button', { name: /Kaken He/ }))
    await user.click(await screen.findByRole('menuitem', { name: 'Archived projects' }))
    expect(await screen.findByRole('heading', { name: 'Archived projects' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/projects/archived')
    await user.click(screen.getByRole('link', { name: /Compatibility/ }))
    expect((await screen.findAllByText('Project archived')).length).toBeGreaterThan(0)
    await openSettings(user)
    for (const label of ['Name', 'Goal', 'Model source', 'Project assistant model']) {
      expect(screen.getByLabelText(label, { exact: false })).toHaveAttribute('readonly')
    }
    expect(screen.queryByRole('button', { name: /^(Pause|Resume|Archive|Save changes)$/ })).not.toBeInTheDocument()
    await back(user)
    await user.click(screen.getByRole('tab', { name: /Memory/ }))
    const memory = await screen.findByRole('region', { name: 'Project memory' })
    expect(within(memory).getByText(originalMemory)).toBeInTheDocument()
    expect(within(memory).queryByRole('button', { name: 'Add memory' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Message the project assistant')).not.toBeInTheDocument()
  })

  it('stops running threads on archive and reports them as stopping until the device confirms', async () => {
    const user = userEvent.setup()
    let release!: () => void
    const { client, scheduler } = setup('/projects/prj-baton?settings=true&archive=true', 'normal', (client) => {
      const setStatus = client.setProjectStatus.bind(client)
      vi.spyOn(client, 'setProjectStatus').mockImplementationOnce(async (input) => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return setStatus(input)
      })
    })
    const dialog = await screen.findByRole('dialog', { name: 'Archive project?' })
    await user.click(within(dialog).getByRole('button', { name: 'Archive project' }))
    const progress = await screen.findByRole('dialog', { name: 'Archiving project' })
    expect(within(progress).getByText('Saving archive status…')).toBeInTheDocument()
    expect(within(progress).getByText('Stop requests go to online devices.')).toBeInTheDocument()
    await act(async () => release())
    expect(await screen.findByText('Read-only. 1 thread still stopping.')).toBeInTheDocument()
    expect((await client.listThreads()).find((thread) => thread.id === 'thr-gateway')).toMatchObject({
      status: 'running',
      pending: 'stop',
    })
    await advance(scheduler, browserLatency.device)
    expect(await screen.findByText('Read-only. Chat, memory, and thread history are kept.')).toBeInTheDocument()
    expect((await client.listThreads()).find((thread) => thread.id === 'thr-gateway')).toMatchObject({
      status: 'stopped',
      pending: null,
    })
    expect((await client.listProjects()).find((project) => project.id === 'prj-baton')?.agent.state).toBe('stopped')
    expect((await client.listProjectEntries('prj-baton')).length).toBeGreaterThan(0)
  })

  it('keeps a thread stop pending while its device is offline after archive', async () => {
    const user = userEvent.setup()
    const { client, scheduler } = setup('/projects/prj-baton?settings=true&archive=true', 'normal', (client) => {
      client.controls.setDeviceConnection('dev-ubuntu', 'offline')
    })
    const dialog = await screen.findByRole('dialog', { name: 'Archive project?' })
    await user.click(within(dialog).getByRole('button', { name: 'Archive project' }))
    expect(await screen.findByText('Read-only. 1 thread will stop when Ubuntu Dev connects.')).toBeInTheDocument()
    await advance(scheduler, browserLatency.device * 2)
    expect(screen.getByText('Read-only. 1 thread will stop when Ubuntu Dev connects.')).toBeInTheDocument()
    expect((await client.listThreads()).find((thread) => thread.id === 'thr-gateway')).toMatchObject({
      status: 'running',
      pending: 'stop',
    })
    act(() => client.controls.setDeviceConnection('dev-ubuntu', 'online'))
    expect(await screen.findByText('Read-only. 1 thread still stopping.')).toBeInTheDocument()
    await advance(scheduler, browserLatency.device)
    expect(await screen.findByText('Read-only. Chat, memory, and thread history are kept.')).toBeInTheDocument()
  })
})
