import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskActions } from './ui/TaskActions.tsx'
import { TaskComposer } from './ui/TaskComposer.tsx'
import { TasksPage } from './ui/TasksPage.tsx'
import { TaskReferences } from './ui/TaskReferences.tsx'
import { previewQuery, readPendingTask, savePendingTask, type TaskRecord } from './tasks.ts'
import { deskId, listOf, node } from './test/fixtures.ts'

const task: TaskRecord = {
  task_id: '2fa604de-467d-4f5d-a005-545b653b6e9e', request_id: 'request-1', description: '检查服务', target_node_id: deskId,
  agent_type: 'pi', status: 'needs_verification', version: 4, accepted_at: '2026-10-19T01:00:00Z', updated_at: '2026-10-19T01:01:00Z',
  queue_expires_at: '2026-10-19T01:10:00Z', execution_timeout_seconds: 7200, delivery_status: 'uncertain', stop_outcome_known: false, device_names: [],
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('任务操作', () => {
  it('核实使用打开表单时的版本，冲突后刷新最新记录，不自动重提', async () => {
    const user = userEvent.setup()
    const refresh = vi.fn(async () => {})
    const fetch = vi.fn(async () => json({ code: 'conflict', message: '任务版本已变化', current_version: 5 }, 409))
    vi.stubGlobal('fetch', fetch)
    const props = { csrf: 'csrf', employeeID: 'alice', refresh, navigate: vi.fn() }
    const view = render(<TaskActions {...props} task={task} />)
    await user.click(screen.getByRole('button', { name: '人工核实' }))
    view.rerender(<TaskActions {...props} task={{ ...task, version: 5 }} />)
    await user.type(screen.getByLabelText('理由'), '现场检查')
    await user.type(screen.getByLabelText('结论摘要'), '没有副作用')
    await user.type(screen.getByLabelText('无证据原因'), '人工核对')
    await user.click(screen.getByRole('button', { name: '保存核实结论' }))
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toMatchObject({ expected_version: 4 })
    expect(refresh).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: '保存核实结论' })).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('查看最新记录')
  })

  it('待核实的新执行需要确认，响应丢失后只按原请求查询', async () => {
    const user = userEvent.setup()
    const navigate = vi.fn()
    const calls: { url: string; body?: RerunBody; method: string }[] = []
    type RerunBody = { request_id: string; confirm_side_effects: boolean }
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) as RerunBody : undefined })
      if (init.method === 'POST') throw new Error('响应丢失')
      return json({ tasks: [{ ...task, task_id: 'new-task' }] })
    }))
    render(<TaskActions task={task} csrf="csrf" employeeID="alice" refresh={vi.fn()} navigate={navigate} />)
    await user.click(screen.getByRole('button', { name: '发起新执行' }))
    await user.type(screen.getByLabelText('理由'), '明确再次检查')
    await user.click(screen.getByRole('button', { name: '确认发起新执行' }))
    expect(calls).toHaveLength(0)
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: '确认发起新执行' }))
    expect(calls[0]?.body?.confirm_side_effects).toBe(true)
    const requestID = calls[0]!.body!.request_id
    expect(readPendingTask('alice')?.requestID).toBe(requestID)
    await user.click(screen.getByRole('button', { name: '查询操作结果' }))
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET'])
    expect(calls[1]?.url).toContain(`request_id=${requestID}`)
    expect(navigate).toHaveBeenCalledWith('new-task')
    expect(readPendingTask('alice')).toBeNull()
  })

  it('提交确认丢失后刷新页面保留标识，查询失败不产生执行请求', async () => {
    savePendingTask('alice', { requestID: 'recover-this-request' })
    const fetch = vi.fn(async () => { throw new Error('断网') })
    vi.stubGlobal('fetch', fetch)
    render(<TaskComposer csrf="csrf" employeeID="alice" nodes={listOf([node({ id: deskId, display_name: 'Desk' })])} onAccepted={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: '查询原请求' }))
    expect(fetch).toHaveBeenCalledOnce()
    expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe('GET')
    expect(screen.getByRole('button', { name: '提交任务' })).toBeDisabled()
    expect(readPendingTask('alice')?.requestID).toBe('recover-this-request')
    expect(readPendingTask('bob')).toBeNull()
  })
})

