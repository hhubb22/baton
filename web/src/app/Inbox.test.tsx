import { createMemoryHistory } from '@tanstack/react-router'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { ClientError } from '../data/client'
import { createMockClient } from '../data/mock/client'
import type { ScenarioId } from '../data/mock/scenarios'
import { manualScheduler } from '../data/mock/scheduler'
import { browserLatency } from '../data/mock/store'
import { App } from './App'
import { createAppRouter } from './router'

function setup(
  path = '/inbox',
  scenario: ScenarioId = 'normal',
  configure?: (client: ReturnType<typeof createMockClient>) => void,
) {
  const scheduler = manualScheduler()
  const client = createMockClient(scenario, { scheduler, latency: browserLatency })
  configure?.(client)
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) })
  render(<App client={client} router={router} />)
  return { client, router }
}

const pathsQuestion = 'Skip Windows path tests for now?'
const runnerQuestion = 'Which runner should run nightly?'
beforeEach(() => localStorage.clear())

describe('inbox decisions', () => {
  it('labels pending questions and identifies their source in the project conversation', async () => {
    setup('/projects/prj-compat')
    const linked = await screen.findByRole('region', { name: pathsQuestion })
    const projectQuestion = await screen.findByRole('region', { name: runnerQuestion })
    expect(within(linked).getByText('待回复')).toBeInTheDocument()
    expect(within(linked).getByRole('link', { name: 'Run compat suite on Windows' })).toBeInTheDocument()
    expect(within(projectQuestion).getByText('待回复')).toBeInTheDocument()
    expect(within(projectQuestion).queryByRole('img', { name: '待回复' })).not.toBeInTheDocument()
  })

  it('shows a reminder at ten questions and expands options beyond the first five', async () => {
    const user = userEvent.setup()
    setup('/inbox', 'normal', (client) => {
      const list = client.listInbox.bind(client)
      vi.spyOn(client, 'listInbox').mockImplementation(async () => {
        const items = await list()
        const question = items.find((item) => item.title === pathsQuestion)
        if (!question) throw new Error('Missing question fixture')
        const options = Array.from({ length: 7 }, (_, index) => `Choice ${index + 1}`)
        return [
          { ...question, options },
          ...Array.from({ length: 9 }, (_, index) => ({
            ...question,
            id: `extra-${index}`,
            title: `Question ${index}`,
            options: [],
          })),
        ]
      })
    })
    const card = await screen.findByRole('region', { name: pathsQuestion })
    expect(within(card).getByText(/此项目有 10 个待处理问题/)).toBeInTheDocument()
    expect(within(card).getByRole('radio', { name: /Choice 5/ })).toBeInTheDocument()
    expect(within(card).queryByRole('radio', { name: /Choice 6/ })).not.toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: '显示全部 7 个选项' }))
    await user.click(within(card).getByRole('radio', { name: /Choice 7/ }))
    expect(within(card).getByRole('radio', { name: /Choice 7/ })).toHaveAttribute('aria-checked', 'true')
    await user.click(within(card).getByRole('button', { name: '收起选项' }))
    expect(within(card).queryByRole('radio', { name: /Choice 7/ })).not.toBeInTheDocument()
  })

  it.each(['/projects/prj-compat', '/threads/thr-compat'])(
    'retries loading questions without losing the conversation at %s',
    async (path) => {
      const user = userEvent.setup()
      let failing = true
      setup(path, 'normal', (client) => {
        const list = client.listInbox.bind(client)
        vi.spyOn(client, 'listInbox').mockImplementation(() =>
          failing ? Promise.reject(new ClientError('unavailable', 'Could not load')) : list(),
        )
      })
      expect(await screen.findByText('无法加载问题')).toBeInTheDocument()
      const conversation = screen.getByRole('region', {
        name: path.startsWith('/projects') ? '对话' : '消息记录',
      })
      expect(conversation).toHaveTextContent(/Windows|Ubuntu/)
      expect(screen.queryByRole('region', { name: pathsQuestion })).not.toBeInTheDocument()
      failing = false
      await user.click(screen.getByRole('button', { name: '重试加载问题' }))
      expect(await screen.findByRole('region', { name: pathsQuestion })).toBeInTheDocument()
      expect(screen.queryByText('Could not load questions')).not.toBeInTheDocument()
    },
  )

  it('collapses details, shows newest first, and saves one answer across all three locations', async () => {
    const user = userEvent.setup()
    const { router, client } = setup()
    const cards = await screen.findAllByRole('region', { name: /\?$/ })
    expect(cards).toHaveLength(1)
    expect(cards[0]).toHaveAccessibleName(runnerQuestion)
    expect(screen.queryByText('2 tests fail only on Windows because of drive letters.')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: new RegExp(pathsQuestion.replace('?', '\\?')) }))
    const card = await screen.findByRole('region', { name: pathsQuestion })
    expect(screen.getByText('2 tests fail only on Windows because of drive letters.')).toBeInTheDocument()
    expect(document.title).toBe('(2) Baton')
    await user.click(within(card).getByRole('radio', { name: /Fix them before merging/ }))
    await user.type(within(card).getByLabelText('备注 （可选）'), 'Keep the regression tests.')
    await user.click(within(card).getByRole('button', { name: '发送回复' }))
    const recent = await screen.findByRole('region', { name: '最近的处理结果' })
    expect(await within(recent).findByText(/Fix them before merging · Keep the regression tests/)).toBeInTheDocument()
    await waitFor(() => expect(document.title).toBe('(1) Baton'))
    await act(() =>
      router.navigate({
        to: '/projects/$projectId',
        params: { projectId: 'prj-compat' },
        search: { thread: 'thr-compat' },
      }),
    )
    await waitFor(() => expect(screen.getAllByRole('region', { name: pathsQuestion })).toHaveLength(2))
    const shared = screen.getAllByRole('region', { name: pathsQuestion })
    for (const item of shared) {
      expect(within(item).getByText(/Keep the regression tests/)).toBeInTheDocument()
      expect(within(item).queryByRole('button', { name: '发送回复' })).not.toBeInTheDocument()
    }
    expect(
      (await client.listProjectEntries('prj-compat')).filter(
        (entry) => entry.kind === 'user' && entry.body.includes('itm-compat-paths'),
      ),
    ).toHaveLength(1)
  })

  it('keeps a shared draft on navigation and preserves the effective answer on conflict', async () => {
    const user = userEvent.setup()
    const { router } = setup('/inbox', 'conflict')
    await user.click(await screen.findByRole('button', { name: new RegExp(pathsQuestion.replace('?', '\\?')) }))
    const card = await screen.findByRole('region', { name: pathsQuestion })
    await user.click(within(card).getByRole('radio', { name: /Skip them and open a follow-up/ }))
    await user.type(within(card).getByLabelText('备注 （可选）'), 'Tomorrow')
    await act(() => router.navigate({ to: '/projects/$projectId', params: { projectId: 'prj-compat' } }))
    const inProject = await screen.findByRole('region', { name: pathsQuestion })
    expect(within(inProject).getByLabelText('备注 （可选）')).toHaveValue('Tomorrow')
    await act(() => router.navigate({ to: '/inbox' }))
    await user.click(await screen.findByRole('button', { name: new RegExp(pathsQuestion.replace('?', '\\?')) }))
    const again = await screen.findByRole('region', { name: pathsQuestion })
    await user.click(within(again).getByRole('button', { name: '发送回复' }))
    const result = await screen.findByRole('region', { name: '最近的处理结果' })
    expect(await within(result).findByRole('alert')).toHaveTextContent('Already answered: Fix them before merging')
    expect(within(result).getByText(/Fix them before merging · Kaken/)).toBeInTheDocument()
  })

  it('validates text replies, retains them on failure, and saves while paused', async () => {
    const user = userEvent.setup()
    const { client } = setup('/inbox', 'inboxPaused')
    const handleItem = vi.spyOn(client, 'handleItem')
    const card = await screen.findByRole('region', { name: 'What should the release notes mention?' })
    await user.click(within(card).getByRole('radio', { name: /其他…/ }))
    expect(within(card).queryByText('Up to 4 KB of text')).not.toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: '发送回复' }))
    expect(within(card).getByText('请选择一个选项或填写回复。')).toBeInTheDocument()
    fireEvent.change(within(card).getByLabelText('你的回复'), { target: { value: '界'.repeat(1366) } })
    await user.click(within(card).getByRole('button', { name: '发送回复' }))
    expect(within(card).getByText('回复超过 4 KB，请缩短后发送。')).toBeInTheDocument()
    expect(handleItem).not.toHaveBeenCalled()
    fireEvent.change(within(card).getByLabelText('你的回复'), { target: { value: '' } })
    await user.type(within(card).getByLabelText('你的回复'), 'Mention Windows support.')
    act(() => client.controls.setReachable(false))
    await user.click(within(card).getByRole('button', { name: '发送回复' }))
    expect(await within(card).findByText('无法发送，请重试。')).toBeInTheDocument()
    expect(within(card).getByLabelText('你的回复')).toHaveValue('Mention Windows support.')
    act(() => client.controls.setReachable(true))
    await user.click(within(card).getByRole('button', { name: '发送回复' }))
    const result = await screen.findByRole('region', { name: '最近的处理结果' })
    expect(await within(result).findByText('回复已保存 · 恢复项目后读取')).toBeInTheDocument()
  })

  it('shows a withdrawal that won while replying and keeps its reason in history', async () => {
    const user = userEvent.setup()
    const { router } = setup('/inbox', 'inboxWithdrawn')
    await user.click(await screen.findByRole('button', { name: new RegExp(pathsQuestion.replace('?', '\\?')) }))
    const card = await screen.findByRole('region', { name: pathsQuestion })
    await user.click(within(card).getByRole('button', { name: '关闭问题' }))
    const result = await screen.findByRole('region', { name: '最近的处理结果' })
    expect(await within(result).findByText(/^已撤回 ·/)).toBeInTheDocument()
    expect(within(result).getByText('A newer test run replaced this question.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '已处理' }))
    expect(router.state.location.search).toMatchObject({ handled: true })
    const history = await screen.findByRole('region', { name: pathsQuestion })
    expect(within(history).getByText('A newer test run replaced this question.')).toBeInTheDocument()
    expect(
      within(history).queryByText('2 tests fail only on Windows because of drive letters.'),
    ).not.toBeInTheDocument()
  })

  it('has no reply form for system notices and keeps retry available after closing the notice', async () => {
    const user = userEvent.setup()
    const { router, client } = setup('/inbox', 'error')
    const card = await screen.findByRole('region', { name: 'ChatGPT sign-in expired' })
    expect(within(card).queryByRole('textbox')).not.toBeInTheDocument()
    expect(within(card).queryByRole('radio', { name: /其他…/ })).not.toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: '关闭通知' }))
    // 场景的第一次保存失败，通知和入口保留。
    expect(await within(card).findByRole('alert')).toHaveTextContent('无法关闭提示，请重试。')
    await user.click(within(card).getByRole('button', { name: '关闭通知' }))
    const recent = await screen.findByRole('region', { name: '最近的处理结果' })
    expect(await within(recent).findByText(/^已关闭 ·/)).toBeInTheDocument()
    await act(() => router.navigate({ to: '/projects/$projectId', params: { projectId: 'prj-baton' } }))
    expect((await screen.findAllByText('需要处理')).length).toBeGreaterThan(0)
    act(() => client.controls.setDeviceConnection('dev-mac', 'online'))
    await user.click(await screen.findByRole('button', { name: '重试' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument())
    expect((await client.listProjects()).find((project) => project.id === 'prj-baton')?.agent.state).toBe('running')
    expect((await client.listInbox()).find((item) => item.id === 'itm-baton-signin')?.status).toBe('closed')
  })
})
