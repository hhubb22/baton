import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vite-plus/test'
import type { BatonClient } from './client'
import type { HttpContext } from './http/context'
import { createOutputAPI } from './http/output'
import { createMockClient } from './mock/client'
import {
  ClientProvider,
  useAddDeviceFolder,
  useDeviceFolders,
  useDevices,
  useFile,
  useFolders,
  useLiveOutput,
  useMessages,
  useRemoveDeviceFolder,
} from './queries'

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

describe('on-demand device reads', () => {
  function deviceReads() {
    const client = createMockClient('normal', { latency: { read: 0, save: 0, device: 0, run: 8000 } })
    let publish!: Parameters<BatonClient['subscribe']>[0]
    client.subscribe = (listener) => {
      publish = listener
      return () => {}
    }
    const readFile = vi.spyOn(client, 'readFile')
    const listFolders = vi.spyOn(client, 'listFolders')
    const listDeviceFolders = vi.spyOn(client, 'listDeviceFolders')
    const listDevices = vi.spyOn(client, 'listDevices')
    const listMessages = vi.spyOn(client, 'listMessages')
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ClientProvider client={client}>{children}</ClientProvider>
    )
    const useReads = () => ({
      file: useFile('dev-ubuntu', '/home/kaken/work/baton/logs/reconnect.log'),
      folder: useFolders('dev-ubuntu', '/home/kaken/work/baton'),
      roots: useFolders('dev-ubuntu', null),
      allowed: useDeviceFolders('dev-ubuntu', true),
      devices: useDevices(),
      messages: useMessages('thr-gateway'),
    })
    return {
      wrapper,
      useReads,
      readFile,
      listFolders,
      listDeviceFolders,
      listDevices,
      listMessages,
      publish: (topics: Parameters<typeof publish>[0]['topics']) => publish({ topics }),
    }
  }

  it('refreshes central lists on repeated subscription topics and reads devices only on explicit refetch', async () => {
    const f = deviceReads()
    const { result } = renderHook(f.useReads, { wrapper: f.wrapper })
    await waitFor(() => expect(Object.values(result.current).every((query) => query.isSuccess)).toBe(true))
    for (let round = 0; round < 3; round++) {
      await act(async () => {
        f.publish(['devices', 'files', 'projects', 'threads', 'messages', 'inbox', 'operations'])
      })
      await waitFor(() => expect(f.listDevices).toHaveBeenCalledTimes(round + 2))
      expect(f.listMessages).toHaveBeenCalledTimes(round + 2)
    }
    expect(f.readFile).toHaveBeenCalledTimes(1)
    expect(f.listFolders).toHaveBeenCalledTimes(2)
    expect(f.listDeviceFolders).toHaveBeenCalledTimes(1)
    await act(async () => {
      await Promise.all([
        result.current.file.refetch(),
        result.current.folder.refetch(),
        result.current.roots.refetch(),
        result.current.allowed.refetch(),
      ])
    })
    expect(f.readFile).toHaveBeenCalledTimes(2)
    expect(f.listFolders).toHaveBeenCalledTimes(4)
    expect(f.listDeviceFolders).toHaveBeenCalledTimes(2)
  })

  it.each(['add', 'remove'] as const)('refreshes device reads after an explicit folder %s', async (operation) => {
    const f = deviceReads()
    const { result } = renderHook(
      () => ({ reads: f.useReads(), add: useAddDeviceFolder(), remove: useRemoveDeviceFolder() }),
      { wrapper: f.wrapper },
    )
    await waitFor(() => expect(Object.values(result.current.reads).every((query) => query.isSuccess)).toBe(true))
    const path = operation === 'add' ? '/extra' : '/home/kaken/work'
    await act(async () => {
      await result.current[operation].mutateAsync({ deviceId: 'dev-ubuntu', path })
    })
    expect(f.readFile).toHaveBeenCalledTimes(2)
    expect(f.listFolders).toHaveBeenCalledTimes(4)
    expect(f.listDeviceFolders).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(result.current.reads.allowed.data?.includes(path)).toBe(operation === 'add'))
  })
})

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