it('离线、执行结果与交付待核实分别显示，查询失败保留记录', async () => {
  let fail = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    expect(init.method).toBe('GET')
    if (fail) throw new Error('断网')
    if (url.startsWith('/api/v1/inbox')) return json({ requests: [], open_count: 0 })
    if (url.includes('/events')) return json({ events: [] })
    if (url.includes('?')) return json({ tasks: [] })
    return json({ ...task, status: 'completed', summary: '<script>bad()</script>' })
  }))
  render(<TasksPage id={task.task_id} csrf="csrf" employeeID="alice" nodes={listOf([node({ id: deskId, display_name: 'Desk', online: false })])} navigate={vi.fn()} />)
  await screen.findByRole('heading', { name: '检查服务' })
  expect(within(screen.getByRole('region', { name: '节点连接' })).getByText('离线')).toBeInTheDocument()
  expect(within(screen.getByRole('region', { name: '执行状态' })).getByText('完成')).toBeInTheDocument()
  expect(screen.getByText('交付待核实')).toBeInTheDocument()
  expect(screen.getByText('<script>bad()</script>')).toBeInTheDocument()
  expect(document.querySelector('script')).toBeNull()
  await waitFor(() => expect(screen.queryByText('委托关系或操作记录暂时读取失败')).not.toBeInTheDocument())
  fail = true
  await userEvent.click(screen.getByRole('button', { name: '刷新任务记录' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('保留上次读取的记录')
  expect(screen.getByText('<script>bad()</script>')).toBeInTheDocument()
})

it('预览只读取 root 引用，输出按文本渲染并显示截短', async () => {
  const refs = [{ node_id: deskId, storage_ref: 'root:notes', resource_id: 'test.txt', access_status: 'available' }, { storage_ref: 'https://example.com', resource_id: '外链', access_status: 'unknown' }]
  expect(previewQuery(refs[1]!)).toBeNull()
  const fetch = vi.fn(async () => json({ kind: 'text', content: '<img src=x onerror=bad()>', truncated: true }))
  vi.stubGlobal('fetch', fetch)
  render(<TaskReferences title="证据" refs={refs} />)
  expect(screen.getAllByRole('button', { name: '预览' })).toHaveLength(1)
  await act(async () => { await userEvent.click(screen.getByRole('button', { name: '预览' })) })
  expect(screen.getByText('内容已截短。')).toBeInTheDocument()
  expect(document.querySelector('img')).toBeNull()
  expect(fetch).toHaveBeenCalledOnce()
})

it('未送达请求在刷新后可补全，重发认证失败保留同一标识', async () => {
  const user = userEvent.setup()
  savePendingTask('alice', { requestID: 'lost-before-server' })
  const bodies: { request_id: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as { request_id: string })
    return json({ code: 'unauthenticated', message: '请重新登录' }, 401)
  }))
  render(<TaskComposer csrf="csrf" employeeID="alice" nodes={listOf([node({ id: deskId, display_name: 'Desk' })])} onAccepted={vi.fn()} />)
  await user.click(screen.getByRole('button', { name: '补全原请求后重发' }))
  await user.type(screen.getByLabelText('任务说明'), '原任务说明')
  await user.click(screen.getByRole('button', { name: '提交原请求' }))
  expect(bodies).toEqual([{ ...bodies[0], request_id: 'lost-before-server' }])
  expect(readPendingTask('alice')?.requestID).toBe('lost-before-server')
  expect(await screen.findByRole('button', { name: '查询原请求' })).toBeEnabled()
})

