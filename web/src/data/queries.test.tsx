import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vite-plus/test'
import type { BatonClient } from './client'
import type { HttpContext } from './http/context'
import { createOutputAPI } from './http/output'
import { ClientProvider, useLiveOutput, useMessages } from './queries'

function setup(request: HttpContext['request']) {
  const output = createOutputAPI(request)
  const listMessages = vi.fn(async () => [])
  const client = {
    subscribe: () => () => {},
    readOutput: (id: string) => output.readOutput(id),
    subscribeOutput: (id: string, listener: Parameters<typeof output.subscribeOutput>[1]) =>
      output.subscribeOutput(id, listener),
    listMessages,
  } as unknown as BatonClient
  const wrapper = ({ children }: { children: ReactNode }) => <ClientProvider client={client}>{children}</ClientProvider>
  return { output, client, wrapper, listMessages }
}

describe('live output queries', () => {
  it('updates only the output query on pushed frames and releases the subscription when disabled', async () => {
    const request = vi.fn()
    const { output, listMessages, wrapper } = setup(request)
    const send = vi.fn()
    output.setConnection(send)
    const { result, rerender, unmount } = renderHook(
      ({ id, enabled }) => ({ output: useLiveOutput(id, enabled), messages: useMessages(id) }),
      { wrapper, initialProps: { id: 'one', enabled: true } },
    )
    await waitFor(() => expect(result.current.output.data?.chunks).toEqual([]))
    act(() => {
      output.receive('one', { ok: true, state: 'running', text: 'first', cursor: 'epoch:5' })
      output.receive('one', { ok: true, state: 'running', text: 'next', cursor: 'epoch:9' })
    })
    await waitFor(() => expect(result.current.output.data?.chunks).toEqual([{ kind: 'text', text: 'firstnext' }]))
    expect(listMessages).toHaveBeenCalledTimes(1)
    expect(request).not.toHaveBeenCalled()
    rerender({ id: 'two', enabled: true })
    await waitFor(() => expect(result.current.output.data).toEqual({ threadId: 'two', chunks: [] }))
    act(() => output.receive('one', { ok: true, text: 'late', cursor: 'epoch:13' }))
    expect(result.current.output.data?.threadId).toBe('two')
    rerender({ id: 'two', enabled: false })
    expect(send).toHaveBeenLastCalledWith({ thread_id: '', cursor: undefined })
    unmount()
  })

  it('shows pushed output while an earlier HTTP read is still pending', async () => {
    let finish!: (value: unknown) => void
    const request = vi.fn().mockResolvedValueOnce({ status: 'running', current_turn: { worker_turn_seq: 1 } })
    request.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    const { output, wrapper } = setup(request)
    const { result } = renderHook(() => useLiveOutput('one', true), { wrapper })
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    act(() => {
      output.setConnection(vi.fn())
      output.receive('one', { ok: true, text: 'stream', cursor: 'epoch:6' })
    })
    await waitFor(() => expect(result.current.data?.chunks).toEqual([{ kind: 'text', text: 'stream' }]))
    await act(async () => finish({ ok: true, text: 'old HTTP output', cursor: 'epoch:15' }))
    expect(result.current.data?.chunks).toEqual([{ kind: 'text', text: 'stream' }])
    expect(request).toHaveBeenCalledTimes(2)
  })
})
