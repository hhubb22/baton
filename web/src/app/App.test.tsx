import { createMemoryHistory } from '@tanstack/react-router'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { createMockClient } from '../data/mock/client'
import type { ScenarioId } from '../data/mock/scenarios'
import { manualScheduler } from '../data/mock/scheduler'
import { browserLatency } from '../data/mock/store'
import type { ChangeEvent } from '../data/client'
import type { ProjectEntry } from '../data/types'
import { HttpError } from '../data/http/transport'
import { App } from './App'
import { createAppRouter } from './router'

const projectBodyRender = vi.hoisted(() => vi.fn())
vi.mock('./MessageBody', async (importOriginal) => {
  const original = await importOriginal<typeof import('./MessageBody')>()
  return {
    ...original,
    MessageBody: (props: Parameters<typeof original.MessageBody>[0]) => {
      projectBodyRender(props.body)
      return <original.MessageBody {...props} />
    },
  }
})

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
  await user.type(screen.getByLabelText('密码'), password)
  await user.click(screen.getByRole('button', { name: /登录|重新登录/ }))
}

async function openAccountMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /Kaken He/ }))
}

describe('app', () => {
  it.each([
    ['/threads', 'threads', 'Rebuild web UI foundation'],
    ['/devices', 'devices', 'Ubuntu Dev'],
    ['/projects/prj-baton', 'projects', 'Baton'],
  ] as const)('keeps %s content after a background 502', async (path, topic, content) => {
    let notify!: (event: ChangeEvent) => void
    let failed = false
    renderApp(path, 'normal', (client) => {
      const subscribe = client.subscribe.bind(client)
      client.subscribe = (listener) => {
        notify = listener
        return subscribe(listener)
      }
      if (topic === 'threads') {
        const read = client.listThreads.bind(client)
        client.listThreads = () => (failed ? Promise.reject(new HttpError(502, { code: 'unavailable' })) : read())
      } else if (topic === 'devices') {
        const read = client.listDevices.bind(client)
        client.listDevices = () => (failed ? Promise.reject(new HttpError(502, { code: 'unavailable' })) : read())
      } else {
        const read = client.listProjects.bind(client)
        client.listProjects = () => (failed ? Promise.reject(new HttpError(502, { code: 'unavailable' })) : read())
      }
    })
    expect(await screen.findAllByText(content, { exact: false })).not.toHaveLength(0)
    failed = true
    act(() => notify({ topics: [topic] }))
    expect(await screen.findByText(/更新失败，显示上次内容/)).toBeInTheDocument()
    expect(screen.getAllByText(content, { exact: false })).not.toHaveLength(0)
  })
  it('shows the first-visit guide when no device is connected', async () => {
    renderApp('/', 'empty')
    expect(await screen.findByRole('heading', { name: '连接第一台设备' })).toBeInTheDocument()
    expect(screen.getByText('暂无项目')).toBeInTheDocument()
  })

  it('opens Threads when devices exist', async () => {
    const { router } = renderApp('/')
    expect(await screen.findByRole('link', { name: /Rebuild web UI foundation/ })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/threads')
  })

  it('clears an unread thread after its messages are opened', async () => {
    const user = userEvent.setup()
    renderApp('/threads')
    const row = await screen.findByRole('link', { name: /Rebuild web UI foundation.*未读/ })
    expect(within(row).getByRole('img', { name: '未读' })).toBeInTheDocument()
    await user.click(row)
    await screen.findByText(/Scaffold is in place/)
    await waitFor(() => expect(within(row).queryByRole('img', { name: '未读' })).not.toBeInTheDocument())
  })

  it('keeps the unread marker when messages fail to load', async () => {
    const user = userEvent.setup()
    renderApp('/threads', 'normal', (client) => {
      client.listMessages = async () => {
        throw new Error('Cannot load messages')
      }
    })
    const row = await screen.findByRole('link', { name: /Rebuild web UI foundation.*未读/ })
    await user.click(row)
    expect(await screen.findByText('无法加载消息')).toBeInTheDocument()
    expect(within(row).getByRole('img', { name: '未读' })).toBeInTheDocument()
  })

  it('collapses and expands each thread group', async () => {
    const user = userEvent.setup()
    renderApp('/threads')
    const group = await screen.findByRole('button', { name: /待处理/ })
    const row = await screen.findByRole('link', { name: /Run unit tests on Ubuntu/ })
    expect(group).toHaveAttribute('aria-expanded', 'true')
    await user.click(group)
    expect(group).toHaveAttribute('aria-expanded', 'false')
    expect(row).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Rebuild web UI foundation/ })).toBeInTheDocument()
    group.focus()
    await user.keyboard('{Enter}')
    expect(group).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('link', { name: /Run unit tests on Ubuntu/ })).toBeInTheDocument()
  })

  it('keeps thread rows concise while retaining status and project names for assistive technology', async () => {
    renderApp('/threads')
    const row = await screen.findByRole('link', { name: /Fix gateway reconnect race/ })
    expect(row).toHaveAccessibleName(/运行中, Baton Dev/)
    expect(within(row).queryByText('Ubuntu Dev · Codex')).not.toBeInTheDocument()
    expect(within(row).queryByText('/home/kaken/work/baton')).not.toBeInTheDocument()
  })

  it('selects a device and searches its folders', async () => {
    const user = userEvent.setup()
    renderApp('/threads')
    await user.click(await screen.findByRole('button', { name: '设备：MacBook Pro' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Ubuntu Dev' }))
    expect(screen.getByRole('button', { name: '设备：Ubuntu Dev' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /文件夹：/ }))
    const menu = await screen.findByRole('menu')
    await user.type(within(menu).getByRole('textbox', { name: '搜索文件夹' }), 'switch')
    expect(within(menu).queryByText('/home/kaken/work/baton')).not.toBeInTheDocument()
    expect(
      within(menu).getByRole('menuitem', { name: /switch-patrol.*\/home\/kaken\/work\/switch-patrol/ }),
    ).toBeInTheDocument()
    await user.keyboard('{ArrowDown}{Enter}')
    expect(screen.getByRole('button', { name: '文件夹：switch-patrol' })).toBeInTheDocument()
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
    await user.click(await screen.findByRole('menuitem', { name: '默认模型' }))
    expect(await screen.findByRole('button', { name: 'Pi · 默认模型' })).toBeInTheDocument()
  })

  it('keeps the username after invalid credentials and returns to the requested page', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/threads', 'signedOut')
    await user.type(await screen.findByLabelText('用户名'), 'kaken')
    await signIn(user, 'wrong')
    expect(await screen.findByText('用户名或密码错误。')).toBeInTheDocument()
    expect(screen.getByLabelText('用户名')).toHaveValue('kaken')
    expect(screen.getByLabelText('密码')).toHaveValue('')
    expect(screen.getByLabelText('密码')).toHaveFocus()

    await signIn(user)
    expect(await screen.findByRole('link', { name: /对话/ })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/threads')
  })

  it('explains an expired sign-in and returns to the same thread', async () => {
    const user = userEvent.setup()
    const { client, router } = renderApp('/threads/thr-webui')
    expect(await screen.findByRole('heading', { name: 'Rebuild web UI foundation' })).toBeInTheDocument()

    act(() => client.controls.endSession('expired'))
    expect(await screen.findByText('登录已过期')).toBeInTheDocument()
    await user.type(screen.getByLabelText('用户名'), 'kaken')
    await signIn(user)
    expect(await screen.findByRole('heading', { name: 'Rebuild web UI foundation' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/threads/thr-webui')
  })

  it('asks for the new password after an administrator reset', async () => {
    const { client } = renderApp('/devices')
    expect(await screen.findByRole('heading', { name: '设备' })).toBeInTheDocument()
    act(() => client.controls.endSession('passwordReset'))
    expect(await screen.findByText('管理员已重置密码')).toBeInTheDocument()
    expect(screen.getByLabelText('密码')).toHaveAttribute('placeholder', '新密码')
  })

  it('keeps the form when Baton cannot be reached', async () => {
    const user = userEvent.setup()
    const { client, router } = renderApp('/login', 'signedOut')
    await user.type(await screen.findByLabelText('用户名'), 'kaken')
    client.controls.setReachable(false)
    await signIn(user)
    expect(await screen.findByText('无法连接 Baton')).toBeInTheDocument()
    expect(screen.getByLabelText('用户名')).toHaveValue('kaken')
    expect(screen.getByLabelText('密码')).toHaveValue('sample-password')

    client.controls.setReachable(true)
    await user.click(screen.getByRole('button', { name: '重新登录' }))
    expect(await screen.findByRole('link', { name: /Rebuild web UI foundation/ })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/threads')
  })

  it('signs out to an empty sign-in form', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/threads')
    await openAccountMenu(user)
    await user.click(await screen.findByRole('menuitem', { name: '退出登录' }))
    expect(await screen.findByText('已退出登录')).toBeInTheDocument()
    expect(screen.getByLabelText('密码')).toHaveValue('')
    expect(router.state.location.search).toEqual({ notice: 'signedOut' })
  })

  it('stays signed in and offers a retry when sign-out cannot be confirmed', async () => {
    const user = userEvent.setup()
    const { client } = renderApp('/threads')
    await openAccountMenu(user)
    client.controls.setReachable(false)
    await user.click(await screen.findByRole('menuitem', { name: '退出登录' }))
    expect(await screen.findByRole('heading', { name: '无法退出登录' })).toBeInTheDocument()

    client.controls.setReachable(true)
    await user.click(screen.getByRole('button', { name: '重试退出登录' }))
    expect(await screen.findByText('已退出登录')).toBeInTheDocument()
  })

  it('collapses the sidebar to icons and remembers it', async () => {
    const user = userEvent.setup()
    renderApp('/threads')
    const sidebar = await screen.findByRole('navigation', { name: '工作区' })
    expect(await within(sidebar).findByRole('link', { name: /Baton/ })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '收起侧栏' }))
    expect(screen.getByRole('button', { name: '展开侧栏' })).toBeInTheDocument()
    expect(within(sidebar).queryByRole('link', { name: /Baton/ })).not.toBeInTheDocument()
    expect(within(sidebar).getByRole('link', { name: '对话' })).toHaveAttribute('aria-current', 'page')
    expect(within(sidebar).queryByRole('button', { name: 'New thread' })).not.toBeInTheDocument()
    expect(within(sidebar).getByRole('button', { name: 'Kaken He' })).toBeInTheDocument()
    await user.click(within(sidebar).getByRole('button', { name: 'Kaken He' }))
    expect(await screen.findByRole('menuitem', { name: '深色' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(localStorage.getItem('baton.sidebar.collapsed')).toBe('true')

    await user.click(screen.getByRole('button', { name: '展开侧栏' }))
    expect(within(sidebar).getByText('项目')).toBeInTheDocument()
  })

  it('moves between pages and projects with the current one selected', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/threads')
    const sidebar = await screen.findByRole('navigation', { name: '工作区' })
    await user.click(await within(sidebar).findByRole('link', { name: /Baton/ }))
    expect(router.state.location.pathname).toBe('/projects/prj-baton')
    expect(within(sidebar).getByRole('link', { name: /Baton/ })).toHaveAttribute('aria-current', 'page')
    expect(within(sidebar).getByRole('link', { name: /对话/ })).not.toHaveAttribute('aria-current')

    await user.click(within(sidebar).getByRole('link', { name: /对话/ }))
    expect(router.state.location.pathname).toBe('/threads')
    expect(within(sidebar).getByRole('link', { name: /对话/ })).toHaveAttribute('aria-current', 'page')
  })

  it('updates thread, project and file preview when a device goes offline', async () => {
    const user = userEvent.setup()
    const { client, router } = renderApp('/threads/thr-webui')
    await user.click(await screen.findByRole('button', { name: '~/src/baton/README.md' }))
    const preview = await screen.findByRole('dialog', { name: 'README.md' })
    expect(await within(preview).findByText(/Baton/)).toBeInTheDocument()

    act(() => client.controls.setDeviceConnection('dev-mac', 'offline'))
    expect(await within(preview).findByText('MacBook Pro 已离线')).toBeInTheDocument()
    expect(within(preview).queryByText(/^# /)).not.toBeInTheDocument()
    expect(screen.getAllByText('MacBook Pro 已离线').length).toBeGreaterThan(0)

    act(() => client.controls.setDeviceConnection('dev-ubuntu', 'offline'))
    await act(() => router.navigate({ to: '/projects/$projectId', params: { projectId: 'prj-baton' } }))
    expect(await screen.findByText('所有设备已离线')).toBeInTheDocument()
  })

  it('shows send phases until the agent replies', async () => {
    const user = userEvent.setup()
    const { scheduler } = renderApp('/threads/thr-webui')
    await user.type(await screen.findByLabelText('消息'), 'Add dark theme{Enter}')
    expect(await screen.findByText('Add dark theme')).toBeInTheDocument()

    act(() => scheduler.advance(browserLatency.save))
    expect(await screen.findByRole('heading', { name: 'Rebuild web UI foundation' })).toBeInTheDocument()
    expect(await screen.findByText('运行中')).toBeInTheDocument()

    act(() => scheduler.advance(browserLatency.run))
    expect(await screen.findByText('空闲')).toBeInTheDocument()
  })
})

describe('projects', () => {
  it('does not rerender saved project messages while a thread timer advances', async () => {
    renderApp('/projects/prj-baton', 'normal')
    await screen.findByText(/Opened a thread on Ubuntu Dev/)
    projectBodyRender.mockClear()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1100))
    })
    expect(projectBodyRender).not.toHaveBeenCalled()
  })
  it('keeps a preview until its run is terminal and a later history read proves it was not saved', async () => {
    let notify!: (event: ChangeEvent) => void
    let finished = false
    let reads = 0
    let failConfirmation = true
    renderApp('/projects/prj-baton', 'normal', (client) => {
      const list = client.listProjects.bind(client)
      client.listProjects = async () =>
        (await list()).map((project) =>
          project.id === 'prj-baton'
            ? {
                ...project,
                agent: {
                  ...project.agent,
                  state: finished ? 'idle' : 'running',
                  runId: 'run-1',
                  runState: finished ? 'failed' : 'running',
                  lastSeq: 5,
                  preview: finished ? null : { afterSeq: 5, text: 'Temporary answer', truncated: false },
                },
              }
            : project,
        )
      client.readProjectTimeline = async () => {
        reads += 1
        if (finished && failConfirmation) throw new Error('offline')
        return { entries: [], anchors: { 5: 1234 }, lastSeq: 5 }
      }
      client.subscribe = (listener) => {
        notify = listener
        return () => {}
      }
    })
    const preview = await screen.findByRole('article', { name: '项目助手正在回复' })
    expect(preview).toHaveTextContent('Temporary answer')
    const before = reads
    finished = true
    act(() => notify({ topics: ['projects'] }))
    expect(await screen.findByText('无法确认回复是否保存')).toBeInTheDocument()
    expect(preview).toHaveTextContent('Temporary answer')
    failConfirmation = false
    await userEvent.setup().click(screen.getByRole('button', { name: '重试确认' }))
    expect(await screen.findByText('回复中断，内容未保存。')).toBeInTheDocument()
    expect(reads).toBeGreaterThan(before)
    expect(screen.queryByText('Temporary answer')).not.toBeInTheDocument()
  })
  async function advance(scheduler: ReturnType<typeof manualScheduler>, ms: number) {
    for (let passed = 0; passed < ms; passed += 50) {
      await act(async () => scheduler.advance(Math.min(50, ms - passed)))
    }
  }

  async function createProject(user: ReturnType<typeof userEvent.setup>, name: string) {
    await user.click(await screen.findByRole('button', { name: '新建项目' }))
    const dialog = await screen.findByRole('dialog', { name: '新建项目' })
    await user.type(within(dialog).getByLabelText('名称'), name)
    await user.click(within(dialog).getByRole('button', { name: '创建项目' }))
    return dialog
  }

  it('asks for a name, then opens the empty project', async () => {
    const user = userEvent.setup()
    const { scheduler, router } = renderApp('/threads')
    await user.click(await screen.findByRole('button', { name: '新建项目' }))
    const dialog = await screen.findByRole('dialog', { name: '新建项目' })
    expect(within(dialog).queryByText(/signed in/)).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: '创建项目' }))
    expect(within(dialog).getByText('请输入项目名称。')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('名称')).toHaveFocus()

    await user.selectOptions(within(dialog).getByLabelText('模型来源'), '|Claude')
    expect(within(dialog).getByLabelText('模型')).toHaveValue('claude-opus-5-5')
    await user.selectOptions(within(dialog).getByLabelText('模型来源'), '|ChatGPT')
    await user.type(within(dialog).getByLabelText('名称'), 'Release{Enter}')
    await advance(scheduler, 500)
    expect(await screen.findByText('暂无对话')).toBeInTheDocument()
    expect(router.state.location.pathname).toMatch(/^\/projects\/prj-/)
    expect(screen.getByLabelText('给项目助手发消息')).toHaveAttribute('aria-placeholder', '描述你想完成或验证的事…')
  })

  it('keeps the entries when saving fails and saves on retry', async () => {
    const user = userEvent.setup()
    const { scheduler, router } = renderApp('/threads', 'error')
    const dialog = await createProject(user, 'Retry me')
    await advance(scheduler, 500)
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('无法创建项目，请重试。')
    expect(within(dialog).getByLabelText('名称')).toHaveValue('Retry me')
    await user.click(within(dialog).getByRole('button', { name: '重试' }))
    await advance(scheduler, 500)
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/projects\/prj-/))
    expect(await screen.findAllByText('Retry me')).not.toHaveLength(0)
  })

  it('shows project activity as expandable steps without hiding the thread or reply', async () => {
    const user = userEvent.setup()
    renderApp('/projects/prj-compat')
    const group = (await screen.findAllByRole('button', { name: '执行过程' }))[0]!
    expect(screen.queryByRole('complementary', { name: '概览' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '显示概览' })).toHaveAttribute('aria-expanded', 'false')
    expect(group).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('region', { name: '已新建 1 个对话' })).not.toBeInTheDocument()
    expect(screen.queryByText('4f2c9e1 Add drive letter cases to path tests')).not.toBeInTheDocument()
    await user.click(group)
    const command = screen.getByRole('button', { name: /git -C ~\/src\/compat-suite log -1 --oneline/ })
    expect(command).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText(/Compat suite is in/)).toBeInTheDocument()
    await user.click(command)
    expect(screen.getByText('4f2c9e1 Add drive letter cases to path tests')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '已新建 1 个对话' })).toBeInTheDocument()
    expect(screen.getByText(/Opened a thread on Windows Desktop/)).toBeInTheDocument()
    await user.click(command)
    expect(screen.queryByText('4f2c9e1 Add drive letter cases to path tests')).not.toBeInTheDocument()
  })

  it('keeps one expanded process per project run as tools, threads and replies arrive', async () => {
    const user = userEvent.setup()
    const { scheduler } = renderApp('/projects/prj-compat', 'streamingProject')
    await screen.findByRole('heading', { name: /Compatibility/ })
    await advance(scheduler, 1800)
    const process = await screen.findByRole('button', { name: '正在处理' })
    await user.click(process)
    await advance(scheduler, 3200)
    await waitFor(() => expect(screen.getAllByRole('button', { name: '执行过程' })).toHaveLength(1))
    expect(process).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('region', { name: '已新建 1 个对话' })).toBeInTheDocument()
    expect(screen.getByText(/Compat suite is in/)).toBeInTheDocument()
    await advance(scheduler, 30000)
    await waitFor(() => {
      const conversation = screen.getByRole('region', { name: '对话' })
      expect(conversation).toHaveTextContent('The suite finished with 2 failures')
      expect(conversation).toHaveTextContent('Opened a thread on Windows Desktop')
    })
    expect(screen.getAllByRole('button', { name: '执行过程' })).toHaveLength(2)
    expect(process).toHaveAttribute('aria-expanded', 'true')
  })

  it('streams a project preview and replaces it when the saved reply arrives before status refresh', async () => {
    let preview: { afterSeq: number; text: string; truncated: boolean } | null = {
      afterSeq: 7,
      text: 'Checking **the',
      truncated: false,
    }
    let entries: ProjectEntry[] = [
      { id: 'before', projectId: 'prj-compat', kind: 'note', body: 'Started', createdAt: 1, sourceSeq: 7 },
    ]
    let notify: ((event: ChangeEvent) => void) | undefined
    renderApp('/projects/prj-compat', 'normal', (client) => {
      const list = client.listProjects.bind(client)
      client.listProjects = async () =>
        (await list()).map((project) =>
          project.id === 'prj-compat'
            ? { ...project, agent: { ...project.agent, state: 'running', activity: null, preview } }
            : project,
        )
      client.listProjectEntries = async () => entries
      client.subscribe = (listener) => {
        notify = listener
        return () => {
          notify = undefined
        }
      }
    })
    const refresh = () => act(() => notify?.({ topics: ['projects'] }))
    const live = await screen.findByRole('article', { name: '项目助手正在回复' })
    expect(live).toHaveTextContent('Checking')
    const conversation = screen.getByRole('region', { name: '对话' })
    Object.defineProperties(conversation, { scrollHeight: { value: 1000 }, clientHeight: { value: 200 } })
    conversation.scrollTop = 800
    fireEvent.scroll(conversation)
    conversation.scrollTop = 200
    fireEvent.scroll(conversation)

    preview = { afterSeq: 7, text: 'Checking **the result**.', truncated: false }
    refresh()
    await waitFor(() => expect(live).toHaveTextContent('Checking the result.'))
    expect(conversation.scrollTop).toBe(200)

    entries = [
      ...entries,
      {
        id: 'saved',
        projectId: 'prj-compat',
        kind: 'assistant',
        process: [],
        threads: null,
        body: 'Checking **the result**.',
        createdAt: 2,
        sourceSeq: 8,
        streamAnchor: 7,
      },
    ]
    refresh()
    await waitFor(() => expect(screen.queryByRole('article', { name: '项目助手正在回复' })).not.toBeInTheDocument())
    expect(screen.getByRole('article', { name: '项目助手' })).toBe(live)
    expect(screen.getByRole('article', { name: '项目助手' })).toHaveTextContent('Checking the result.')
    preview = null
    refresh()
    await waitFor(() => expect(screen.queryByRole('article', { name: '项目助手正在回复' })).not.toBeInTheDocument())
  })

  it('places the live preview after the latest thread event even when its timestamp is ahead of the page clock', async () => {
    const user = userEvent.setup()
    let saved = false
    let notify: ((event: ChangeEvent) => void) | undefined
    const threadTime = Date.now() + 60_000
    renderApp('/projects/prj-compat', 'normal', (client) => {
      const list = client.listProjects.bind(client)
      client.listProjects = async () =>
        (await list()).map((project) =>
          project.id === 'prj-compat'
            ? {
                ...project,
                agent: {
                  ...project.agent,
                  state: 'running',
                  activity: null,
                  preview: { afterSeq: 5, text: 'Final reply', truncated: false },
                },
              }
            : project,
        )
      client.listProjectEntries = async (projectId) => [
        {
          id: 'thread-reply',
          projectId,
          kind: 'assistant',
          body: '',
          process: [],
          threads: { action: 'replies', threadIds: ['thr-compat'] },
          createdAt: threadTime,
          sourceSeq: 5,
        },
        ...(saved
          ? [
              {
                id: 'saved-reply',
                projectId,
                kind: 'assistant' as const,
                body: 'Final reply',
                process: [],
                threads: null,
                createdAt: threadTime + 1,
                sourceSeq: 6,
                streamAnchor: 5,
              },
            ]
          : []),
      ]
      client.subscribe = (listener) => {
        notify = listener
        return () => {
          notify = undefined
        }
      }
    })
    await user.click(await screen.findByRole('button', { name: '执行过程' }))
    const thread = await screen.findByRole('region', { name: '来自 1 个对话的回复' })
    const preview = await screen.findByRole('article', { name: '项目助手正在回复' })
    expect(thread.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    saved = true
    act(() => notify?.({ topics: ['projects'] }))
    await waitFor(() => expect(preview).toHaveAttribute('aria-label', '项目助手'))
    expect(thread.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('keeps a preview visible while a newer saved reply is still loading', async () => {
    let saved = false
    let release: (() => void) | undefined
    let notify: ((event: ChangeEvent) => void) | undefined
    renderApp('/projects/prj-compat', 'normal', (client) => {
      const list = client.listProjects.bind(client)
      client.listProjects = async () =>
        (await list()).map((project) =>
          project.id === 'prj-compat'
            ? {
                ...project,
                agent: {
                  ...project.agent,
                  state: saved ? 'idle' : 'running',
                  activity: null,
                  lastSeq: saved ? 8 : 7,
                  preview: saved ? null : { afterSeq: 7, text: 'Almost done.', truncated: false },
                },
              }
            : project,
        )
      client.listProjectEntries = async (projectId) => {
        if (!saved) return []
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return [
          {
            id: 'saved',
            projectId,
            createdAt: 1,
            sourceSeq: 8,
            streamAnchor: 7,
            kind: 'assistant',
            process: [],
            threads: null,
            body: 'Almost done.',
          },
        ]
      }
      client.subscribe = (listener) => {
        notify = listener
        return () => {
          notify = undefined
        }
      }
    })
    const preview = await screen.findByRole('article', { name: '项目助手正在回复' })
    expect(preview).toHaveTextContent('Almost done.')
    saved = true
    act(() => notify?.({ topics: ['projects'] }))
    await waitFor(() => expect(release).toBeDefined())
    expect(preview).toBeVisible()
    expect(preview).toHaveTextContent('Almost done.')
    act(() => release?.())
    await waitFor(() => expect(screen.queryByRole('article', { name: '项目助手正在回复' })).not.toBeInTheDocument())
    expect(screen.getByRole('article', { name: '项目助手' })).toHaveTextContent('Almost done.')
  })

  it('updates a pending project tool in place when its result arrives', async () => {
    const user = userEvent.setup()
    let completed = false
    let notify: ((event: ChangeEvent) => void) | undefined
    renderApp('/projects/prj-compat', 'normal', (client) => {
      client.listProjectEntries = async (projectId) => [
        {
          id: 'tool-live',
          projectId,
          createdAt: 1,
          sourceSeq: 5,
          kind: 'assistant',
          body: '',
          threads: null,
          process: [
            {
              kind: 'tool',
              name: 'nodes.exec',
              input: '{"command":"pwd"}',
              output: completed ? '/work' : null,
              status: completed ? 'completed' : 'pending',
            },
          ],
        },
      ]
      client.subscribe = (listener) => {
        notify = listener
        return () => {
          notify = undefined
        }
      }
    })
    await user.click(await screen.findByRole('button', { name: '正在处理' }))
    const command = await screen.findByRole('button', { name: /nodes.exec.*等待结果/ })
    await user.click(command)
    expect(screen.getAllByText('等待结果')).toHaveLength(2)
    completed = true
    act(() => notify?.({ topics: ['projects'] }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'nodes.exec' })).toHaveAttribute('aria-expanded', 'true'),
    )
    expect(screen.getByText('/work')).toBeInTheDocument()
  })

  it('opens a running command from its project tool call', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/projects/prj-compat', 'normal', (client) => {
      client.listProjectExecutions = async () => [
        {
          id: 'shell-execution',
          projectId: 'prj-compat',
          deviceId: 'dev-ubuntu',
          command: 'pwd',
          workingDirectory: '/work',
          timeoutSeconds: 60,
          createdAt: Date.now(),
          status: 'running',
          originConversationId: 'conversation',
          originToolCallId: 'exec',
        },
      ]
      client.listProjectEntries = async (projectId) => [
        {
          id: 'tool-entry',
          projectId,
          createdAt: Date.now(),
          kind: 'assistant',
          body: '',
          threads: null,
          process: [
            {
              kind: 'tool',
              name: 'nodes.exec',
              conversationId: 'conversation',
              toolCallId: 'exec',
              input: '{"command":"pwd"}',
              output: null,
              status: 'pending',
            },
          ],
        },
      ]
    })
    await user.click(await screen.findByRole('button', { name: '正在处理' }))
    await user.click(screen.getByRole('button', { name: /nodes.exec.*等待结果/ }))
    await user.click(await screen.findByRole('button', { name: /查看执行详情/ }))
    await waitFor(() => expect(router.state.location.search).toMatchObject({ execution: 'shell-execution' }))
  })

  it('keeps failed and unfinished tool calls visible in project activity', async () => {
    const user = userEvent.setup()
    renderApp('/projects/prj-compat', 'normal', (client) => {
      client.listProjectEntries = async (projectId) => [
        {
          id: 'tool-entry',
          projectId,
          createdAt: Date.now(),
          kind: 'assistant',
          body: 'Checking the result.',
          threads: null,
          process: [
            { kind: 'tool', name: 'nodes.exec', input: '{"command":"pwd"}', output: null, status: 'pending' },
            { kind: 'tool', name: 'threads.create', input: '{}', output: 'Device unavailable', status: 'failed' },
          ],
        },
      ]
    })
    const group = await screen.findByRole('button', { name: '正在处理' })
    expect(group).toHaveAttribute('aria-expanded', 'false')
    await user.click(group)
    expect(screen.getByRole('button', { name: /nodes.exec.*等待结果/ })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /threads.create.*失败/ }))
    expect(screen.getByText('Device unavailable')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: '对话' })).getByText('Checking the result.')).toBeInTheDocument()
  })

  it('opens two threads, shows their replies and opens one beside the conversation', async () => {
    const user = userEvent.setup()
    const { scheduler } = renderApp('/threads')
    await createProject(user, 'Compat run')
    await advance(scheduler, 500)
    await user.type(
      await screen.findByLabelText('给项目助手发消息'),
      'Run the compat suite on MacBook Pro and Ubuntu Dev.{Enter}',
    )
    await advance(scheduler, browserLatency.save + browserLatency.run / 2)
    await user.click((await screen.findAllByRole('button', { name: '执行过程' })).at(-1)!)
    await screen.findByRole('region', { name: '已新建 2 个对话' })
    await user.click(screen.getByRole('button', { name: '显示概览' }))
    const overview = screen.getByRole('complementary', { name: '概览' })
    expect(within(overview).getByRole('tab', { name: /对话/ })).toHaveTextContent('2')

    await advance(scheduler, browserLatency.run * 2)
    await user.click((await screen.findAllByRole('button', { name: '执行过程' })).at(-1)!)
    const replies = await screen.findByRole('region', { name: '来自 2 个对话的回复' })
    expect(screen.getByText(/^Both threads finished\./)).toBeInTheDocument()

    await user.click(within(replies).getAllByRole('button')[0])
    const panel = await screen.findByRole('complementary', { name: /compat/i })
    expect(screen.queryByRole('complementary', { name: '概览' })).not.toBeInTheDocument()
    await user.click(within(panel).getByRole('button', { name: '返回概览' }))
    expect(await screen.findByRole('complementary', { name: '概览' })).toBeInTheDocument()
  })

  it('saves messages while no device can run the assistant', async () => {
    const user = userEvent.setup()
    const { scheduler } = renderApp('/projects/prj-docs', 'waiting')
    expect(await screen.findByText('没有设备登录 Claude')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '查看设备' })).toBeInTheDocument()
    await user.type(screen.getByLabelText('给项目助手发消息'), 'Check the install guide.{Enter}')
    await advance(scheduler, browserLatency.save + 100)
    await waitFor(() => expect(screen.getAllByText('等待设备').length).toBeGreaterThanOrEqual(2))
    expect(screen.getByText(/2 条消息待发送/)).toBeInTheDocument()
  })

  it('stops the assistant run and leaves its threads running', async () => {
    const user = userEvent.setup()
    const { scheduler } = renderApp('/projects/prj-baton')
    await user.click(await screen.findByRole('button', { name: '停止运行' }))
    expect(await screen.findByText(/停止助手$/)).toBeInTheDocument()
    expect(screen.getByText('已请求停止')).toBeInTheDocument()
    await advance(scheduler, browserLatency.device + 100)
    expect(await screen.findByText('You stopped the project assistant')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '显示概览' }))
    const overview = screen.getByRole('complementary', { name: '概览' })
    expect(within(within(overview).getByRole('region', { name: '运行中' })).getByText(/gateway/i)).toBeInTheDocument()
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

  it('chooses thinking for a new thread and keeps the choice when sending the next message', async () => {
    const user = userEvent.setup()
    const { scheduler, client } = renderApp('/threads', 'noChats')
    const sendMessage = vi.spyOn(client, 'sendMessage')
    await user.click(await screen.findByRole('button', { name: '思考强度：默认' }))
    await user.click(await screen.findByRole('menuitem', { name: '高' }))
    await user.type(screen.getByLabelText('新对话消息'), 'Check the change{Enter}')
    await advance(scheduler, browserLatency.read + browserLatency.save)
    const detail = await panel('Check the change')
    expect(await within(detail).findByRole('button', { name: '思考强度：高' })).toBeInTheDocument()
    await user.type(within(detail).getByLabelText('消息'), 'Review the tests{Enter}')
    await advance(scheduler, browserLatency.read + browserLatency.save)
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        body: 'Review the tests',
        thinking: { id: 'reasoningEffort', value: 'high' },
      }),
    )
  })

  it('starts a thread from an empty list, continues it and archives it', async () => {
    const user = userEvent.setup()
    const { scheduler } = renderApp('/threads', 'noChats')
    expect(await screen.findByText('暂无对话')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '文件夹：baton' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '设备：MacBook Pro' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Codex · gpt-6.1-sol/ })).toBeInTheDocument()

    await user.type(screen.getByLabelText('新对话消息'), 'Add a health check{Enter}')
    await advance(scheduler, browserLatency.read + browserLatency.save)
    const detail = await panel('Add a health check')
    expect((await within(detail).findAllByText('运行中')).length).toBeGreaterThan(0)
    expect(screen.getByLabelText('新对话消息')).toHaveTextContent(/^$/)

    await advance(scheduler, browserLatency.read + browserLatency.run)
    expect(await within(detail).findByText('空闲')).toBeInTheDocument()
    // 流式回复的文字按字符拆开渲染并逐步显示，这里等待完整文本。
    await waitFor(() => expect(detail).toHaveTextContent('Done. The change is ready for review.'))
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /Add a health check/ })).not.toHaveAccessibleName(/Unread/),
    )

    await user.type(within(detail).getByLabelText('消息'), 'Also document it{Enter}')
    await advance(scheduler, browserLatency.save + browserLatency.run)
    await waitFor(() => expect(detail.textContent?.match(/Done\. The change is ready for review\./g)).toHaveLength(2))

    await user.click(within(detail).getByRole('button', { name: '关闭对话' }))
    const row = await screen.findByRole('link', { name: /Add a health check/ })
    expect(row).toHaveAccessibleName(/无项目/)

    await user.click(row)
    const reopened = await panel('Add a health check')
    await user.click(within(reopened).getByRole('button', { name: '对话操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '归档对话' }))
    const dialog = await screen.findByRole('dialog', { name: '归档此对话？' })
    await user.click(within(dialog).getByRole('button', { name: '归档对话' }))
    await advance(scheduler, browserLatency.read + browserLatency.save)
    expect((await within(reopened).findAllByText('已归档')).length).toBeGreaterThan(0)
    expect(within(reopened).queryByLabelText('消息')).not.toBeInTheDocument()
  })

  it('queues the next message and cancels it before it is sent', async () => {
    const user = userEvent.setup()
    const { scheduler } = renderApp('/threads?thread=thr-gateway')
    const detail = await panel('Fix gateway reconnect race')
    expect(within(detail).getByText('当前回复结束后发送')).toBeInTheDocument()
    await user.type(within(detail).getByLabelText('消息'), 'Also add a regression test{Enter}')
    await advance(scheduler, browserLatency.read + browserLatency.save)
    expect(await within(detail).findByText(/下一条发送 ·/)).toBeInTheDocument()

    await user.click(within(detail).getByRole('button', { name: '取消' }))
    await advance(scheduler, browserLatency.read + browserLatency.save)
    expect(await within(detail).findByText('未发送')).toBeInTheDocument()
  })

  it('explains why Kiro cannot read messages during a reply', async () => {
    const user = userEvent.setup()
    renderApp('/threads?thread=thr-patrol')
    const detail = await panel('Organize switch patrol scripts')
    await user.click(within(detail).getByRole('button', { name: '立即发送' }))
    expect(within(detail).getByText(/Kiro 回复时无法读取新消息/)).toBeInTheDocument()
    expect(within(detail).getByRole('button', { name: '下一条发送' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('stops a reply only after the device confirms', async () => {
    const user = userEvent.setup()
    const { scheduler } = renderApp('/threads?thread=thr-gateway')
    const detail = await panel('Fix gateway reconnect race')
    await user.click(within(detail).getByRole('button', { name: '停止当前回复' }))
    const dialog = await screen.findByRole('dialog', { name: '停止当前回复？' })
    await user.click(within(dialog).getByRole('button', { name: '停止回复' }))
    await advance(scheduler, browserLatency.read + browserLatency.save)
    expect((await within(detail).findAllByText('正在停止…')).length).toBeGreaterThan(0)

    await advance(scheduler, browserLatency.read + browserLatency.device)
    expect(await within(detail).findByText('已由你停止')).toBeInTheDocument()
    expect(within(detail).getByLabelText('消息')).toBeInTheDocument()
  })

  it('keeps the last report while the device is offline and waits on the same device', async () => {
    const user = userEvent.setup()
    const { client } = renderApp('/threads?thread=thr-gateway')
    const detail = await panel('Fix gateway reconnect race')
    act(() => client.controls.setDeviceConnection('dev-ubuntu', 'offline'))
    expect(await within(detail).findByText('Ubuntu Dev 已离线')).toBeInTheDocument()
    expect(within(detail).getAllByText('上次运行中').length).toBeGreaterThan(0)

    await user.click(within(detail).getByRole('button', { name: '查看设备' }))
    expect(await screen.findByRole('heading', { name: '设备' })).toBeInTheDocument()
  })

  it('offers recovery without resending anything', async () => {
    const user = userEvent.setup()
    renderApp('/threads?thread=thr-sleep', 'error')
    const detail = await panel('Run sleep tests on Windows')
    expect(within(detail).getByText('Codex 无法启动')).toBeInTheDocument()
    expect(within(detail).queryByLabelText('消息')).not.toBeInTheDocument()

    await user.click(within(detail).getByRole('button', { name: '在此文件夹新建对话' }))
    expect(screen.getByRole('button', { name: '文件夹：baton' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '设备：Windows Desktop' })).toBeInTheDocument()
    expect(screen.getByLabelText('新对话消息')).toHaveFocus()
    expect(screen.getByLabelText('新对话消息')).toHaveTextContent(/^$/)
  })

  it('adds and selects a folder path directly from the folder dialog', async () => {
    const user = userEvent.setup()
    const { client } = renderApp('/threads/thr-compat', 'error')
    await user.click(await screen.findByRole('button', { name: '选择文件夹' }))
    const dialog = await screen.findByRole('dialog', { name: '选择文件夹' })
    await user.selectOptions(within(dialog).getByLabelText('设备'), 'dev-mac')
    await user.type(within(dialog).getByLabelText('文件夹路径'), '  /Users/kaken/new-project  ')
    expect(within(dialog).getByText('将此文件夹添加到 MacBook Pro。')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: '添加并选择' }))
    expect(await screen.findByRole('button', { name: '文件夹：new-project' })).toBeInTheDocument()
    expect((await client.listDevices()).find((device) => device.id === 'dev-mac')?.folders).toContain(
      '/Users/kaken/new-project',
    )
  })

  it('asks for another folder when the old one is missing', async () => {
    const user = userEvent.setup()
    renderApp('/threads/thr-compat', 'error')
    await user.click(await screen.findByRole('button', { name: '选择文件夹' }))
    const dialog = await screen.findByRole('dialog', { name: '选择文件夹' })
    expect(within(dialog).getByLabelText('设备')).toHaveValue('dev-windows')
    expect(await within(dialog).findByText('Windows Desktop 已离线')).toBeInTheDocument()

    await user.selectOptions(within(dialog).getByLabelText('设备'), 'dev-mac')
    await user.click(await within(dialog).findByRole('button', { name: '~/src' }))
    await user.click(await within(dialog).findByRole('button', { name: 'compat-suite' }))
    await user.click(within(dialog).getByRole('button', { name: '选择文件夹' }))
    expect(await screen.findByRole('button', { name: '文件夹：compat-suite' })).toBeInTheDocument()
    expect(screen.getByLabelText('新对话消息')).toHaveFocus()
  })
})

describe('devices', () => {
  function deviceRow(name: string) {
    return screen.getByRole('button', { name: new RegExp(`^${name}`) })
  }

  it.each([
    ['draining', '等待升级'],
    ['ready', '等待升级'],
    ['migrating', '正在升级'],
    ['syncing', '正在升级'],
    ['completed', '正在运行 Baton Dev'],
    ['failed', '升级已暂停'],
    ['cancelled', '正在运行 Baton Dev'],
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
    if (phase !== 'cancelled' && phase !== 'completed')
      expect(within(row).queryByText('正在运行 Baton Dev')).not.toBeInTheDocument()
    await user.click(row)
    if (phase === 'cancelled' || phase === 'completed') expect(screen.queryByText(/^0\.9\.2 · /)).toBeNull()
    else expect(screen.getByText(/^0\.9\.2 · /)).toBeInTheDocument()
    if (phase === 'failed') expect(screen.getByText('0.9.2 · 更新失败')).toBeInTheDocument()
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
    expect(within(deviceRow(name)).getByText('需要登录')).toBeInTheDocument()
    const before = (await client.listDevices()).find((device) => device.id === id)!
    const defaultId = (await client.getSession()).defaultDeviceId
    const threadIds = (await client.listThreads()).map((thread) => thread.id)

    await user.click(deviceRow(name))
    expect(screen.getAllByText('需要登录').length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: '重新连接设备' }))
    const dialog = await screen.findByRole('dialog', { name: '重新连接设备' })
    await within(dialog).findByText('等待设备连接…')
    expect(within(dialog).getByText(name)).toBeInTheDocument()
    expect(within(dialog).queryByLabelText('设备名称')).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('radiogroup', { name: '操作系统' })).not.toBeInTheDocument()
    const command = within(dialog).getByLabelText('在终端运行')
    expect(command.textContent).toBe(`${tokenInput}\nbatond reauth && batond up`)
    expect(command.textContent).not.toContain(within(dialog).getByLabelText('设置码').textContent!)
    const firstCode = within(dialog).getByLabelText('设置码').textContent

    act(() => client.controls.expireEnrollment())
    await within(dialog).findByRole('button', { name: '获取新设置码' })
    client.controls.setReachable(false)
    await user.click(within(dialog).getByRole('button', { name: '获取新设置码' }))
    expect(await within(dialog).findByText('无法连接 Baton')).toBeInTheDocument()
    client.controls.setReachable(true)
    await user.click(within(dialog).getByRole('button', { name: '获取新设置码' }))
    await within(dialog).findByText('等待设备连接…')
    expect(within(dialog).getByLabelText('设置码').textContent).not.toBe(firstCode)
    expect(create.mock.calls.map(([nodeId]) => nodeId)).toEqual([id, id, id])

    act(() => client.controls.connectEnrollment('Another name', 'macOS'))
    expect(await within(dialog).findByText('已连接')).toBeInTheDocument()
    expect(within(dialog).getByText(name)).toBeInTheDocument()
    act(() => scheduler.advance(browserLatency.device))
    await user.click(within(dialog).getByRole('button', { name: '完成' }))
    await waitFor(() => expect(screen.queryByText('需要登录')).not.toBeInTheDocument())
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
    expect(screen.queryByRole('button', { name: '重新连接设备' })).not.toBeInTheDocument()
  })

  it('connects a device with a setup code and updates the counts', async () => {
    const user = userEvent.setup()
    const { client, scheduler } = renderApp('/devices', 'empty')
    await user.click(await screen.findByRole('button', { name: '连接设备' }))
    const dialog = await screen.findByRole('dialog', { name: '连接设备' })
    expect(await within(dialog).findByText('等待设备连接…')).toBeInTheDocument()

    await user.type(within(dialog).getByLabelText('设备名称'), 'Build Server')
    await user.click(within(dialog).getByRole('radio', { name: 'Linux' }))
    const command = within(dialog).getByLabelText('在终端运行')
    expect(command).toHaveTextContent('read -rs BATON_ENROLLMENT_TOKEN && export BATON_ENROLLMENT_TOKEN')
    expect(command).toHaveTextContent('batond up --coordinator')
    expect(command).toHaveTextContent('--display-name "Build Server" --system linux')
    expect(command.textContent).not.toMatch(/[A-Za-z0-9]{8}-[A-Za-z0-9]{4}-/)

    await user.click(within(dialog).getByRole('button', { name: '复制命令' }))
    expect(within(dialog).queryByText(/Clipboard blocked/)).not.toBeInTheDocument()

    act(() => client.controls.connectEnrollment('Build Server', 'Linux'))
    expect(await within(dialog).findByText('已连接')).toBeInTheDocument()
    expect(within(dialog).getByText('Linux · 正在检查可用性…')).toBeInTheDocument()
    act(() => scheduler.advance(browserLatency.device))
    await waitFor(() => expect(within(dialog).queryByText(/Checking availability/)).not.toBeInTheDocument())
    expect(within(dialog).queryByText(/No agents available/)).not.toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: '完成' }))
    expect(screen.getByRole('heading', { name: '1 台设备，1 台在线' })).toHaveFocus()
    expect(within(deviceRow('Build Server')).getByText('默认')).toBeInTheDocument()
  })

  it('gets a new code after the old one expires and keeps the form', async () => {
    const user = userEvent.setup()
    const { client } = renderApp('/devices')
    await user.click(await screen.findByRole('button', { name: '连接设备' }))
    const dialog = await screen.findByRole('dialog', { name: '连接设备' })
    await within(dialog).findByText('等待设备连接…')
    await user.type(within(dialog).getByLabelText('设备名称'), 'Lab PC')
    await user.click(within(dialog).getByRole('radio', { name: 'Windows' }))

    act(() => client.controls.expireEnrollment())
    expect((await within(dialog).findAllByText('设置码已过期')).length).toBeGreaterThan(0)

    client.controls.setReachable(false)
    await user.click(within(dialog).getByRole('button', { name: '获取新设置码' }))
    expect(await within(dialog).findByText('无法连接 Baton')).toBeInTheDocument()

    client.controls.setReachable(true)
    await user.click(within(dialog).getByRole('button', { name: '获取新设置码' }))
    expect(await within(dialog).findByText('等待设备连接…')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('设备名称')).toHaveValue('Lab PC')
    expect(within(dialog).getByLabelText('在终端运行')).toHaveTextContent(
      '$env:BATON_ENROLLMENT_TOKEN = Read-Host -MaskInput',
    )

    act(() => client.controls.useEnrollmentElsewhere())
    expect((await within(dialog).findAllByText('设置码已使用')).length).toBeGreaterThan(0)
  })

  it('removes device folders and keeps a folder when removal fails', async () => {
    const user = userEvent.setup()
    const { client } = renderApp('/devices')
    await user.click(await screen.findByRole('button', { name: /^Ubuntu Dev/ }))
    await user.click(screen.getByRole('button', { name: '文件夹…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Ubuntu Dev 上的文件夹' })
    const remove = await within(dialog).findByRole('button', { name: '移除 /home/kaken/work' })

    client.controls.setReachable(false)
    await user.click(remove)
    expect(await within(dialog).findByText('无法移除文件夹，请重试。')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '移除 /home/kaken/work' })).toBeInTheDocument()

    client.controls.setReachable(true)
    await user.click(within(dialog).getByRole('button', { name: '移除 /home/kaken/work' }))
    await waitFor(() =>
      expect(within(dialog).queryByRole('button', { name: '移除 /home/kaken/work' })).not.toBeInTheDocument(),
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
    await user.click(screen.getByRole('button', { name: '登录 ChatGPT' }))
    const dialog = await screen.findByRole('dialog', { name: '在 Ubuntu Dev 上登录 ChatGPT' })
    expect(await within(dialog).findByText('BATON-1234')).toBeInTheDocument()
    expect(within(dialog).getByText(/15 分|14 分/)).toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: '打开登录页面' })).toHaveAttribute(
      'href',
      'https://auth.openai.com/codex/device',
    )
    expect(within(dialog).getByRole('link', { name: '打开登录页面' })).toHaveAttribute('target', '_blank')
    expect(within(dialog).getByRole('link', { name: '打开登录页面' })).toHaveAttribute('rel', 'noreferrer')
    await user.click(within(dialog).getByRole('button', { name: '复制验证码' }))
    expect(await within(dialog).findByText('代码已复制')).toBeInTheDocument()
    expect(await navigator.clipboard.readText()).toBe('BATON-1234')
    expect(within(dialog).queryByText('已登录')).not.toBeInTheDocument()
    act(() => client.controls.completeSubscriptionLogin('Ubuntu Dev', 'openai-codex'))
    expect(await within(dialog).findByText('已登录')).toBeInTheDocument()
    expect(within(dialog).queryByText('BATON-1234')).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: '完成' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(deviceRow('Ubuntu Dev')).toHaveFocus()
    expect(screen.getByRole('button', { name: '管理 ChatGPT' })).toBeInTheDocument()
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
    if (signedIn) {
      await user.click(screen.getByRole('button', { name: '管理 Claude' }))
      await user.click(await screen.findByRole('menuitem', { name: '重新登录' }))
    } else {
      await user.click(screen.getByRole('button', { name: '登录 Claude' }))
    }
    const dialog = await screen.findByRole('dialog', { name: '在 Ubuntu Dev 上设置 Claude' })
    expect(within(dialog).getByText('batond login anthropic')).toBeInTheDocument()
    expect(within(dialog).queryByText(/login-api-key/)).not.toBeInTheDocument()
    expect(within(dialog).queryByText('Getting sign-in code…')).not.toBeInTheDocument()
    expect(loginCalls).toBe(0)
    await user.click(within(dialog).getByRole('button', { name: signedIn ? '完成' : '关闭' }))
    expect(deviceRow('Ubuntu Dev')).toHaveFocus()
  })

  it('retries a subscription login after the device could not be reached', async () => {
    const user = userEvent.setup()
    const { client } = renderApp('/devices', 'error')
    await user.click(await screen.findByRole('button', { name: /^Ubuntu Dev/ }))
    client.controls.setReachable(false)
    await user.click(screen.getByRole('button', { name: '登录 ChatGPT' }))
    const dialog = await screen.findByRole('dialog', { name: '在 Ubuntu Dev 上登录 ChatGPT' })
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('无法开始登录')
    client.controls.setReachable(true)
    await user.click(within(dialog).getByRole('button', { name: '重新登录' }))
    expect(await within(dialog).findByText('BATON-1234')).toBeInTheDocument()
  })

  it('confirms an offline default device before saving it', async () => {
    const user = userEvent.setup()
    renderApp('/devices')
    await screen.findByRole('heading', { name: '3 台设备，2 台在线' })
    const row = deviceRow('Windows Desktop')
    await user.click(row)
    const details = document.getElementById(row.getAttribute('aria-controls') ?? '')
    expect(details).not.toBeNull()
    expect(within(details!).getByText('新对话将等待设备就绪。')).toBeInTheDocument()
    await user.click(within(details!).getByRole('button', { name: '设为默认' }))

    const dialog = await screen.findByRole('dialog', { name: '将 Windows Desktop 设为默认？' })
    await user.click(within(dialog).getByRole('button', { name: '保存默认设备' }))
    await waitFor(() => expect(within(deviceRow('Windows Desktop')).getByText('默认')).toBeInTheDocument())
    expect(within(deviceRow('MacBook Pro')).queryByText('默认')).not.toBeInTheDocument()
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
    expect(screen.queryByRole('group', { name: '需要处理' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign in to ChatGPT' })).not.toBeInTheDocument()
    expect(screen.queryByText('Finish setup on Ubuntu Dev')).not.toBeInTheDocument()
  })

  it('shows a syncing device in its row without agent details', async () => {
    const user = userEvent.setup()
    renderApp('/devices', 'waiting')
    const row = await screen.findByRole('button', { name: /^Windows Desktop/ })
    expect(within(row).getByText('正在同步…')).toBeInTheDocument()
    await user.click(row)
    const details = document.getElementById(row.getAttribute('aria-controls') ?? '')
    expect(details).not.toBeNull()
    expect(within(details!).queryByRole('group', { name: '需要处理' })).not.toBeInTheDocument()
    expect(within(details!).getByRole('button', { name: '断开设备' })).toBeInTheDocument()
  })

  it('allows reviewing command permission before subscription sign-in is repaired', async () => {
    const user = userEvent.setup()
    renderApp('/devices', 'error')
    await screen.findByRole('heading', { name: '3 台设备，2 台在线' })
    await user.click(deviceRow('Ubuntu Dev'))
    expect(screen.getAllByText('ChatGPT 登录已过期').length).toBeGreaterThan(0)
    expect(screen.getByRole('switch', { name: '允许项目助手运行命令' })).not.toBeChecked()
  })

  it('shows the saved command permission and keeps it when saving fails', async () => {
    const user = userEvent.setup()
    const { client } = renderApp('/devices')
    await screen.findByRole('heading', { name: '3 台设备，2 台在线' })
    await user.click(deviceRow('Ubuntu Dev'))
    const toggle = screen.getByRole('switch', { name: '允许项目助手运行命令' })
    expect(toggle).not.toBeChecked()

    await user.click(toggle)
    const confirm = await screen.findByRole('dialog', { name: '允许项目助手在 Ubuntu Dev 上运行命令？' })
    expect(within(confirm).getByText(/命令以 kaken 的身份直接运行/)).toBeInTheDocument()
    await user.click(within(confirm).getByRole('button', { name: '允许执行命令' }))
    expect(await screen.findByText('已保存')).toBeInTheDocument()
    expect(toggle).toBeChecked()

    client.controls.setReachable(false)
    await user.click(toggle)
    expect(await screen.findByText('保存失败，命令执行仍处于允许状态。')).toBeInTheDocument()
    expect(toggle).toBeChecked()
  })

  it('retries disconnecting the default device and asks for a replacement', async () => {
    const user = userEvent.setup()
    const { client } = renderApp('/devices')
    await screen.findByRole('heading', { name: '3 台设备，2 台在线' })
    await user.click(deviceRow('MacBook Pro'))
    await user.click(screen.getByRole('button', { name: '断开设备' }))
    const dialog = await screen.findByRole('dialog', { name: '断开“MacBook Pro”？' })
    expect(within(dialog).getByText(/请重新选择默认设备/)).toBeInTheDocument()

    client.controls.setReachable(false)
    await user.click(within(dialog).getByRole('button', { name: '断开设备' }))
    expect(await screen.findByRole('dialog', { name: '无法确认是否已断开' })).toBeInTheDocument()

    client.controls.setReachable(true)
    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('选择新的默认设备')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '2 台设备，1 台在线' })).toHaveFocus()

    await user.click(screen.getByRole('button', { name: '将 Ubuntu Dev 设为默认' }))
    await waitFor(() => expect(within(deviceRow('Ubuntu Dev')).getByText('默认')).toBeInTheDocument())
    expect(screen.queryByText('选择新的默认设备')).not.toBeInTheDocument()
  })

  it('moves the project assistant to another device when its device is removed', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/devices')
    await screen.findByRole('heading', { name: '3 台设备，2 台在线' })
    expect(within(deviceRow('Ubuntu Dev')).getByText('正在运行 Baton Dev')).toBeInTheDocument()
    await user.click(deviceRow('Ubuntu Dev'))
    await user.click(screen.getByRole('button', { name: '断开设备' }))
    const dialog = await screen.findByRole('dialog', { name: '断开“Ubuntu Dev”？' })
    expect(within(dialog).getByText('已运行的助手会继续在本机运行。')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: '断开设备' }))
    expect(await screen.findByText('Ubuntu Dev 已断开连接')).toBeInTheDocument()
    expect(within(deviceRow('MacBook Pro')).getByText('正在运行 Baton Dev')).toBeInTheDocument()

    await act(() => router.navigate({ to: '/projects/$projectId', params: { projectId: 'prj-baton' } }))
    expect(await screen.findByText('在 MacBook Pro 上运行')).toBeInTheDocument()
  })
})

