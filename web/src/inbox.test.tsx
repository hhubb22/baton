import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { AttentionCard } from './ui/AttentionCard.tsx'
import { InboxPage } from './ui/InboxPage.tsx'
import { Markdown } from './ui/Markdown.tsx'
import { ProjectQuote } from './ui/ProjectQuote.tsx'
import { TaskReferences } from './ui/TaskReferences.tsx'
import { NodeAvailability } from './node-availability.ts'
import { byteLength, projectQuote } from './project-quote.ts'
import { conversationItems } from './projects.ts'
import { deskId, listOf, node } from './test/fixtures.ts'
import type { AttentionRequest } from './inbox.ts'

const item: AttentionRequest = { id: 'a', project_id: 'p', project_title: '项目', conversation_id: 'c', origin_tool_call_id: 'call', source: 'agent', title: '是否继续', summary: '测试有一项失败', content: '**结果**\n\n| 检查 | 状态 |\n| - | - |\n| 重连 | 失败 |', options: [{ id: 'go', label: '继续调查', recommended: true }], allow_text: true, state: 'open', version: 1, created_at: '2026-10-19T00:00:00Z', updated_at: '2026-10-19T00:00:00Z' }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it('Markdown 支持表格、代码和 https，HTML、图片和其他协议不可执行', () => {
  const { container } = render(<Markdown content={'**加粗** *斜体* `代码`\n\n```js\nconst x = 1\n```\n\n- 列表\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n<script>bad()</script>\n\n<img src="https://example.org/a.png">\n\n![图片](https://example.org/image.png)\n\n[安全](https://example.org) [危险](http://example.org) [相对](/tasks) [脚本](javascript:bad)'} />)
  expect(container.querySelector('strong')).toHaveTextContent('加粗')
  expect(container.querySelector('table')).toBeTruthy()
  expect(container.querySelector('pre')).toHaveTextContent('const x = 1')
  expect(container.querySelector('script, img')).toBeNull()
  expect(screen.getAllByRole('link')).toHaveLength(1)
  expect(screen.getByRole('link', { name: '安全' })).toHaveAttribute('target', '_blank')
  expect(screen.queryByRole('link', { name: '危险' })).toBeNull()
})

it('选项和文字只在提交时发送，使用事项版本；冲突显示已生效的回答', async () => {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => init.method === 'POST' ? json({ current: { ...item, state: 'answered' } }, 409) : json({ ...item, state: 'answered', version: 2, resolution: { employee_id: 'alice', option_label: '另一台设备的选择', text: '已决定' } }))
  vi.stubGlobal('fetch', fetch)
  render(<AttentionCard item={item} csrf="csrf" />)
  await userEvent.click(screen.getByRole('radio'))
  await userEvent.type(screen.getByLabelText('补充说明'), '请检查日志')
  expect(fetch).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: '提交回答' }))
  expect(await screen.findByText('已回答：另一台设备的选择')).toBeInTheDocument()
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(JSON.parse(String(fetch.mock.calls[0]![1].body))).toMatchObject({ option_id: 'go', text: '请检查日志', expected_version: 1 })
  expect(screen.queryByRole('button', { name: '提交回答' })).toBeNull()
})

it('未知操作结果通过查询恢复，不自动重发；4 KiB 超限不能提交', async () => {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => { if (init.method === 'POST') throw new Error('lost'); return json({ ...item, state: 'closed', version: 2 }) })
  vi.stubGlobal('fetch', fetch)
  render(<AttentionCard item={item} csrf="csrf" />)
  await userEvent.click(screen.getByRole('button', { name: '关闭事项' }))
  expect(await screen.findByText('操作结果待确认，请查询后再操作。')).toBeVisible()
  expect(screen.getByRole('button', { name: '关闭事项' })).toBeDisabled()
  await userEvent.click(screen.getByRole('button', { name: '查询处理结果' }))
  expect(await screen.findByText('已关闭')).toBeVisible()
  expect(fetch.mock.calls.map((v) => v[1].method)).toEqual(['POST', 'GET'])
})

it('系统事项只有关闭和处理链接，解决后没有操作表单', () => {
  const system = { ...item, source: 'system' as const, options: [], allow_text: false, action_url: '/projects/p' }
  const view = render(<AttentionCard item={system} csrf="csrf" />)
  expect(screen.getByText(/由 Baton 创建/)).toBeVisible()
  expect(screen.getByRole('link', { name: '打开处理位置' })).toHaveAttribute('href', '/projects/p')
  expect(screen.getAllByRole('button')).toHaveLength(1)
  view.rerender(<AttentionCard item={{ ...system, state: 'resolved', version: 2 }} csrf="csrf" />)
  expect(screen.getAllByText(/已解决/).length).toBeGreaterThan(0)
  expect(screen.queryByRole('button')).toBeNull()
})

it('轮询更新事项状态；主对话通过 toolCall ID 定位卡片', async () => {
  vi.useFakeTimers()
  let value = item
  vi.stubGlobal('fetch', vi.fn(async () => json({ requests: value.state === 'open' ? [value] : [], open_count: value.state === 'open' ? 1 : 0 })))
  render(<InboxPage id="" csrf="csrf" askProject={vi.fn()} />)
  await act(async () => {})
  expect(within(screen.getByRole('region', { name: /^待处理$/ })).getByRole('article')).toBeVisible()
  value = { ...item, state: 'answered', version: 2 }
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(within(screen.getByRole('region', { name: /^待处理$/ })).queryByRole('article')).toBeNull()
  const parts = conversationItems({ seq: 1, kind: 'assistant', created_at: '', payload: { message: { content: [{ type: 'toolCall', name: 'inbox.ask', id: 'call', arguments: {} }] } } })
  expect(parts[0]?.attentionCallID).toBe('call')
})

