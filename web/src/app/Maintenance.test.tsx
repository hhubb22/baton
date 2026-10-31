import { createMemoryHistory } from '@tanstack/react-router'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  await user.click(await screen.findByRole('button', { name: '项目操作' }))
  await user.click(await screen.findByRole('menuitem', { name: '设置' }))
  await screen.findByRole('heading', { name: '项目设置' })
}

async function save(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '保存更改' }))
}

function settingsStatus() {
  return screen.getByRole('status')
}

async function back(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '返回项目' }))
  await waitFor(() => expect(screen.queryByRole('heading', { name: '项目设置' })).not.toBeInTheDocument())
}

beforeEach(() => localStorage.clear())

describe('project maintenance', () => {
  it('shows unread projects as dots', async () => {
    setup('/threads')
    const nav = await screen.findByRole('navigation', { name: '工作区' })
    const link = await within(nav).findByRole('link', { name: /Compatibility/ })
    expect(within(link).getByRole('img', { name: '未读' })).toBeInTheDocument()
    expect(screen.queryByText('等你回复')).not.toBeInTheDocument()
  })

  it('marks the saved latest reply read only when visible at the bottom', async () => {
    let mark!: ReturnType<typeof vi.spyOn>
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const { client } = setup(projectPath, 'normal', (value) => {
      mark = vi.spyOn(value, 'markProjectRead')
    })
    await screen.findByText(/The suite finished with 2 failures/)
    const timeline = screen.getByRole('region', { name: '对话' })
    const reply = timeline.querySelector('[data-entry-id="ent-compat-3"]')!
    Object.defineProperties(timeline, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    })
    vi.spyOn(timeline, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 500 } as DOMRect)
    vi.spyOn(reply, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 200 } as DOMRect)
    fireEvent.scroll(timeline)
    expect(mark).not.toHaveBeenCalled()
    visibility.mockReturnValue('visible')
    fireEvent(document, new Event('visibilitychange'))
    expect(mark).not.toHaveBeenCalled()
    timeline.scrollTop = 500
    fireEvent.scroll(timeline)
    await waitFor(() => expect(mark).toHaveBeenCalledWith('prj-compat', 3))
    await waitFor(async () => expect((await client.getProject('prj-compat')).readReplySeq).toBe(3))
    visibility.mockRestore()
  })

  it('shows the failure reason and retries the project', async () => {
    const user = userEvent.setup()
    const { client } = setup('/projects/prj-docs')
    const retry = vi.spyOn(client, 'retryProject')
    expect(await screen.findByText('Claude 登录已过期')).toBeVisible()
    await user.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(retry).toHaveBeenCalledWith('prj-docs'))
  })
  it('saves name and goal only when Save changes is clicked', async () => {
    const user = userEvent.setup()
    const { router, client } = setup()
    const update = vi.spyOn(client, 'updateProject')
    await openSettings(user)
    expect(router.state.location.search).toMatchObject({ settings: true })
    await replace(user, screen.getByLabelText('名称'), 'Release compatibility')
    await user.click(screen.getByLabelText(/^目标/))
    await replace(user, screen.getByLabelText(/^目标/), 'Verify Windows and Linux before release.')
    await user.click(screen.getByLabelText('名称'))
    expect(settingsStatus()).toHaveTextContent('更改尚未保存')
    expect(update).not.toHaveBeenCalled()
    await save(user)
    await waitFor(() => expect(settingsStatus()).toHaveTextContent('已保存'))
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({
      projectId: 'prj-compat',
      patch: { name: 'Release compatibility', goal: 'Verify Windows and Linux before release.' },
    })
    await back(user)
    expect(await screen.findByRole('heading', { name: 'Release compatibility' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '显示概览' }))
    expect(
      within(screen.getByRole('navigation', { name: '工作区' })).getByRole('link', {
        name: /Release compatibility/,
      }),
    ).toBeInTheDocument()
    expect(
      within(screen.getByRole('complementary', { name: '概览' })).getByText('Verify Windows and Linux before release.'),
    ).toBeInTheDocument()
    expect(router.state.location.search.settings).toBeUndefined()
    await openSettings(user)
    expect(screen.getByLabelText('名称')).toHaveValue('Release compatibility')
    expect(screen.getByLabelText(/^目标/)).toHaveValue('Verify Windows and Linux before release.')
  })

  it('saves optional memory embeddings, retains a failed draft and turns them off', async () => {
    const user = userEvent.setup()
    const { client } = setup(settingsPath, 'normal', (client) => {
      vi.spyOn(client, 'updateProject').mockRejectedValueOnce(new ClientError('unavailable', 'Disconnected'))
    })
    const update = vi.spyOn(client, 'updateProject')
    await screen.findByRole('heading', { name: '项目设置' })
    expect(screen.getByRole('switch', { name: '记忆嵌入' })).not.toBeChecked()
    await user.click(screen.getByRole('switch', { name: '记忆嵌入' }))
    await replace(user, screen.getByLabelText('嵌入模型基础 URL'), 'http://localhost:11434/v1')
    await replace(user, screen.getByLabelText(/^设备凭据名称/), 'local-embeddings')
    await replace(user, screen.getByLabelText('嵌入模型'), 'local-embed')
    await user.click(screen.getByLabelText('名称'))
    expect(update).not.toHaveBeenCalled()
    await save(user)
    expect(await screen.findByText('无法保存，请重试。')).toBeInTheDocument()
    expect(screen.getByLabelText('嵌入模型')).toHaveValue('local-embed')
    await user.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(settingsStatus()).toHaveTextContent('已保存'))
    expect((await client.listProjects()).find((project) => project.id === 'prj-compat')?.memoryEmbedding).toEqual({
      base_url: 'http://localhost:11434/v1',
      model: 'local-embed',
      credential_profile: 'local-embeddings',
      config_id: expect.any(String),
    })
    await replace(user, screen.getByLabelText('嵌入模型'), 'another-embed')
    await save(user)
    await waitFor(() => expect(settingsStatus()).toHaveTextContent('已保存'))
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
    await user.click(screen.getByRole('switch', { name: '记忆嵌入' }))
    expect(settingsStatus()).toHaveTextContent('更改尚未保存')
    await save(user)
    await waitFor(() => expect(settingsStatus()).toHaveTextContent('已保存'))
    expect(update).toHaveBeenLastCalledWith({ projectId: 'prj-compat', patch: { memoryEmbedding: null } })
    expect(screen.queryByLabelText('嵌入模型')).not.toBeInTheDocument()
    expect((await client.listProjects()).find((project) => project.id === 'prj-compat')?.memoryEmbedding).toBeNull()
  })

  it('keeps an invalid name draft, pauses the saved project and lets the draft be discarded', async () => {
    const user = userEvent.setup()
    const { client } = setup(settingsPath)
    const update = vi.spyOn(client, 'updateProject')
    await screen.findByRole('heading', { name: '项目设置' })
    await replace(user, screen.getByLabelText('名称'), '   ')
    await save(user)
    expect(await screen.findByText('请输入项目名称。', { selector: 'p' })).toBeInTheDocument()
    expect(screen.getByLabelText('名称')).toHaveAttribute('aria-invalid', 'true')
    expect(settingsStatus()).toHaveTextContent('更改尚未保存')
    await user.click(screen.getByRole('button', { name: '暂停' }))
    expect(await screen.findByRole('button', { name: '恢复' })).toBeInTheDocument()
    expect(screen.getByLabelText('名称')).toHaveValue('   ')
    expect(update).not.toHaveBeenCalled()
    expect((await client.listProjects()).find((project) => project.id === 'prj-compat')?.status).toBe('paused')
    await back(user)
    await openSettings(user)
    expect(screen.getByLabelText('名称')).toHaveValue('   ')
    await user.click(screen.getByRole('button', { name: '放弃更改' }))
    expect(screen.getByLabelText('名称')).toHaveValue('Compatibility')
    expect(settingsStatus()).toHaveTextContent('')
    expect(update).not.toHaveBeenCalled()
  })

  it('keeps failed settings when leaving and saves the same edits after returning', async () => {
    const user = userEvent.setup()
    const { router } = setup(settingsPath, 'normal', (client) => {
      vi.spyOn(client, 'updateProject').mockRejectedValueOnce(new ClientError('unavailable', 'Disconnected'))
    })
    await screen.findByRole('heading', { name: '项目设置' })
    await replace(user, screen.getByLabelText(/^目标/), 'Keep this goal after failure.')
    await save(user)
    expect(await screen.findByText('无法保存，请重试。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
    expect(screen.getByLabelText(/^目标/)).toHaveValue('Keep this goal after failure.')
    await back(user)
    await act(() =>
      router.navigate({ to: '/projects/$projectId', params: { projectId: 'prj-compat' }, search: { settings: true } }),
    )
    await screen.findByRole('heading', { name: '项目设置' })
    expect(screen.getByLabelText(/^目标/)).toHaveValue('Keep this goal after failure.')
    expect(settingsStatus()).toHaveTextContent('更改尚未保存')
    await save(user)
    await waitFor(() => expect(settingsStatus()).toHaveTextContent('已保存'))
    await back(user)
    await user.click(screen.getByRole('button', { name: '显示概览' }))
    expect(
      await within(screen.getByRole('complementary', { name: '概览' })).findByText('Keep this goal after failure.'),
    ).toBeInTheDocument()
  })

  it('asks the browser to confirm before unloading unsaved settings', async () => {
    const user = userEvent.setup()
    setup(settingsPath)
    await screen.findByRole('heading', { name: '项目设置' })
    const unload = () => {
      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    }
    expect(unload()).toBe(false)
    await replace(user, screen.getByLabelText('名称'), 'Unsaved name')
    expect(unload()).toBe(true)
    await save(user)
    await waitFor(() => expect(settingsStatus()).toHaveTextContent('已保存'))
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
    await screen.findByRole('heading', { name: '项目设置' })
    await replace(user, screen.getByLabelText('名称'), 'First name')
    await save(user)
    expect(settingsStatus()).toHaveTextContent('Saving…')
    await replace(user, screen.getByLabelText('名称'), 'Latest name')
    await replace(user, screen.getByLabelText(/^目标/), 'The latest goal must survive.')
    await advance(scheduler, browserLatency.save)
    await waitFor(() => expect(settingsStatus()).toHaveTextContent('更改尚未保存'))
    expect(screen.getByLabelText('名称')).toHaveValue('Latest name')
    expect(screen.getByLabelText(/^目标/)).toHaveValue('The latest goal must survive.')
    expect(updateSpy.mock.calls.map(([input]) => input.patch)).toEqual([{ name: 'First name' }])
    await save(user)
    await advance(scheduler, browserLatency.save)
    await waitFor(() => expect(settingsStatus()).toHaveTextContent('已保存'))
    await back(user)
    expect(await screen.findByRole('heading', { name: 'Latest name' })).toBeInTheDocument()

    await openSettings(user)
    await replace(user, screen.getByLabelText('名称'), 'Unsaved before navigating back')
    await act(async () => router.history.back())
    await waitFor(() => expect(screen.queryByRole('heading', { name: '项目设置' })).not.toBeInTheDocument())
    await openSettings(user)
    expect(screen.getByLabelText('名称')).toHaveValue('Unsaved before navigating back')
    expect(settingsStatus()).toHaveTextContent('更改尚未保存')
    expect(updateSpy).toHaveBeenCalledTimes(2)
    expect((await client.listProjects()).find((project) => project.id === 'prj-compat')?.name).toBe('Latest name')
  })

  it('keeps new memory drafts in their own project across browser history', async () => {
    const user = userEvent.setup()
    const { client, router } = setup('/projects/prj-baton?view=memory')
    await screen.findByRole('button', { name: '添加记忆' })
    await act(() =>
      router.navigate({ to: '/projects/$projectId', params: { projectId: 'prj-compat' }, search: { view: 'memory' } }),
    )
    await user.click(await screen.findByRole('button', { name: '添加记忆' }))
    const dialog = await screen.findByRole('dialog', { name: '添加记忆' })
    await user.type(within(dialog).getByLabelText('记忆'), 'Only the Compatibility project should get this memory.')
    await act(async () => router.history.back())
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await user.click(await screen.findByRole('button', { name: '添加记忆' }))
    const other = await screen.findByRole('dialog', { name: '添加记忆' })
    expect(within(other).getByLabelText('记忆')).toHaveValue('')
    await user.click(within(other).getByRole('button', { name: '取消' }))
    await act(async () => router.history.forward())
    await user.click(await screen.findByRole('button', { name: '添加记忆' }))
    const restored = await screen.findByRole('dialog', { name: '添加记忆' })
    expect(within(restored).getByLabelText('记忆')).toHaveValue(
      'Only the Compatibility project should get this memory.',
    )
    await user.click(within(restored).getByRole('button', { name: '保存记忆' }))
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
    await screen.findByRole('heading', { name: '项目设置' })
    expect(screen.getByText('更改将在下次运行时生效。')).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('模型来源'), '|Claude')
    expect(screen.getByLabelText('项目助手模型')).toHaveValue('claude-opus-5-5')
    await user.selectOptions(screen.getByLabelText('项目助手模型'), 'claude-sonnet-5-5')
    await save(user)
    await waitFor(() => expect(settingsStatus()).toHaveTextContent('已保存'))
    await back(user)
    expect(await screen.findByRole('button', { name: '停止运行' })).toBeInTheDocument()
    const project = (await client.listProjects()).find((item) => item.id === 'prj-baton')!
    expect(project).toMatchObject({
      subscription: 'Claude',
      model: 'claude-sonnet-5-5',
      agent: { state: 'running', deviceId: 'dev-ubuntu' },
    })
    await openSettings(user)
    expect(screen.getByLabelText('项目助手模型')).toHaveValue('claude-sonnet-5-5')
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
    expect((await screen.findAllByText('无法加载项目', { exact: true })).length).toBeGreaterThan(0)
    expect(screen.queryByLabelText('给项目助手发消息')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重试项目' }))
    expect(await screen.findByRole('heading', { name: 'Compatibility' })).toBeInTheDocument()
    expect(screen.queryAllByText('无法加载项目', { exact: true })).toHaveLength(0)
    await waitFor(() => expect(memorySpy).toHaveBeenCalledWith('prj-compat'))
    await act(async () => {
      await Promise.allSettled(memorySpy.mock.results.map((result) => result.value))
    })
    expect(memorySpy).toHaveBeenCalledTimes(1)

    failing = false
    await user.click(screen.getByRole('button', { name: '显示概览' }))
    await user.click(screen.getByRole('tab', { name: /记忆/ }))
    const memory = await screen.findByRole('region', { name: '项目记忆' })
    expect(await within(memory).findByText('无法加载项目记忆')).toBeInTheDocument()
    expect(within(memory).queryByRole('article')).not.toBeInTheDocument()
    expect(memorySpy).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('region', { name: '对话' })).toHaveTextContent(
      'Run the compat suite on Windows Desktop and report failures.',
    )

    await user.click(within(memory).getByRole('button', { name: '重试加载记忆' }))
    expect(await within(memory).findByRole('button', { name: originalMemory })).toBeInTheDocument()
    expect(within(memory).queryByText('无法加载项目记忆')).not.toBeInTheDocument()
    expect(within(memory).queryByRole('button', { name: '重试加载记忆' })).not.toBeInTheDocument()
    expect(memorySpy).toHaveBeenCalledTimes(2)
  })

  it('shows one actionable memory warning and clears it after sign-in without adding chat notices', async () => {
    const user = userEvent.setup()
    let attention: ('login_required' | 'credential_missing')[] = ['login_required']
    setup(memoryPath, 'normal', (client) => {
      vi.spyOn(client, 'getMemoryStatus').mockImplementation(async () => ({
        pending_batches: 2,
        attention,
        jobs: [],
        has_more: false,
      }))
    })
    const memory = await screen.findByRole('region', { name: '项目记忆' })
    expect(await within(memory).findByText('更新记忆需要登录')).toBeInTheDocument()
    expect(screen.getAllByText('更新记忆需要登录')).toHaveLength(1)
    expect(screen.getByRole('region', { name: '对话' })).not.toHaveTextContent('Memory updates need sign-in')
    attention = []
    await user.click(screen.getByRole('tab', { name: /对话/ }))
    await user.click(screen.getByRole('tab', { name: /记忆/ }))
    await waitFor(() => expect(screen.queryByText('更新记忆需要登录')).not.toBeInTheDocument())
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
    const memory = await screen.findByRole('region', { name: '项目记忆' })
    expect(await within(memory).findByText('搜索记忆需要设备凭据')).toBeInTheDocument()
    await user.click(within(memory).getByRole('button', { name: '打开设置' }))
    expect(await screen.findByRole('heading', { name: '项目设置' })).toBeInTheDocument()
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
    expect(screen.queryByText('更新记忆需要登录')).not.toBeInTheDocument()
    expect(screen.queryByText('device_unavailable')).not.toBeInTheDocument()
    expect(screen.queryByText('model_request_failed')).not.toBeInTheDocument()
  })

  it('adds memory and records the author and previous version when editing assistant memory', async () => {
    const user = userEvent.setup()
    const { router } = setup()
    await user.click(await screen.findByRole('button', { name: '项目操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '记忆' }))
    expect(router.state.location.search).toMatchObject({ view: 'memory' })
    const memory = await screen.findByRole('region', { name: '项目记忆' })
    await user.click(within(memory).getByRole('button', { name: '添加记忆' }))
    const add = await screen.findByRole('dialog', { name: '添加记忆' })
    await user.type(within(add).getByLabelText('记忆'), 'Release only after all supported OS tests pass.')
    await user.click(within(add).getByRole('button', { name: '保存记忆' }))
    expect(
      await within(memory).findByRole('button', { name: 'Release only after all supported OS tests pass.' }),
    ).toBeInTheDocument()
    await user.click(within(memory).getByRole('button', { name: 'Release only after all supported OS tests pass.' }))
    const added = await screen.findByRole('dialog', { name: '编辑记忆' })
    await user.click(within(added).getByText('查看来源和历史'))
    expect(within(added).getByText(/^v1 · 你 ·/)).toBeVisible()
    await user.click(within(added).getByRole('button', { name: '取消' }))
    await user.click(within(memory).getByRole('button', { name: originalMemory }))
    const edit = await screen.findByRole('dialog', { name: '编辑记忆' })
    await replace(user, within(edit).getByLabelText('记忆'), 'The Windows suite lives in C:\\src\\compat-suite.')
    await user.click(within(edit).getByRole('button', { name: '保存记忆' }))
    await within(memory).findByRole('button', { name: 'The Windows suite lives in C:\\src\\compat-suite.' })
    await user.click(within(memory).getByRole('button', { name: 'The Windows suite lives in C:\\src\\compat-suite.' }))
    const version = await screen.findByRole('dialog', { name: '编辑记忆' })
    await user.click(within(version).getByText('查看来源和历史'))
    expect(within(version).getByText(/^v2 · 你 ·/)).toBeVisible()
    expect(within(version).getByText(originalMemory)).toBeVisible()
    expect(within(version).getByText(/^v1 · 项目助手 ·/)).toBeVisible()
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
    const dialog = await screen.findByRole('dialog', { name: '编辑记忆' })
    expect(readSources).not.toHaveBeenCalled()
    await user.click(within(dialog).getByText('查看来源和历史'))
    expect(await within(dialog).findByText('Keep Windows coverage.')).toBeVisible()
    await user.click(within(dialog).getByRole('button', { name: '停用' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect((await client.listProjectMemory('prj-compat')).find((n) => n.body === originalMemory)?.status).toBe(
      'retired',
    )
    await user.click(screen.getByText('已停用'))
    await user.click(screen.getByRole('button', { name: originalMemory }))
    const retired = await screen.findByRole('dialog', { name: '编辑记忆' })
    await user.click(within(retired).getByRole('button', { name: '恢复记忆' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect((await client.listProjectMemory('prj-compat')).find((n) => n.body === originalMemory)?.status).toBe('active')
    expect(screen.queryByText('已停用')).not.toBeInTheDocument()
  })

  it('keeps a memory draft after validation and save failure, then retries without duplication', async () => {
    const user = userEvent.setup()
    const { client } = setup(memoryPath, 'normal', (client) => {
      vi.spyOn(client, 'saveMemory').mockRejectedValueOnce(new ClientError('unavailable', 'Disconnected'))
    })
    await user.click(await screen.findByRole('button', { name: '添加记忆' }))
    const dialog = await screen.findByRole('dialog', { name: '添加记忆' })
    await user.click(within(dialog).getByRole('button', { name: '保存记忆' }))
    expect(await within(dialog).findByText('请输入记忆内容。')).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText('记忆'), 'Never skip Windows regressions.')
    await user.click(within(dialog).getByRole('button', { name: '保存记忆' }))
    expect(await within(dialog).findByText('保存失败，草稿已保留。')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('记忆')).toHaveValue('Never skip Windows regressions.')
    await user.click(within(dialog).getByRole('button', { name: '保存记忆' }))
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
    const dialog = await screen.findByRole('dialog', { name: '编辑记忆' })
    await replace(user, within(dialog).getByLabelText('记忆'), 'Run all Windows path regressions before release.')
    await user.click(within(dialog).getByRole('button', { name: '保存记忆' }))
    expect(
      await within(dialog).findByText('Run the Windows drive-letter tests before every release.'),
    ).toBeInTheDocument()
    expect(within(dialog).getByText(/最新 · v2 · 项目助手/)).toBeInTheDocument()
    expect(within(dialog).getByLabelText('记忆')).toHaveValue('Run all Windows path regressions before release.')
    expect(within(dialog).queryByRole('button', { name: '保存记忆' })).not.toBeInTheDocument()
    expect(within(dialog).getByRole('status')).toHaveTextContent('编辑期间内容已更新，草稿已保留。')
    await user.click(within(dialog).getByRole('button', { name: '查看最新版本' }))
    expect(within(dialog).getByLabelText('记忆')).toHaveValue('Run all Windows path regressions before release.')
    await user.click(within(dialog).getByRole('button', { name: '保存记忆' }))
    const note = (
      await screen.findByRole('button', { name: 'Run all Windows path regressions before release.' })
    ).closest('article')!
    await user.click(within(note).getByRole('button', { name: 'Run all Windows path regressions before release.' }))
    const history = await screen.findByRole('dialog', { name: '编辑记忆' })
    await user.click(within(history).getByText('查看来源和历史'))
    expect(within(history).getByText(/^v3 · 你 ·/)).toBeVisible()
    expect(within(history).getByText('Run the Windows drive-letter tests before every release.')).toBeVisible()
    expect(within(history).getByText(originalMemory)).toBeVisible()
  })

  it('explains archiving and lets cancellation return to the unchanged project', async () => {
    const user = userEvent.setup()
    const { client, router } = setup()
    await user.click(await screen.findByRole('button', { name: '项目操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '归档项目' }))
    expect(router.state.location.search).toMatchObject({ settings: true, archive: true })
    const dialog = await screen.findByRole('dialog', { name: '归档项目？' })
    expect(within(dialog).getByText('停止项目助手和运行中的对话。聊天、记忆和对话记录会保留。')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('heading', { name: '项目设置' })).toBeInTheDocument()
    await back(user)
    expect(screen.getByLabelText('给项目助手发消息')).toBeInTheDocument()
    expect((await client.listProjects()).find((project) => project.id === 'prj-compat')?.status).toBe('active')
  })

  it('retries a failed archive, hides the project composer and keeps conversation, memory and threads', async () => {
    const user = userEvent.setup()
    const { scheduler, router, client } = setup(`${settingsPath}&archive=true`, 'normal', (client) => {
      vi.spyOn(client, 'setProjectStatus').mockRejectedValueOnce(new ClientError('unavailable', 'Disconnected'))
    })
    const dialog = await screen.findByRole('dialog', { name: '归档项目？' })
    await user.click(within(dialog).getByRole('button', { name: '归档项目' }))
    const failed = await screen.findByRole('dialog', { name: '归档项目？' })
    expect(await within(failed).findByRole('alert')).toHaveTextContent('无法归档，请重试。')
    expect((await client.listProjects()).find((project) => project.id === 'prj-compat')?.status).toBe('active')
    await user.click(within(failed).getByRole('button', { name: '归档项目' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByText('只读。聊天、记忆和对话记录已保留。')).toBeInTheDocument()
    expect(screen.getByLabelText('名称')).toHaveAttribute('readonly')
    expect(screen.queryByRole('button', { name: '保存更改' })).not.toBeInTheDocument()
    await back(user)
    expect((await screen.findAllByText('项目已归档')).length).toBeGreaterThan(0)
    expect(screen.queryByLabelText('给项目助手发消息')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: '对话' })).toHaveTextContent(
      'Run the compat suite on Windows Desktop and report failures.',
    )
    expect(
      within(screen.getByRole('navigation', { name: '工作区' })).queryByRole('link', { name: /Compatibility/ }),
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '显示概览' }))
    await user.click(screen.getByRole('tab', { name: /记忆/ }))
    const memory = await screen.findByRole('region', { name: '项目记忆' })
    expect(within(memory).getByText(originalMemory)).toBeInTheDocument()
    await act(() =>
      router.navigate({
        to: '/projects/$projectId',
        params: { projectId: 'prj-compat' },
        search: { thread: 'thr-compat' },
      }),
    )
    await screen.findByRole('region', { name: '消息记录' })
    const thread = screen.getByRole('complementary', { name: 'Run compat suite on Windows' })
    act(() => client.controls.setDeviceConnection('dev-windows', 'online'))
    await user.type(await within(thread).findByLabelText('消息'), 'Continue after project archive.{Enter}')
    await advance(scheduler, browserLatency.save + browserLatency.run)
    await waitFor(() => expect(thread).toHaveTextContent('Done. The change is ready for review.'))
    expect(screen.queryByLabelText('给项目助手发消息')).not.toBeInTheDocument()
  })

  it('opens archived projects from the account menu with read-only settings and memory', async () => {
    const user = userEvent.setup()
    const { router } = setup('/threads', 'archived')
    const sidebar = await screen.findByRole('navigation', { name: '工作区' })
    await user.click(within(sidebar).getByRole('button', { name: /Kaken He/ }))
    await user.click(await screen.findByRole('menuitem', { name: '已归档项目' }))
    expect(await screen.findByRole('heading', { name: '已归档项目' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/projects/archived')
    await user.click(screen.getByRole('link', { name: /Compatibility/ }))
    expect((await screen.findAllByText('项目已归档')).length).toBeGreaterThan(0)
    await openSettings(user)
    for (const label of ['名称', '目标', '模型来源', '项目助手模型']) {
      expect(screen.getByLabelText(label, { exact: false })).toHaveAttribute('readonly')
    }
    expect(screen.queryByRole('button', { name: /^(Pause|Resume|Archive|Save changes)$/ })).not.toBeInTheDocument()
    await back(user)
    await user.click(screen.getByRole('button', { name: '显示概览' }))
    await user.click(screen.getByRole('tab', { name: /记忆/ }))
    const memory = await screen.findByRole('region', { name: '项目记忆' })
    expect(within(memory).getByText(originalMemory)).toBeInTheDocument()
    expect(within(memory).queryByRole('button', { name: '添加记忆' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('给项目助手发消息')).not.toBeInTheDocument()
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
    const dialog = await screen.findByRole('dialog', { name: '归档项目？' })
    await user.click(within(dialog).getByRole('button', { name: '归档项目' }))
    const progress = await screen.findByRole('dialog', { name: '正在归档项目' })
    expect(within(progress).getByText('正在保存归档状态…')).toBeInTheDocument()
    expect(within(progress).getByText('停止请求会发送到在线设备。')).toBeInTheDocument()
    await act(async () => release())
    expect(await screen.findByText('只读。1 个对话正在停止。')).toBeInTheDocument()
    expect((await client.listThreads()).find((thread) => thread.id === 'thr-gateway')).toMatchObject({
      status: 'running',
      pending: 'stop',
    })
    await advance(scheduler, browserLatency.device)
    expect(await screen.findByText('只读。聊天、记忆和对话记录已保留。')).toBeInTheDocument()
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
    const dialog = await screen.findByRole('dialog', { name: '归档项目？' })
    await user.click(within(dialog).getByRole('button', { name: '归档项目' }))
    expect(await screen.findByText('只读。1 个对话将在 Ubuntu Dev 连接后停止。')).toBeInTheDocument()
    await advance(scheduler, browserLatency.device * 2)
    expect(screen.getByText('只读。1 个对话将在 Ubuntu Dev 连接后停止。')).toBeInTheDocument()
    expect((await client.listThreads()).find((thread) => thread.id === 'thr-gateway')).toMatchObject({
      status: 'running',
      pending: 'stop',
    })
    act(() => client.controls.setDeviceConnection('dev-ubuntu', 'online'))
    expect(await screen.findByText('只读。1 个对话正在停止。')).toBeInTheDocument()
    await advance(scheduler, browserLatency.device)
    expect(await screen.findByText('只读。聊天、记忆和对话记录已保留。')).toBeInTheDocument()
  })
})
