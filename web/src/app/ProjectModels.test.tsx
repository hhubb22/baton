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
  await user.click(await screen.findByRole('button', { name: '新建项目' }))
  return screen.findByRole('dialog', { name: '新建项目' })
}

beforeEach(() => localStorage.clear())

describe('device project model catalogs', () => {
  it('merges reported models across devices, deduplicates them and creates with the chosen real model', async () => {
    const user = userEvent.setup()
    const { createProject, router } = setup('/inbox', reportedModels)
    const dialog = await newProject(user)
    const model = within(dialog).getByLabelText('模型')
    expect(model).toHaveValue('gpt-5.4')
    expect(
      within(model)
        .getAllByRole('option')
        .map((item) => item.textContent),
    ).toEqual(['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex'])
    expect(within(dialog).queryByText('gpt-6.1-sol')).not.toBeInTheDocument()
    expect(within(dialog).queryByText('Claude subscription')).not.toBeInTheDocument()
    await user.selectOptions(within(dialog).getByLabelText('模型来源'), '|xAI')
    expect(model).toHaveValue('grok-4')
    await user.selectOptions(model, 'grok-4-fast')
    await user.type(within(dialog).getByLabelText('名称'), 'Runtime catalog')
    await user.click(within(dialog).getByRole('button', { name: '创建项目' }))
    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Runtime catalog', subscription: 'xAI', model: 'grok-4-fast' }),
      ),
    )
    await waitFor(() => expect(router.state.location.pathname).toBe('/projects/prj-catalog'))
    expect(screen.queryByRole('dialog', { name: '新建项目' })).not.toBeInTheDocument()
  })

  it('includes the selected project emoji when creating a project', async () => {
    const user = userEvent.setup()
    const { createProject } = setup('/inbox', reportedModels)
    const dialog = await newProject(user)
    await user.type(within(dialog).getByLabelText('名称'), 'Emoji project')
    await user.click(within(dialog).getByRole('button', { name: '🚀' }))
    await user.click(within(dialog).getByRole('button', { name: '创建项目' }))
    await waitFor(() => expect(createProject).toHaveBeenCalledWith(expect.objectContaining({ emoji: '🚀' })))
  })

  it('offers device guidance and explicit manual entry when no device is registered', async () => {
    const user = userEvent.setup()
    const { createProject } = setup('/inbox', (devices) => devices.splice(0))
    const dialog = await newProject(user)
    expect(within(dialog).getByText(/设备上没有可用模型/)).toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: '连接设备' })).toHaveAttribute('href', '/devices?connect=true')
    expect(within(dialog).queryByLabelText('模型')).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('option')).not.toBeInTheDocument()
    await user.type(within(dialog).getByLabelText('名称'), 'Manual model')
    await user.click(within(dialog).getByRole('button', { name: '创建项目' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('请选择或手动输入服务商和模型')
    expect(createProject).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: '手动输入服务商和模型' }))
    await user.type(within(dialog).getByLabelText('模型来源'), 'openai-codex')
    await user.type(within(dialog).getByLabelText('模型'), 'gpt-5.4')
    await user.click(within(dialog).getByRole('button', { name: '重试' }))
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
    expect(within(dialog).getByText(/设备上没有可用模型/)).toBeInTheDocument()
    expect(within(dialog).queryByRole('option')).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: '手动输入服务商和模型' }))
    expect(within(dialog).getByLabelText('模型')).toHaveValue('')
    expect(within(dialog).getByLabelText('模型来源')).toHaveValue('')
  })

  it('allows reported models from signed-out devices and explains that messages will wait', async () => {
    const user = userEvent.setup()
    setup('/inbox', (devices) => {
      devices[0].hasRuntime = true
      devices[0].subscriptions = [{ provider: 'xAI', signedIn: false, models: ['grok-4'] }]
    })
    const dialog = await newProject(user)
    expect(within(dialog).getByLabelText('模型')).toHaveValue('grok-4')
    expect(within(dialog).getByText(/在线设备均未登录 xAI/)).toBeInTheDocument()
  })

  it('saves a changed project emoji from settings', async () => {
    const user = userEvent.setup()
    const { updateProject } = setup('/projects/prj-baton?settings=true')
    await screen.findByRole('heading', { name: '项目设置' })
    await user.click(screen.getByRole('button', { name: '🧪' }))
    await user.click(screen.getByRole('button', { name: '保存更改' }))
    await waitFor(() => expect(updateProject).toHaveBeenCalledWith({ projectId: 'prj-baton', patch: { emoji: '🧪' } }))
  })

  it('preserves an existing unreported model and lets settings switch to the reported catalog', async () => {
    const user = userEvent.setup()
    const { updateProject } = setup('/projects/prj-baton?settings=true', reportedModels)
    await screen.findByRole('heading', { name: '项目设置' })
    expect(screen.getByLabelText('项目助手模型')).toHaveValue('gpt-6.1-sol')
    expect(screen.getByLabelText('项目助手模型').tagName).toBe('INPUT')
    await user.click(screen.getByRole('button', { name: '从设备模型中选择' }))
    await user.selectOptions(screen.getByLabelText('模型来源'), '|xAI')
    await user.selectOptions(screen.getByLabelText('项目助手模型'), 'grok-4-fast')
    expect(updateProject).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '保存更改' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已保存'))
    expect(updateProject).toHaveBeenLastCalledWith({
      projectId: 'prj-baton',
      patch: { subscription: 'xAI', model: 'grok-4-fast' },
    })
    expect(screen.getByText('更改将在下次运行时生效。')).toBeInTheDocument()
  })

  it('keeps manual provider and model drafts together, rejects empty values and saves corrected values', async () => {
    const user = userEvent.setup()
    const { updateProject } = setup('/projects/prj-baton?settings=true')
    await screen.findByRole('heading', { name: '项目设置' })
    await user.clear(screen.getByLabelText('模型来源'))
    await user.clear(screen.getByLabelText('项目助手模型'))
    await user.click(screen.getByRole('button', { name: '返回项目' }))
    expect(await screen.findByLabelText('给项目助手发消息')).toBeInTheDocument()
    expect(updateProject).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '项目操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '设置' }))
    await screen.findByRole('heading', { name: '项目设置' })
    await user.click(screen.getByRole('button', { name: '手动输入服务商和模型' }))
    expect(screen.getByLabelText('模型来源')).toHaveValue('')
    expect(screen.getByLabelText('项目助手模型')).toHaveValue('')
    await user.click(screen.getByRole('button', { name: '保存更改' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('请输入服务商和模型。')
    expect(updateProject).not.toHaveBeenCalled()
    await user.type(screen.getByLabelText('模型来源'), 'openai-codex')
    await user.type(screen.getByLabelText('项目助手模型'), 'gpt-5.4')
    await user.click(screen.getByRole('button', { name: '保存更改' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已保存'))
    expect(updateProject).toHaveBeenLastCalledWith({
      projectId: 'prj-baton',
      patch: { subscription: 'openai-codex', model: 'gpt-5.4' },
    })
  })
})
