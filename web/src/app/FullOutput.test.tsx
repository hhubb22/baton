import { afterEach, expect, it, vi } from 'vite-plus/test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FullOutput } from './FullOutput'
import { createFullOutputReader } from '../data/http/full-output'
import { createTransport } from '../data/http/transport'
import type { FullOutputReference } from '../data/types'

const reference: FullOutputReference = {
  id: 'output-id',
  storage_generation: 'local-generation',
  total_bytes: 12298,
  expires_at: '2099-01-01T00:00:00.000Z',
}
afterEach(cleanup)

it('continues UTF-8 across pages while keeping only the current page in the view', async () => {
  const original = new TextEncoder().encode('a'.repeat(12287) + '🙂middle!')
  const reader = vi.fn(async (_threadId: string, ref: FullOutputReference, cursor = '0') => {
    const offset = Number(cursor)
    const bytes = original.slice(offset, Math.min(offset + 12288, original.length))
    const next = offset + bytes.length
    return {
      bytes,
      page: {
        output_id: ref.id,
        storage_generation: ref.storage_generation,
        offset,
        next_offset: next,
        total_bytes: original.length,
        expires_at: ref.expires_at,
        encoding: 'base64',
        data: '',
        done: next === original.length,
      },
    }
  })
  const validReader: typeof import('../data/http/full-output').readFullOutput = async (...args) => {
    const result = await reader(args[0], args[1], args[2])
    return { ...result, page: { ...result.page, encoding: 'base64' } }
  }
  const { container } = render(<FullOutput threadId="thread" reference={reference} reader={validReader} />)
  fireEvent.click(screen.getByRole('button', { name: '读取完整输出' }))
  await screen.findByRole('button', { name: '继续读取' })
  expect(container.querySelector('pre')?.textContent).toBe('a'.repeat(12287))
  fireEvent.click(screen.getByRole('button', { name: '继续读取' }))
  await screen.findByText('🙂middle!')
  expect(container.querySelector('pre')?.textContent).toBe('🙂middle!')
  expect(container.textContent).not.toContain('\uFFFD')
  expect(reader).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('button', { name: '下载此部分' })).toBeTruthy()
})

it('sends the saved identity and cursor and rejects a mismatched output page', async () => {
  const fetcher = vi.fn(async () =>
    Response.json({
      ok: true,
      session_id: 'thread',
      cursor: '12288',
      full_output: {
        output_id: 'wrong-output',
        storage_generation: reference.storage_generation,
        offset: 0,
        next_offset: 12288,
        total_bytes: reference.total_bytes,
        expires_at: reference.expires_at,
        encoding: 'base64',
        data: '',
        done: false,
      },
    }),
  )
  const read = createFullOutputReader(createTransport({ fetch: fetcher }).request)
  await expect(read('thread', reference)).rejects.toThrow('输出页面无效')
  const requested = fetcher.mock.calls[0]
  expect(requested).toBeDefined()
})

it('keeps an offline read retryable and displays its reason', async () => {
  const read = createFullOutputReader(
    createTransport({ fetch: async () => Response.json({ ok: false, session_id: 'thread', code: 'node_offline' }) })
      .request,
  )
  render(<FullOutput threadId="thread" reference={reference} reader={read} />)
  fireEvent.click(screen.getByRole('button', { name: '读取完整输出' }))
  expect(await screen.findByRole('status')).toHaveTextContent('设备已离线')
  expect(screen.getByRole('button', { name: '读取完整输出' })).toBeTruthy()
})
