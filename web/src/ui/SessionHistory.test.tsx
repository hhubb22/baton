import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionHistory } from './SessionHistory.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const page = (text: string, cursor: string, more = false, gap = false) => ({ ok: true, history: { entries: [{ text, reference: cursor, bytes: text.length, truncated: gap }], cursor, has_more: more, gap } })
const response = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)))

it('分页、断流补取与超大内容缺口保留，恶意文本不能成为 HTML', async () => {
  const fetch = vi.fn().mockImplementationOnce(() => response(page('<script>window.pwned=true</script>', 'one', true)))
    .mockImplementationOnce(() => response(page('超大内容', 'two', false, true)))
    .mockImplementationOnce(() => response(page('断开期间的记录', 'three')))
  vi.stubGlobal('fetch', fetch)
  const view = render(<SessionHistory sessionID="a" recovery={0} />)
  await screen.findByText('<script>window.pwned=true</script>')
  expect(view.container.querySelector('script')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '下一页历史' }))
  await screen.findByText('超大内容')
  expect(String(fetch.mock.calls[1]?.[0])).toContain('cursor=one')
  view.rerender(<SessionHistory sessionID="a" recovery={1} />)
  await screen.findByText('断开期间的记录')
  expect(String(fetch.mock.calls[2]?.[0])).toContain('cursor=two')
  expect(screen.getByText(/历史存在截断/)).toBeTruthy()
  expect(screen.queryByText('超大内容')).toBeNull()
})

it('离线和删除分别显示，查询失败保留已有页，迟到响应不覆盖新请求', async () => {
  let resolveOld: (value: Response) => void = () => {}
  const fetch = vi.fn().mockImplementationOnce(() => response(page('保留记录', 'one')))
    .mockImplementationOnce(() => response({ ok: false, code: 'node_offline' }))
    .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveOld = resolve }))
    .mockImplementationOnce(() => response({ ok: false, code: 'history_missing' }))
  vi.stubGlobal('fetch', fetch)
  const view = render(<SessionHistory sessionID="a" recovery={0} />)
  await screen.findByText('保留记录')
  view.rerender(<SessionHistory sessionID="a" recovery={1} />)
  await screen.findByText('节点离线，历史暂不可取回。')
  expect(screen.getByText('保留记录')).toBeTruthy()
  view.rerender(<SessionHistory sessionID="a" recovery={2} />)
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3))
  view.rerender(<SessionHistory sessionID="a" recovery={3} />)
  await screen.findByText('节点本地历史缺失或与原 Session 不匹配。')
  resolveOld(new Response(JSON.stringify(page('旧响应', 'old'))))
  await waitFor(() => expect(screen.queryByText('旧响应')).toBeNull())
})

it('后续空页更新末尾状态，同时保留已显示的正文', async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => response(page('保留记录', 'one', true)))
    .mockImplementationOnce(() => response({ ok: true, history: { entries: [], cursor: 'one', has_more: false, gap: false } })))
  render(<SessionHistory sessionID="a" recovery={0} />)
  await screen.findByText('保留记录')
  fireEvent.click(screen.getByRole('button', { name: '下一页历史' }))
  await screen.findByText('已到本次读取的历史末尾；新输出可能仍在写入。')
  expect(screen.getByText('保留记录')).toBeTruthy()
  expect((screen.getByRole('button', { name: '下一页历史' }) as HTMLButtonElement).disabled).toBe(true)
})
