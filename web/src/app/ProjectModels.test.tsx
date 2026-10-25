import { createMemoryHistory } from '@tanstack/react-router'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import type { BatonClient } from '../data/client'
import { createMockClient } from '../data/mock/client'
import { createWorld } from '../data/mock/scenarios'
import type { Device, Project } from '../data/types'
import { App } from './App'
import { createAppRouter } from './router'

function setup(path = '/inbox', configure?: (devices: Device[]) => void) {
  const world = createWorld('normal', Date.now())
  for (const device of world.devices) device.subscriptions = []
  configure?.(world.devices)
  const projects = world.projects
  const createProject = vi.fn<BatonClient['createProject']>(async (input) => {
    const project: Project = {
      ...projects[0],
      ...input,
      id: 'prj-catalog',
      agent: { state: 'notStarted', deviceId: null, reason: null, activity: null },
    }
    projects.push(project)
    return structuredClone(project)
  })
  const updateProject = vi.fn<BatonClient['updateProject']>(async ({ projectId, patch }) => {
    const project = projects.find((item) => item.id === projectId)!
    Object.assign(project, patch)
    return structuredClone(project)
  })
  const client: BatonClient = {
    ...createMockClient('normal', { latency: { read: 0, save: 0, device: 0, run: 8000 } }),
    mode: 'http',
    listDevices: vi.fn(async () => structuredClone(world.devices)),
    listProjects: vi.fn(async () => structuredClone(projects)),
    listProjectEntries: vi.fn(async () => []),
    createProject,
    updateProject,
  }
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) })
  render(<App client={client} router={router} />)
  return { client, createProject, updateProject, router }
}

function reportedModels(devices: Device[]) {
  devices[0].hasRuntime = true
  devices[0].subscriptions = [{ provider: 'ChatGPT', signedIn: true, models: ['gpt-5.4', 'gpt-5.4-mini'] }]
  devices[1].hasRuntime = true
  devices[1].subscriptions = [
    { provider: 'ChatGPT', signedIn: true, models: ['gpt-5.4', 'gpt-5.3-codex'] },
    { provider: 'xAI', signedIn: true, models: ['grok-4', 'grok-4-fast'] },
  ]
}

async function newProject(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'New project' }))
  return screen.findByRole('dialog', { name: 'New project' })
}

beforeEach(() => localStorage.clear())

