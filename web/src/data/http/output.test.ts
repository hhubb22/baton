import { describe, expect, it, vi } from 'vite-plus/test'
import type { HttpContext } from './context'
import { createOutputAPI } from './output'

const running = { status: 'running', current_turn: { worker_turn_seq: 1 } }
const chunk = (text: string, cursor: string, gap = false) => ({ ok: true, state: 'running', text, cursor, gap })
const setup = () => {
  const request = vi.fn<(path: string) => Promise<unknown>>()
  const api = createOutputAPI(request as HttpContext['request'])
  const send = vi.fn()
  const listener = vi.fn()
  return { api, request, send, listener }
}

describe('live output subscription', () => {
  it('separates output from consecutive replies', async () => {
    const { api, send, listener } = setup()
    api.setConnection(send)
    api.subscribeOutput('one', listener)
    api.receive('one', { ...chunk('first', 'one:5'), reply_id: 'reply-one' })
    api.receive('one', { ...chunk('second', 'two:6'), reply_id: 'reply-two' })
    expect(await api.readOutput('one')).toEqual({
      threadId: 'one',
      replyId: 'reply-two',
      chunks: [{ kind: 'text', text: 'second' }],
    })
  })
  it('reads pushed output without HTTP and keeps each epoch separate', async () => {
    const { api, request, send, listener } = setup()
    api.setConnection(send)
    const stop = api.subscribeOutput('one', listener)
    expect(send).toHaveBeenLastCalledWith({ thread_id: 'one', cursor: undefined })
    api.receive('one', chunk('first', 'epoch:5'))
    api.receive('other', chunk('unrelated', 'other:9'))
    api.receive('one', chunk('last', 'epoch:9', true))
    expect((await api.readOutput('one')).chunks).toEqual([
      { kind: 'text', text: 'first' },
      { kind: 'gap' },
      { kind: 'text', text: 'last' },
    ])
    api.receive('one', chunk('next turn', 'next:9', true))
    expect((await api.readOutput('one')).chunks).toEqual([{ kind: 'gap' }, { kind: 'text', text: 'next turn' }])
    api.receive('one', { ok: true, state: 'idle' })
    expect((await api.readOutput('one')).chunks).toEqual([])
    expect(listener).toHaveBeenCalledTimes(5)
    expect(request).not.toHaveBeenCalled()
    stop()
    expect(send).toHaveBeenLastCalledWith({ thread_id: '', cursor: undefined })
  })

  it('continues from the last cursor through HTTP fallback and reconnection', async () => {
    const { api, request, send, listener } = setup()
    api.subscribeOutput('one', listener)
    api.setConnection(send)
    api.receive('one', chunk('first', 'epoch:5'))
    api.setConnection(null)
    request.mockResolvedValueOnce(running).mockResolvedValueOnce(chunk('next', 'epoch:9'))
    expect((await api.readOutput('one')).chunks).toEqual([{ kind: 'text', text: 'firstnext' }])
    expect(request).toHaveBeenLastCalledWith('/threads/one/output?cursor=epoch%3A5')
    api.setConnection(send)
    expect(send).toHaveBeenLastCalledWith({ thread_id: 'one', cursor: 'epoch:9' })
    api.receive('one', chunk('last', 'epoch:13'))
    expect((await api.readOutput('one')).chunks).toEqual([{ kind: 'text', text: 'firstnextlast' }])
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('switches subscriptions, ignores late output, and releases buffers after leaving', async () => {
    const { api, request, send, listener } = setup()
    api.setConnection(send)
    const stopOne = api.subscribeOutput('one', listener)
    api.receive('one', chunk('first', 'one:5'))
    const stopTwo = api.subscribeOutput('two', listener)
    expect(send).toHaveBeenLastCalledWith({ thread_id: 'two', cursor: undefined })
    api.receive('one', chunk('late', 'one:9'))
    api.receive('two', chunk('second', 'two:6'))
    expect((await api.readOutput('two')).chunks).toEqual([{ kind: 'text', text: 'second' }])
    stopTwo()
    expect(send).toHaveBeenLastCalledWith({ thread_id: 'one', cursor: 'one:5' })
    expect((await api.readOutput('one')).chunks).toEqual([{ kind: 'text', text: 'first' }])
    stopOne()
    api.receive('one', chunk('late', 'one:9'))
    api.subscribeOutput('one', listener)
    expect((await api.readOutput('one')).chunks).toEqual([])
    expect(request).not.toHaveBeenCalled()
  })

  it('surfaces device failures and recovers on a later output frame', async () => {
    const { api, send, listener } = setup()
    api.subscribeOutput('one', listener)
    api.setConnection(send)
    api.receive('one', { ok: false, code: 'node_offline' })
    await expect(api.readOutput('one')).rejects.toThrow('offline')
    api.receive('one', chunk('recovered', 'epoch:9'))
    expect((await api.readOutput('one')).chunks).toEqual([{ kind: 'text', text: 'recovered' }])
  })

  it('does not append an in-flight HTTP response after the socket takes over', async () => {
    const { api, request, send, listener } = setup()
    let finish!: (value: unknown) => void
    request.mockResolvedValueOnce(running).mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    const pending = api.readOutput('one')
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    api.subscribeOutput('one', listener)
    api.setConnection(send)
    api.receive('one', chunk('stream', 'epoch:6'))
    expect((await api.readOutput('one')).chunks).toEqual([{ kind: 'text', text: 'stream' }])
    finish(chunk('duplicate', 'epoch:9'))
    expect((await pending).chunks).toEqual([{ kind: 'text', text: 'stream' }])
    expect((await api.readOutput('one')).chunks).toEqual([{ kind: 'text', text: 'stream' }])
  })

  it('does not restore cleared output from an HTTP response after logout', async () => {
    const { api, request } = setup()
    let finish!: (value: unknown) => void
    request.mockResolvedValueOnce(running).mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    const pending = api.readOutput('one')
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    api.clear()
    finish(chunk('previous account', 'epoch:16'))
    expect((await pending).chunks).toEqual([])
  })
})