describe('execution details', () => {
  it('retries the output read without replacing saved messages', async () => {
    let reads = 0
    renderApp('/threads?thread=thr-gateway', 'normal', (client) => {
      client.subscribeOutput = undefined
      client.readOutput = async (threadId) => {
        reads += 1
        if (reads === 1) throw new Error('unavailable')
        return { threadId, chunks: [] }
      }
    })
    const notice = await screen.findByText('无法读取实时输出')
    const before = reads
    await userEvent.setup().click(within(notice).getByRole('button', { name: '重试' }))
    await waitFor(() => expect(reads).toBeGreaterThan(before))
    expect(await screen.findByText(/did not reconnect within 30s/)).toBeInTheDocument()
  })
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
    const toggle = await screen.findByRole('button', { name: /运行 2 条命令，使用 1 个工具，写入 2 个文件/ })
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByText('无法加载执行过程')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '重试' }))
    await user.click(await screen.findByRole('button', { name: /pnpm --dir web build/ }))
    expect(screen.getByText(/✓ built in 1.84s/)).toBeInTheDocument()

    await user.click(toggle)
    expect(screen.queryByText('pnpm --dir web build')).not.toBeInTheDocument()
  })

  it('opens attachments that are online and copies the full commit SHA', async () => {
    const user = userEvent.setup()
    const { client } = renderApp('/threads?thread=thr-gateway')
    const detail = await screen.findByRole('complementary', { name: 'Fix gateway reconnect race' })
    const attachments = await within(detail).findByRole('list', { name: '附件' })
    expect(within(attachments).getByText('9b1e4d7a2c5f…')).toHaveAttribute(
      'title',
      '9b1e4d7a2c5f8e0b3d6a9c2f5e8b1d4a7c0e3f62',
    )

    await user.click(within(attachments).getByRole('button', { name: '复制提交 SHA' }))
    expect(await navigator.clipboard.readText()).toBe('9b1e4d7a2c5f8e0b3d6a9c2f5e8b1d4a7c0e3f62')
    expect(within(attachments).getByRole('button', { name: '已复制提交 SHA' })).toBeInTheDocument()

    act(() => client.controls.setDeviceConnection('dev-windows', 'offline'))
    expect(await within(attachments).findByText(/离线，不可用/)).toBeInTheDocument()
    expect(within(attachments).queryByRole('button', { name: '查看 windows-reconnect.log' })).not.toBeInTheDocument()

    await user.click(within(attachments).getByRole('button', { name: '查看 reconnect.log' }))
    const preview = await screen.findByRole('dialog', { name: 'logs/reconnect.log' })
    expect(await within(preview).findByRole('region', { name: 'reconnect.log 的内容' })).toHaveTextContent(
      /FAIL reconnects after sleep/,
    )
  })

  it('marks lost live output after the device reconnects', async () => {
    const { client } = renderApp('/threads?thread=thr-gateway', 'offline')
    const detail = await screen.findByRole('complementary', { name: 'Fix gateway reconnect race' })
    expect(await within(detail).findByText('连接已断开')).toBeInTheDocument()
    expect(within(detail).getByText(/后没有新报告/)).toBeInTheDocument()

    act(() => client.controls.setDeviceConnection('dev-ubuntu', 'online'))
    expect(await within(detail).findByText('较早的输出未保留')).toBeInTheDocument()
    expect(within(detail).getByLabelText('实时输出')).toHaveTextContent(/waiting for resume/)
  })

  it('keeps the live thread reply mounted when its saved message arrives', async () => {
    let saved = false
    let readIdle = false
    let releaseMessages: (() => void) | undefined
    const pendingMessages = new Promise<void>((resolve) => {
      releaseMessages = resolve
    })
    let notify: ((event: ChangeEvent) => void) | undefined
    renderApp('/threads?thread=thr-gateway', 'normal', (client) => {
      const list = client.listMessages.bind(client)
      const getThread = client.getThread.bind(client)
      client.getThread = async (id) => {
        const thread = await getThread(id)
        if (saved && id === 'thr-gateway') {
          readIdle = true
          return { ...thread, status: 'idle', runStartedAt: null }
        }
        return thread
      }
      client.listMessages = async (threadId) => {
        const messages = await list(threadId)
        if (saved && threadId === 'thr-gateway') await pendingMessages
        return saved && threadId === 'thr-gateway'
          ? [
              ...messages,
              {
                id: 'saved-live-reply',
                threadId,
                role: 'agent',
                sender: 'agent',
                body: 'Streaming reply',
                replyId: 'native-reply',
                workerTurnSeq: 7,
                createdAt: Date.now(),
                delivery: 'delivered',
                activity: null,
                attachments: [],
              },
            ]
          : messages
      }
      client.readOutput = async (threadId) => ({
        threadId,
        replyId: 'native-reply',
        workerTurnSeq: 7,
        chunks: [{ kind: 'gap' }, { kind: 'text', text: 'Streaming reply' }],
      })
      client.subscribeOutput = undefined
      client.subscribe = (listener) => {
        notify = listener
        return () => {
          notify = undefined
        }
      }
    })
    const live = await screen.findByText(
      (_, node) => node?.tagName === 'ARTICLE' && node.textContent?.includes('Streaming reply') === true,
    )
    expect(within(live).getByText('较早的输出未保留')).toBeInTheDocument()
    saved = true
    act(() => notify?.({ topics: ['messages'], target: { type: 'thread', id: 'thr-gateway' } }))
    await waitFor(() => expect(readIdle).toBe(true))
    await waitFor(() =>
      expect(screen.getByRole('complementary', { name: 'Fix gateway reconnect race' })).toHaveTextContent('空闲'),
    )
    expect(live).toBeInTheDocument()
    await act(async () => releaseMessages?.())
    await waitFor(() => expect(live).toHaveAttribute('id', 'message-saved-live-reply'))
    expect(live).toHaveTextContent('Streaming reply')
    expect(within(live).queryByText('较早的输出未保留')).not.toBeInTheDocument()
  })

  it('shows reported activity while a turn is still running', async () => {
    let reported = false
    renderApp('/threads?thread=thr-gateway', 'normal', (client) => {
      const getThread = client.getThread.bind(client)
      client.getThread = async (id) => ({ ...(await getThread(id)), runTurnSeq: 7 })
      client.readTurnTrace = async () =>
        reported
          ? {
              state: 'ready',
              messageId: 'turn',
              steps: [
                {
                  item_id: 'step',
                  type: 'command_execution',
                  status: 'completed',
                  ordinal: 1,
                  data: { input: 'pnpm verify', output: 'done' },
                  truncated: false,
                  original_bytes: 4,
                },
              ],
            }
          : { state: 'unavailable', messageId: 'turn', reason: 'missing' }
    })
    await screen.findByRole('complementary', { name: 'Fix gateway reconnect race' })
    expect(screen.queryByText('pnpm verify')).not.toBeInTheDocument()
    reported = true
    expect(await screen.findByText('pnpm verify', {}, { timeout: 4000 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /执行过程 · 1 个步骤/ })).toHaveAttribute('aria-expanded', 'true')
  })

  it('follows growing thread content only while the reader is at the bottom', async () => {
    const observers: { target?: Element; notify: () => void }[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private entry: { target?: Element; notify: () => void }
        constructor(callback: () => void) {
          this.entry = { notify: callback }
          observers.push(this.entry)
        }
        observe(target: Element) {
          this.entry.target = target
        }
        unobserve() {}
        disconnect() {}
      },
    )
    try {
      renderApp('/threads?thread=thr-gateway')
      const timeline = await screen.findByRole('region', { name: '消息记录' })
      await waitFor(() =>
        expect(observers.some((observer) => observer.target === timeline.firstElementChild)).toBe(true),
      )
      const observer = observers.find((value) => value.target === timeline.firstElementChild)!
      Object.defineProperties(timeline, {
        scrollHeight: { value: 1000, writable: true },
        clientHeight: { value: 200 },
      })
      timeline.scrollTop = 800
      fireEvent.scroll(timeline)
      timeline.scrollTop = 200
      fireEvent.scroll(timeline)
      act(() => observer.notify())
      expect(timeline.scrollTop).toBe(200)
      timeline.scrollTop = 800
      fireEvent.scroll(timeline)
      Object.defineProperty(timeline, 'scrollHeight', { value: 1200 })
      act(() => observer.notify())
      expect(timeline.scrollTop).toBe(1200)
      // 自动滚动的事件派发前内容又变高：读者没有向上滚动，继续跟随。
      Object.defineProperty(timeline, 'scrollHeight', { value: 1500 })
      fireEvent.scroll(timeline)
      act(() => observer.notify())
      expect(timeline.scrollTop).toBe(1500)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('browses folders in the file preview and explains files it cannot show', async () => {
    const user = userEvent.setup()
    renderApp('/threads?thread=thr-gateway', 'error')
    const detail = await screen.findByRole('complementary', { name: 'Fix gateway reconnect race' })
    await user.click(await within(detail).findByRole('button', { name: '查看 reconnect.log' }))
    const preview = await screen.findByRole('dialog', { name: 'logs/reconnect.log' })
    const folders = within(preview).getByRole('navigation', { name: '文件夹' })

    await user.click(await within(folders).findByRole('button', { name: /gateway-soak.log/ }))
    expect(await within(preview).findByText('已显示前 64 KB')).toBeInTheDocument()

    await user.click(within(folders).getByRole('button', { name: '上一级文件夹' }))
    await user.click(await within(folders).findByRole('button', { name: /^apps/ }))
    await user.click(await within(folders).findByRole('button', { name: /^server/ }))
    await user.click(await within(folders).findByRole('button', { name: /^src/ }))
    await user.click(await within(folders).findByRole('button', { name: /gateway\.test\.ts/ }))
    expect(await within(preview).findByText('无法读取文件')).toBeInTheDocument()
    await user.click(within(preview).getByRole('button', { name: '重试' }))
    expect(await within(preview).findByRole('region', { name: 'gateway.test.ts 的内容' })).toHaveTextContent(
      /test\('decodes WebSocket data'/,
    )

    await user.click(await within(folders).findByRole('button', { name: /^testing/ }))
    await user.click(await within(folders).findByRole('button', { name: /^data/ }))
    await user.click(await within(folders).findByRole('button', { name: /capture.bin/ }))
    expect(await within(preview).findByText(/二进制/)).toBeInTheDocument()
    expect(within(preview).queryByRole('region', { name: /的内容/ })).not.toBeInTheDocument()
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
    await screen.findByRole('heading', { name: 'Codex 未能完成此回复' })
    const detail = screen.getByRole('complementary', { name: 'Fix gateway reconnect race' })
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
    await user.click(await within(detail).findByRole('button', { name: '询问项目助手' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/projects/prj-baton'))
    const reference = await screen.findByRole('figure', { name: '引用：Fix gateway reconnect race' })
    expect(within(reference).getByText(/回复 1/)).toBeInTheDocument()
    const input = screen.getByLabelText('给项目助手发消息')
    expect(input).toHaveFocus()

    await user.click(within(reference).getByRole('button', { name: '移除引用' }))
    expect(screen.queryByRole('figure', { name: /Reference from/ })).not.toBeInTheDocument()
    expect(input).toHaveFocus()

    await act(() => router.navigate({ to: '/threads', search: { thread: 'thr-gateway' } }))
    const again = await screen.findByRole('complementary', { name: 'Fix gateway reconnect race' })
    select(await within(again).findByText(/did not reconnect within 30s/))
    await user.click(await within(again).findByRole('button', { name: '询问项目助手' }))
    await user.type(await screen.findByLabelText('给项目助手发消息'), 'Why only after sleep?{Enter}')
    await advance(scheduler, browserLatency.save + 100)
    expect(await screen.findByText('Why only after sleep?')).toBeInTheDocument()
    expect(screen.getAllByRole('figure', { name: '引用：Fix gateway reconnect race' })).toHaveLength(1)
  })

  it('copies a selection in a thread outside any project', async () => {
    const user = userEvent.setup()
    renderApp('/threads/thr-webui')
    select(await screen.findByText(/Scaffold is in place/))
    await user.click(await screen.findByRole('button', { name: '复制所选内容' }))
    expect(await screen.findByText('已复制')).toBeInTheDocument()
    expect(await navigator.clipboard.readText()).toMatch(/Scaffold is in place/)
  })
})