describe('device project model catalogs', () => {
  it('merges reported models across devices, deduplicates them and creates with the chosen real model', async () => {
    const user = userEvent.setup()
    const { createProject, router } = setup('/inbox', reportedModels)
    const dialog = await newProject(user)
    const model = within(dialog).getByLabelText('Model')
    expect(model).toHaveValue('gpt-5.4')
    expect(
      within(model)
        .getAllByRole('option')
        .map((item) => item.textContent),
    ).toEqual(['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex'])
    expect(within(dialog).queryByText('gpt-6.1-sol')).not.toBeInTheDocument()
    expect(within(dialog).queryByText('Claude subscription')).not.toBeInTheDocument()
    await user.selectOptions(within(dialog).getByLabelText('Assistant subscription'), 'xAI')
    expect(model).toHaveValue('grok-4')
    await user.selectOptions(model, 'grok-4-fast')
    await user.type(within(dialog).getByLabelText('Name'), 'Runtime catalog')
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }))
    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Runtime catalog', subscription: 'xAI', model: 'grok-4-fast' }),
      ),
    )
    await waitFor(() => expect(router.state.location.pathname).toBe('/projects/prj-catalog'))
    expect(screen.queryByRole('dialog', { name: 'New project' })).not.toBeInTheDocument()
  })

  it('offers device guidance and explicit manual entry when no device is registered', async () => {
    const user = userEvent.setup()
    const { createProject } = setup('/inbox', (devices) => devices.splice(0))
    const dialog = await newProject(user)
    expect(within(dialog).getByText(/No models available from your devices/)).toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: 'Connect a device' })).toHaveAttribute(
      'href',
      '/devices?connect=true',
    )
    expect(within(dialog).queryByLabelText('Model')).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('option')).not.toBeInTheDocument()
    await user.type(within(dialog).getByLabelText('Name'), 'Manual model')
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Choose a provider and model')
    expect(createProject).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Enter provider and model manually' }))
    await user.type(within(dialog).getByLabelText('Assistant subscription'), 'openai-codex')
    await user.type(within(dialog).getByLabelText('Model'), 'gpt-5.4')
    await user.click(within(dialog).getByRole('button', { name: 'Try again' }))
    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith(
        expect.objectContaining({ subscription: 'openai-codex', model: 'gpt-5.4' }),
      ),
    )
  })

  it('shows empty catalogs without mock models when a device has not reported any', async () => {
    const user = userEvent.setup()
    setup('/inbox', (devices) => {
      devices[0].hasRuntime = true
      devices[0].subscriptions = [{ provider: 'ChatGPT', signedIn: true }]
    })
    const dialog = await newProject(user)
    expect(within(dialog).getByText(/No models available from your devices/)).toBeInTheDocument()
    expect(within(dialog).queryByRole('option')).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Enter provider and model manually' }))
    expect(within(dialog).getByLabelText('Model')).toHaveValue('')
    expect(within(dialog).getByLabelText('Assistant subscription')).toHaveValue('')
  })

  it('allows reported models from signed-out devices and explains that messages will wait', async () => {
    const user = userEvent.setup()
    setup('/inbox', (devices) => {
      devices[0].hasRuntime = true
      devices[0].subscriptions = [{ provider: 'xAI', signedIn: false, models: ['grok-4'] }]
    })
    const dialog = await newProject(user)
    expect(within(dialog).getByLabelText('Model')).toHaveValue('grok-4')
    expect(within(dialog).getByText(/No online device has xAI signed in/)).toBeInTheDocument()
  })

  it('preserves an existing unreported model and lets settings switch to the reported catalog', async () => {
    const user = userEvent.setup()
    const { updateProject } = setup('/projects/prj-baton?settings=true', reportedModels)
    const dialog = await screen.findByRole('dialog', { name: 'Baton Dev · settings' })
    expect(within(dialog).getByLabelText('Project assistant model')).toHaveValue('gpt-6.1-sol')
    expect(within(dialog).getByLabelText('Project assistant model').tagName).toBe('INPUT')
    expect(updateProject).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Choose from device models' }))
    await user.selectOptions(within(dialog).getByLabelText('Subscription'), 'xAI')
    await user.selectOptions(within(dialog).getByLabelText('Project assistant model'), 'grok-4-fast')
    await waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent('Saved'))
    expect(updateProject).toHaveBeenLastCalledWith({
      projectId: 'prj-baton',
      patch: { subscription: 'xAI', model: 'grok-4-fast' },
    })
    expect(within(dialog).getByText('Applies to the next run. The current run keeps its model.')).toBeInTheDocument()
  })

  it('keeps manual provider and model drafts together, rejects empty values and saves corrected values', async () => {
    const user = userEvent.setup()
    const { updateProject } = setup('/projects/prj-baton?settings=true')
    const dialog = await screen.findByRole('dialog', { name: 'Baton Dev · settings' })
    await user.clear(within(dialog).getByLabelText('Subscription'))
    await user.clear(within(dialog).getByLabelText('Project assistant model'))
    expect(updateProject).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(updateProject).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Project actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Settings' }))
    const reopened = await screen.findByRole('dialog', { name: 'Baton Dev · settings' })
    await user.click(within(reopened).getByRole('button', { name: 'Enter provider and model manually' }))
    expect(within(reopened).getByLabelText('Subscription')).toHaveValue('')
    expect(within(reopened).getByLabelText('Project assistant model')).toHaveValue('')
    await user.type(within(reopened).getByLabelText('Subscription'), 'openai-codex')
    await user.type(within(reopened).getByLabelText('Project assistant model'), 'gpt-5.4')
    await user.click(within(reopened).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(updateProject).toHaveBeenLastCalledWith({
      projectId: 'prj-baton',
      patch: { subscription: 'openai-codex', model: 'gpt-5.4' },
    })
  })
})
