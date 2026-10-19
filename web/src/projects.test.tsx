import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { ProjectsPage } from './ui/ProjectsPage.tsx'
import { conversationItems, type Project, type ProjectStatus } from './projects.ts'

const p: Project = { id: 'project-a', title: '跨设备工作', goal: '目标', status: 'active', version: 1, agent: { id: 'agent', provider: 'openai-codex', model: 'model' }, conversation: { id: 'conversation', state: 'active', last_seq: 0 } }
const props = { id: p.id, csrf: 'csrf', employeeID: 'alice', navigate: vi.fn(), navigateTask: vi.fn() }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
afterEach(() => vi.unstubAllGlobals())

function backend(options: { state?: ProjectStatus; fail?: boolean; revision?: number; conflict?: boolean } = {}) {
  const writes: { url: string; body: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (options.fail) throw new Error('offline')
    if (init.method !== 'GET') {
      writes.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> })
      if (url.includes('/memory/') && options.conflict) return json({ code: 'revision_conflict', message: '记忆版本已变化' }, 409)
      return json({ ok: true })
    }
    if (url === '/api/v1/nodes') return json({ nodes: [], default_device: {} })
    if (url.includes('/status')) return json(options.state ?? { state: 'waiting', waiting_reason: 'all_devices_offline', pending_inputs: 1, last_seq: 0 })
    if (url.includes('/events')) return json({ events: [], has_more: false, next_after_seq: 0 })
    if (url.includes('/messages')) return json({ messages: [] })
    if (url.includes('/memory')) return json({ entries: [{ id: 'memory', title: '约定', content: '旧内容', revision: options.revision ?? 1, author: 'user' }] })
    if (url.includes('/tasks')) return json({ tasks: [{ task_id: 'task-a', description: '验证服务', origin_conversation_id: 'conversation', status: 'running' }] })
    return json(p)
  }))
  return writes
}

it('离线时显示等待设备，仍能发送消息；任务来源和详情跳转可用', async () => {
  const writes = backend()
  render(<ProjectsPage {...props} />)
  await screen.findByRole('heading', { name: p.title })
  const status = screen.getByRole('region', { name: 'Project 运行状态' })
  expect(status).toHaveTextContent('所有设备离线')
  expect(status).not.toHaveTextContent('Project Agent 正在运行')
  await userEvent.type(screen.getByLabelText('发给 Project Agent 的消息'), '离线消息')
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }))
  expect(writes[0]?.body).toMatchObject({ content: '离线消息' })
  expect(writes[0]?.body.client_message_id).toBeTruthy()
  expect(await screen.findByRole('status')).toHaveTextContent('消息已保存在中心')
  expect(screen.getByText('由 Project Agent 发起')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('link', { name: '验证服务' }))
  expect(props.navigateTask).toHaveBeenCalledWith('task-a')
})

it('停止只调用 Project stop，设备与未确认退出事实分别显示', async () => {
  const options = { state: { state: 'running', pending_inputs: 0, last_seq: 0, run: { id: 'run', node_id: 'node', node_name: 'Mac', state: 'running', effective: true, placement_reason: 'default_offline' } } }
  const writes = backend(options)
  render(<ProjectsPage {...props} />)
  await screen.findByText('当前运行设备：Mac · node')
  expect(screen.getByText('默认设备离线，使用其他设备')).toBeInTheDocument()
  options.state = { ...options.state, state: 'idle', run: { ...options.state.run, effective: false } }
  await userEvent.click(screen.getByRole('button', { name: '停止当前运行' }))
  await screen.findByText(/实例已失去资格；进程退出尚未确认/)
  expect(writes.map((v) => v.url)).toEqual(['/api/v1/projects/project-a/stop'])
})

it('需要处理显示错误，重试不重发用户消息', async () => {
  const writes = backend({ state: { state: 'needs_attention', last_error: 'model_request_failed', pending_inputs: 0, last_seq: 0 } })
  render(<ProjectsPage {...props} />)
  await screen.findByText('最后的错误：model_request_failed')
  await userEvent.click(screen.getByRole('button', { name: '重试 Project Agent' }))
  expect(writes.map((v) => v.url)).toEqual(['/api/v1/projects/project-a/retry'])
  expect(await screen.findByRole('status')).toHaveTextContent('从原位置重试')
})

it('记忆修改保留打开时的版本，冲突后保留草稿并停止提交', async () => {
  const options = { revision: 1, conflict: true }
  const writes = backend(options)
  render(<ProjectsPage {...props} />)
  await screen.findByText('旧内容')
  await userEvent.click(screen.getByRole('button', { name: '修改记忆' }))
  const editor = within(screen.getByRole('region', { name: '项目记忆' }))
  const textarea = editor.getAllByLabelText('记忆内容')[0]!
  await userEvent.clear(textarea); await userEvent.type(textarea, '我的草稿')
  options.revision = 2
  await userEvent.click(screen.getByRole('button', { name: /^刷新 Project$/ }))
  await screen.findByText('记忆已有新版本。你的编辑仍基于版本 1。')
  await userEvent.click(editor.getAllByRole('button', { name: '保存记忆' })[0]!)
  expect(writes[0]?.body.expected_revision).toBe(1)
  expect(await screen.findByRole('alert')).toHaveTextContent('当前编辑内容已保留')
  expect(textarea).toHaveValue('我的草稿')
  expect(editor.getAllByRole('button', { name: '保存记忆' })[0]).toBeDisabled()
})