it('未确认的新执行不阻止取消其他任务，重发认证错误仍保留原标识', async () => {
  savePendingTask('alice', { requestID: 'pending-rerun', originalTaskID: task.task_id })
  const user = userEvent.setup()
  const fetch = vi.fn(async () => json({ code: 'forbidden', message: '操作令牌失效' }, 403))
  vi.stubGlobal('fetch', fetch)
  render(<TaskActions task={task} csrf="csrf" employeeID="alice" refresh={vi.fn()} navigate={vi.fn()} />)
  expect(screen.getByRole('button', { name: '请求取消' })).toBeEnabled()
  await user.click(screen.getByRole('button', { name: '补全原新执行请求' }))
  await user.type(screen.getByLabelText('理由'), '原新执行理由')
  await user.click(screen.getByRole('checkbox'))
  await user.click(screen.getByRole('button', { name: '确认发起新执行' }))
  expect(readPendingTask('alice')?.requestID).toBe('pending-rerun')
  expect(fetch).toHaveBeenCalledOnce()
})

it('离开页面后旧提交响应不能清除另一个待确认请求或触发导航', async () => {
  let finish: (value: Response) => void = () => {}
  const response = new Promise<Response>((resolve) => { finish = resolve })
  vi.stubGlobal('fetch', vi.fn(() => response))
  const accepted = vi.fn()
  const user = userEvent.setup()
  const view = render(<TaskComposer csrf="csrf" employeeID="alice" nodes={null} onAccepted={accepted} />)
  await user.type(screen.getByLabelText('任务说明'), '慢响应 A')
  await user.click(screen.getByRole('button', { name: '提交任务' }))
  expect(readPendingTask('alice')).not.toBeNull()
  view.unmount()
  savePendingTask('alice', { requestID: 'pending-B' })
  await act(async () => { finish(json(task)); await response })
  expect(readPendingTask('alice')?.requestID).toBe('pending-B')
  expect(accepted).not.toHaveBeenCalled()
})

it('恢复新执行遭遇版本冲突时保留标识，刷新后可以重新补全', async () => {
  savePendingTask('alice', { requestID: 'recover-rerun', originalTaskID: task.task_id })
  const user = userEvent.setup()
  const refresh = vi.fn(async () => {})
  vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'conflict', message: '任务版本已变化', current_version: 5 }, 409)))
  const props = { csrf: 'csrf', employeeID: 'alice', refresh, navigate: vi.fn() }
  const view = render(<TaskActions {...props} task={task} />)
  await user.click(screen.getByRole('button', { name: '补全原新执行请求' }))
  await user.type(screen.getByLabelText('理由'), '再次检查')
  await user.click(screen.getByRole('checkbox'))
  await user.click(screen.getByRole('button', { name: '确认发起新执行' }))
  expect(refresh).toHaveBeenCalledOnce()
  expect(readPendingTask('alice')?.requestID).toBe('recover-rerun')
  expect(screen.queryByRole('button', { name: '确认发起新执行' })).not.toBeInTheDocument()
  view.rerender(<TaskActions {...props} task={{ ...task, version: 5 }} />)
  await user.click(screen.getByRole('button', { name: '补全原新执行请求' }))
  expect(screen.getByText(/版本 5/)).toBeInTheDocument()
})

it.each([undefined, 'original-project'])('跨 Project 补全待确认请求保留原归属 %s', async (projectID) => {
  savePendingTask('alice', { requestID: 'recover-project-task', projectID })
  let body: Record<string, unknown> = {}
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body)) as Record<string, unknown>
    return json(task)
  }))
  render(<TaskComposer csrf="csrf" employeeID="alice" nodes={listOf([])} projectID="current-project" onAccepted={vi.fn()} />)
  await userEvent.click(screen.getByRole('button', { name: '补全原请求后重发' }))
  await userEvent.type(screen.getByLabelText('任务说明'), '原来的任务说明')
  await userEvent.click(screen.getByRole('button', { name: '提交原请求' }))
  expect(body.request_id).toBe('recover-project-task')
  expect(body.project_id).toBe(projectID)
})
