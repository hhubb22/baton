import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { TaskReferences } from './ui/TaskReferences.tsx'
import { deskId } from './test/fixtures.ts'

const refA = { node_id: deskId, storage_ref: 'root:notes', resource_id: 'a.txt', access_status: 'available' }
const refB = { ...refA, resource_id: 'b.txt' }
const content = (text: string) => new Response(JSON.stringify({ kind: 'text', content: text }))
const offline = () => new Response(JSON.stringify({ code: 'node_offline', message: '节点离线' }), { status: 503 })
function deferredResponse() {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((finish) => { resolve = finish })
  return { promise, resolve }
}
afterEach(() => vi.unstubAllGlobals())

it.each([
  { name: '替换引用', refs: [refB] },
  { name: '清空引用', refs: [] },
  { name: '移除引用字段', refs: undefined },
])('$name 后立即清除已显示的预览', async ({ refs }) => {
  vi.stubGlobal('fetch', vi.fn(async () => content('证据 A 内容')))
  const view = render(<TaskReferences title="证据" refs={[refA]} />)
  await userEvent.click(screen.getByRole('button', { name: '预览' }))
  expect(await screen.findByText('证据 A 内容')).toBeInTheDocument()

  view.rerender(<TaskReferences title="证据" refs={refs} />)
  expect(screen.queryByText('证据 A 内容')).not.toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: '预览内容' })).not.toBeInTheDocument()
})

it('轮询返回内容相同的新引用对象时保留预览', async () => {
  const fetch = vi.fn(async () => content('证据 A 内容'))
  vi.stubGlobal('fetch', fetch)
  const view = render(<TaskReferences title="证据" refs={[refA]} />)
  await userEvent.click(screen.getByRole('button', { name: '预览' }))
  expect(await screen.findByText('证据 A 内容')).toBeInTheDocument()

  view.rerender(<TaskReferences title="证据" refs={[{ access_status: 'available', resource_id: 'a.txt', storage_ref: 'root:notes', node_id: deskId }]} />)
  expect(screen.getByText('证据 A 内容')).toBeInTheDocument()
  expect(fetch).toHaveBeenCalledOnce()
})

it('引用清空后，旧请求返回也不再显示预览', async () => {
  const old = deferredResponse()
  vi.stubGlobal('fetch', vi.fn(() => old.promise))
  const view = render(<TaskReferences title="证据" refs={[refA]} />)
  await userEvent.click(screen.getByRole('button', { name: '预览' }))
  view.rerender(<TaskReferences title="证据" refs={[]} />)

  await act(async () => { old.resolve(content('过期的证据 A')); await old.promise })
  expect(screen.getByText('尚未记录。')).toBeInTheDocument()
  expect(screen.queryByText('过期的证据 A')).not.toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: '预览内容' })).not.toBeInTheDocument()
})

it.each([
  { name: '成功', response: () => content('过期的证据 A') },
  { name: '失败', response: offline },
])('新引用已经显示预览后，旧请求$name 不覆盖新预览', async ({ response }) => {
  const old = deferredResponse()
  const fetch = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValueOnce(content('证据 B 内容'))
  vi.stubGlobal('fetch', fetch)
  const view = render(<TaskReferences title="证据" refs={[refA]} />)
  await userEvent.click(screen.getByRole('button', { name: '预览' }))
  view.rerender(<TaskReferences title="证据" refs={[refB]} />)
  expect(screen.getByRole('button', { name: '预览' })).toBeEnabled()
  await userEvent.click(screen.getByRole('button', { name: '预览' }))
  expect(await screen.findByText('证据 B 内容')).toBeInTheDocument()

  await act(async () => { old.resolve(response()); await old.promise })
  expect(screen.getByText('证据 B 内容')).toBeInTheDocument()
  expect(screen.queryByText('过期的证据 A')).not.toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('旧请求结束不会解除新预览请求的等待状态', async () => {
  const old = deferredResponse(), current = deferredResponse()
  vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => old.promise).mockImplementationOnce(() => current.promise))
  const view = render(<TaskReferences title="证据" refs={[refA]} />)
  await userEvent.click(screen.getByRole('button', { name: '预览' }))
  view.rerender(<TaskReferences title="证据" refs={[refB]} />)
  expect(screen.getByRole('button', { name: '预览' })).toBeEnabled()
  await userEvent.click(screen.getByRole('button', { name: '预览' }))

  await act(async () => { old.resolve(content('过期的证据 A')); await old.promise })
  expect(screen.getByRole('button', { name: '预览' })).toBeDisabled()
  expect(screen.queryByText('过期的证据 A')).not.toBeInTheDocument()
  await act(async () => { current.resolve(content('证据 B 内容')); await current.promise })
  expect(screen.getByText('证据 B 内容')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '预览' })).toBeEnabled()
})

it('引用变化后清除旧错误提示', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => offline()))
  const view = render(<TaskReferences title="证据" refs={[refA]} />)
  await userEvent.click(screen.getByRole('button', { name: '预览' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('节点离线')

  view.rerender(<TaskReferences title="证据" refs={[refB]} />)
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '预览' })).toBeEnabled()
})