it('流式内容按文本显示，查询失败隐藏过时运行状态', async () => {
  const options = { state: { state: 'running', pending_inputs: 0, last_seq: 0, preview: { after_seq: 0, text: '<img src=x onerror=bad()>', truncated: false }, run: { id: 'run', node_id: 'node', node_name: 'Mac', state: 'running', effective: true, placement_reason: 'default_device' } }, fail: false }
  backend(options)
  render(<ProjectsPage {...props} />)
  await screen.findByText('<img src=x onerror=bad()>')
  expect(document.querySelector('img')).toBeNull()
  options.fail = true
  await userEvent.click(screen.getByRole('button', { name: /^刷新 Project$/ }))
  await screen.findByRole('alert')
  expect(screen.queryByRole('button', { name: '停止当前运行' })).not.toBeInTheDocument()
  expect(screen.getByText('运行状态暂不可用')).toBeInTheDocument()
})

it('切换 Project 后迟到响应不混入新对话', async () => {
  let release: (value: Response) => void = () => {}
  const old = new Promise<Response>((resolve) => { release = resolve })
  backend()
  const fetch = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => url === '/api/v1/projects/old' ? old : fetch(url, init)))
  const view = render(<ProjectsPage {...props} id="old" />)
  view.rerender(<ProjectsPage {...props} />)
  await screen.findByRole('heading', { name: p.title })
  await act(async () => release(json({ ...p, id: 'old', title: '旧项目' })))
  await waitFor(() => expect(screen.queryByText('旧项目')).not.toBeInTheDocument())
})

it('输入、工具和未知内容提取不会执行 HTML', () => {
  const event = { seq: 1, kind: 'input', created_at: '', payload: { message: { content: [{ type: 'text', text: JSON.stringify([{ source_type: 'user_message', payload: { content: '正文' } }]) }] } } }
  expect(conversationItems(event)).toEqual([{ label: '你', text: '正文' }])
  expect(conversationItems({ ...event, kind: 'assistant', payload: { message: { content: [{ type: 'toolCall', name: 'tasks.dispatch', arguments: { description: '任务' } }] } } })[0]?.label).toBe('工具调用')
})

it('按事件序号继续读取分页，保存后的回复取代同序号预览', async () => {
  backend()
  const originalFetch = globalThis.fetch
  let complete = false
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
    if (url.includes('/events')) {
      const seq = url.includes('after_seq=0') ? 1 : 2
      return Promise.resolve(json({ events: [{ seq, kind: 'assistant', created_at: '', payload: { message: { content: [{ type: 'text', text: `正式回复${seq}` }] } } }], next_after_seq: seq, has_more: seq === 1 }))
    }
    if (url.includes('/status')) return Promise.resolve(json({ state: 'running', pending_inputs: 0, last_seq: complete ? 2 : 1, run: { effective: true }, preview: { after_seq: 1, text: '旧预览' } }))
    return originalFetch(url, init)
  }))
  render(<ProjectsPage {...props} />)
  await screen.findByText('正式回复1')
  expect(screen.queryByText('旧预览')).not.toBeInTheDocument()
  complete = true
  await userEvent.click(screen.getByRole('button', { name: '继续读取对话' }))
  await screen.findByText('正式回复2')
  expect(screen.getAllByText('正式回复1')).toHaveLength(1)
  expect(screen.queryByText('旧预览')).not.toBeInTheDocument()
})


it('暂停的 Project 复用任务表单，默认设备和验证方式可选', async () => {
  const writes = backend({ state: { state: 'paused', pending_inputs: 0, last_seq: 0 } })
  render(<ProjectsPage {...props} />)
  await screen.findByRole('heading', { name: p.title })
  await userEvent.click(screen.getByText('直接派发任务', { exact: true }))
  await userEvent.type(screen.getByLabelText('任务说明'), '用户直接控制任务')
  await userEvent.type(screen.getByLabelText('期望产物与验证方式'), '运行集成测试并检查结果')
  await userEvent.click(screen.getByRole('button', { name: '提交任务' }))
  expect(writes[0]?.url).toBe('/api/v1/tasks')
  expect(writes[0]?.body).toMatchObject({ project_id: p.id, description: '用户直接控制任务', expected_outputs: '运行集成测试并检查结果' })
  expect(writes[0]?.body.target_node_id).toBeUndefined()
  expect(writes[0]?.body.agent_type).toBeUndefined()
  expect(writes[0]?.body.working_directory).toBeUndefined()
})