it('10 KiB 引用按 UTF-8 截短，带来源和原长度，不切断 Unicode', () => {
  const text = '测'.repeat(3414)
  const quote = projectQuote(text, { taskID: 'task', attentionID: 'attention', field: 'summary' })
  expect(quote).toContain('原长度 10242 字节')
  expect(quote).toContain('任务 task；事项 attention；字段 summary')
  expect(byteLength(quote.split('> ')[1]!.trim())).toBeLessThanOrEqual(8192)
  expect(quote).not.toContain('�')
})

it('选中的文件文本带节点、路径和行号预填，不发送请求', async () => {
  const ask = vi.fn(), fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  render(<ProjectQuote projectID="p" source={{ taskID: 't', field: 'evidence', nodeID: deskId, path: 'root:proof/a.txt' }} askProject={ask}><pre>{'第一行\n第二行'}</pre></ProjectQuote>)
  const text = screen.getByText(/第一行/).firstChild!
  const range = document.createRange(); range.setStart(text, 4); range.setEnd(text, 7)
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
  await userEvent.click(screen.getByRole('button', { name: '问 Project Agent' }))
  expect(ask).toHaveBeenCalledWith('p', expect.stringContaining('行 2–2'))
  expect(ask.mock.calls[0]![1]).toContain('路径 root:proof/a.txt')
  expect(fetch).not.toHaveBeenCalled()
})

it('事项保留原结果，轮询修正时间后可读最新版本并返回原版', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ task_id: 't', version: 3, status: 'completed', summary: '最新结果' })))
  render(<AttentionCard item={{ ...item, task_id: 't', task_result_version: 2, task_result: { task_id: 't', target_node_id: deskId, version: 2, status: 'failed', summary: '原结果' }, latest_task_result_version: 3, latest_task_result_updated_at: '2026-10-19T01:00:00Z' }} csrf="csrf" />)
  expect(screen.getByText('原结果')).toBeVisible()
  expect(screen.getByText(/修正时间/)).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: '查看最新版本' }))
  expect(await screen.findByText('最新结果')).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: '查看原版本' }))
  expect(screen.getByText('原结果')).toBeVisible()
})

it('预览中节点离线立即移除旧内容；commit SHA 仍可复制', async () => {
  const sha = 'a'.repeat(40), writeText = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  vi.stubGlobal('fetch', vi.fn(async () => json({ content: '文件内容', kind: 'text' })))
  const refs = [{ node_id: deskId, storage_ref: 'root:proof', resource_id: 'a.txt', access_status: 'available' }, { node_id: deskId, storage_ref: 'git@example.org:repo.git', resource_id: sha, access_status: 'unknown' }]
  const view = render(<NodeAvailability value={listOf([node({ id: deskId, display_name: 'Desk', online: true })])}><TaskReferences title="产物" refs={refs} /></NodeAvailability>)
  expect(screen.getAllByRole('button', { name: '预览' })).toHaveLength(1)
  await userEvent.click(screen.getByRole('button', { name: '预览' }))
  expect(await screen.findByText('文件内容')).toBeVisible()
  view.rerender(<NodeAvailability value={listOf([node({ id: deskId, display_name: 'Desk', online: false })])}><TaskReferences title="产物" refs={refs} /></NodeAvailability>)
  expect(screen.queryByText('文件内容')).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: '预览' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('暂不可查看')
  await userEvent.click(screen.getByRole('button', { name: '复制 SHA' }))
  expect(writeText).toHaveBeenCalledWith(sha)
})

it('已处理栏先收到新版本、待处理栏迟到时，同一事项只显示一次且不回退', async () => {
  vi.useFakeTimers()
  let updated = false
  let releaseOpen!: (response: Response) => void
  const staleOpen = new Promise<Response>((resolve) => { releaseOpen = resolve })
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const open = new URL(url, 'https://baton.test').searchParams.get('state') === 'open'
    if (!updated) return json({ requests: open ? [item] : [], open_count: 1 })
    return open ? staleOpen : json({ requests: [{ ...item, state: 'answered', version: 2, resolution: { employee_id: 'alice', option_label: '继续调查' } }], open_count: 0 })
  }))
  render(<InboxPage id="" csrf="csrf" askProject={vi.fn()} />)
  await act(async () => {})
  expect(screen.getAllByRole('article', { name: '事项：是否继续' })).toHaveLength(1)
  updated = true
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(screen.getAllByRole('article', { name: '事项：是否继续' })).toHaveLength(1)
  expect(within(screen.getByRole('region', { name: /^待处理$/ })).queryByRole('article')).toBeNull()
  expect(within(screen.getByRole('region', { name: /^已处理$/ })).getByRole('article')).toHaveTextContent('已回答：继续调查')
  await act(async () => { releaseOpen(json({ requests: [item], open_count: 1 })); await staleOpen })
  expect(screen.getAllByRole('article', { name: '事项：是否继续' })).toHaveLength(1)
  expect(within(screen.getByRole('region', { name: /^待处理$/ })).queryByRole('article')).toBeNull()
})
