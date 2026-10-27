import { useQueries } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vite-plus/test'
import { ClientError, type BatonClient, type ChangeEvent } from './client'
import { createHttpClient } from './http/client'
import { ClientProvider, keys, useActivity, useMessages, useSession, useThread, useThreads } from './queries'
import { desktopActivitySnapshot } from './desktop-notifications'

class Socket {
  static current: Socket
  onmessage: ((event: { data: string }) => void) | null = null
  constructor() {
    Socket.current = this
  }
  close() {}
  receive(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) })
  }
}

const firstId = '37c40564-531a-4827-b3ee-02456a8a016d'
const secondId = '4399d7c3-ef4e-47d4-9b85-a0bb83577578'

function requestURL(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input.toString()
}

function wrapperFor(client: BatonClient) {
  return ({ children }: { children: ReactNode }) => <ClientProvider client={client}>{children}</ClientProvider>
}

describe('entity change notifications', () => {
  it('loads all-device activity independently of summary questions and refreshes it after reconnect and changes', async () => {
    let waiting = 1
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const path = new URL(requestURL(input), 'https://baton.test').pathname
      if (path === '/api/v1/me')
        return Response.json({ employee: { id: 'employee', display_name: 'Alice', must_change_password: false } })
      if (path === '/api/v1/nodes') return Response.json({ nodes: [], default_device: {} })
      if (path === '/api/v1/threads') return Response.json({ threads: [] })
      if (path === '/api/v1/activity')
        return Response.json({
          running_count: 2,
          waiting_count: waiting,
          waiting_threads: waiting ? [{ thread_id: firstId, title: 'x'.repeat(1000), project_id: secondId }] : [],
        })
      throw new Error(`Unexpected request: ${path}`)
    })
    const client = createHttpClient({ fetch, WebSocket: Socket as unknown as typeof WebSocket, pollInterval: 60000 })
    const { result, unmount } = renderHook(
      () => ({ session: useSession(), threads: useThreads(), activity: useActivity() }),
      { wrapper: wrapperFor(client) },
    )
    try {
      await waitFor(() => expect(result.current.activity.isSuccess && result.current.threads.isSuccess).toBe(true))
      expect(result.current.threads.data).toEqual([])
      expect(desktopActivitySnapshot(result.current.activity.data!)).toEqual({
        running: 2,
        waiting: 1,
        threads: [{ id: firstId, title: 'x'.repeat(512) }],
      })
      for (const change of [
        { type: 'ready' },
        { type: 'thread.changed', thread_id: firstId, change: 'detail' },
        { type: 'project.changed', project_id: secondId, change: 'detail' },
      ]) {
        waiting += 1
        act(() => Socket.current.receive(change))
        await waitFor(() => expect(result.current.activity.data?.waiting_count).toBe(waiting))
      }
    } finally {
      unmount()
    }
  })

  it('refreshes the changed thread summary and conversation without reading another thread detail or timeline', async () => {
    const revisions = new Map([
      [firstId, 1],
      [secondId, 1],
    ])
    const thread = (id: string) => ({
      id,
      title: `${id}: ${revisions.get(id)}`,
      node_id: 'desk',
      agent_type: 'cursor',
      model: 'auto',
      execution_timeout_seconds: 1800,
      working_directory: '/work',
      status: 'idle',
      status_reason: '',
      node_online: true,
      node_synced: true,
      created_at: '2026-10-27T00:00:00Z',
      last_activity_at: '2026-10-27T00:00:00Z',
    })
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const path = new URL(requestURL(input), 'https://baton.test').pathname
      if (path === '/api/v1/me')
        return Response.json({ employee: { id: 'employee', display_name: 'Alice', must_change_password: false } })
      if (path === '/api/v1/nodes') return Response.json({ nodes: [], default_device: {} })
      if (path === '/api/v1/threads') return Response.json({ threads: [thread(firstId), thread(secondId)] })
      const id = path.split('/')[4]
      if ([firstId, secondId].includes(id)) {
        if (path.endsWith('/timeline'))
          return Response.json({
            events: [
              {
                id: 1,
                kind: 'reply',
                created_at: '2026-10-27T00:00:00Z',
                payload: { event_id: 'reply', content: `Reply ${revisions.get(id)}`, worker_turn_seq: 1 },
              },
            ],
          })
        return Response.json(thread(id))
      }
      throw new Error(`Unexpected request: ${path}`)
    })
    const client = createHttpClient({ fetch, WebSocket: Socket as unknown as typeof WebSocket, pollInterval: 60000 })
    const { result, unmount } = renderHook(
      () => ({
        session: useSession(),
        threads: useThreads(),
        first: useThread(firstId),
        second: useThread(secondId),
        firstMessages: useMessages(firstId),
        secondMessages: useMessages(secondId),
      }),
      { wrapper: wrapperFor(client) },
    )
    try {
      await waitFor(() => expect(Object.values(result.current).every((query) => query.isSuccess)).toBe(true))
      fetch.mockClear()
      revisions.set(firstId, 2)
      act(() => Socket.current.receive({ type: 'thread.changed', thread_id: firstId, change: 'detail' }))
      await waitFor(() => {
        expect(result.current.first.data?.title).toBe(`${firstId}: 2`)
        expect(result.current.threads.data?.[0].title).toBe(`${firstId}: 2`)
        expect(result.current.firstMessages.data?.[0].body).toBe('Reply 2')
      })
      expect(result.current.threads.data?.[1].title).toBe(`${secondId}: 1`)
      expect(result.current.second.data?.title).toBe(`${secondId}: 1`)
      expect(result.current.secondMessages.data?.[0].body).toBe('Reply 1')
      const paths = fetch.mock.calls.map(([input]) => requestURL(input))
      expect(new Set(paths)).toEqual(
        new Set([`/api/v1/threads/${firstId}`, `/api/v1/threads/${firstId}/timeline?limit=100`]),
      )
      expect(paths.some((path) => path.includes(secondId))).toBe(false)

      revisions.set(secondId, 2)
      act(() => Socket.current.receive({ type: 'thread.changed' }))
      await waitFor(() => {
        expect(result.current.second.data?.title).toBe(`${secondId}: 2`)
        expect(result.current.secondMessages.data?.[0].body).toBe('Reply 2')
      })
    } finally {
      unmount()
    }
  })

  it('maps thread and project objects to their cached conversations, traces, output, memory and operations', async () => {
    let publish!: (event: ChangeEvent) => void
    const client = {
      subscribe: (listener: (event: ChangeEvent) => void) => {
        publish = listener
        return () => {}
      },
      getProject: vi.fn(async (id: string) => ({ id })),
    } as unknown as BatonClient
    const rows = [
      { queryKey: keys.threads, value: [] },
      { queryKey: keys.thread('one'), value: { id: 'one' } },
      { queryKey: keys.thread('two'), value: { id: 'two' } },
      { queryKey: keys.messages('one'), value: [{ id: 'reply-one', threadId: 'one' }] },
      { queryKey: keys.messages('two'), value: [{ id: 'reply-two', threadId: 'two' }] },
      { queryKey: keys.trace('reply-one'), value: {} },
      { queryKey: keys.trace('reply-two'), value: {} },
      { queryKey: keys.output('one'), value: {} },
      { queryKey: keys.output('two'), value: {} },
      { queryKey: keys.operation('op-one'), value: { kind: 'resumeThread', targetId: 'one' } },
      { queryKey: keys.operation('op-two'), value: { kind: 'resumeThread', targetId: 'two' } },
      { queryKey: keys.operation('send-one'), value: { kind: 'sendMessage', targetId: 'reply-one' } },
      { queryKey: keys.operation('send-two'), value: { kind: 'sendMessage', targetId: 'reply-two' } },
      { queryKey: keys.operation('op-item'), value: { kind: 'answerItem', targetId: 'item' } },
      { queryKey: keys.projects, value: [] },
      { queryKey: keys.projectEntries('project-one'), value: [] },
      { queryKey: keys.projectEntries('project-two'), value: [] },
      { queryKey: keys.projectMemory('project-one'), value: [] },
      { queryKey: keys.projectMemory('project-two'), value: [] },
      { queryKey: keys.memoryStatus('project-one'), value: {} },
      { queryKey: keys.memoryStatus('project-two'), value: {} },
      { queryKey: keys.memorySources('project-one', 'note', 1), value: [] },
      { queryKey: keys.memorySources('project-two', 'note', 1), value: [] },
      { queryKey: keys.inbox, value: [{ id: 'item', projectId: 'project-one' }] },
    ].map((row) => ({ ...row, queryFn: vi.fn(async () => row.value) }))
    const { result } = renderHook(() => useQueries({ queries: rows }), { wrapper: wrapperFor(client) })
    await waitFor(() => expect(result.current.every((query) => query.isSuccess)).toBe(true))
    for (const row of rows) row.queryFn.mockClear()
    const refreshed = () => rows.filter((row) => row.queryFn.mock.calls.length).map((row) => row.queryKey)

    await act(async () =>
      publish({ topics: ['threads', 'messages', 'operations'], target: { type: 'thread', id: 'one' } }),
    )
    expect(refreshed()).toEqual([
      keys.thread('one'),
      keys.messages('one'),
      keys.trace('reply-one'),
      keys.output('one'),
      keys.operation('op-one'),
      keys.operation('send-one'),
    ])
    for (const row of rows) row.queryFn.mockClear()
    await act(async () =>
      publish({ topics: ['projects', 'inbox', 'operations'], target: { type: 'project', id: 'project-one' } }),
    )
    expect(refreshed()).toEqual([
      keys.operation('op-item'),
      keys.projectEntries('project-one'),
      keys.projectMemory('project-one'),
      keys.memoryStatus('project-one'),
      keys.memorySources('project-one', 'note', 1),
      keys.inbox,
    ])
  })

  it.each(['thread', 'project'] as const)('patches a loaded %s list without an active detail query', async (type) => {
    let publish!: (event: ChangeEvent) => void
    const initial = [
      { id: 'one', status: 'active' },
      { id: 'two', status: 'active' },
    ]
    const list = vi.fn(async () => initial)
    const get = vi.fn(async (id: string) => ({ id, status: 'archived' }))
    const client = {
      subscribe: (listener: (event: ChangeEvent) => void) => {
        publish = listener
        return () => {}
      },
      getThread: get,
      getProject: get,
    } as unknown as BatonClient
    const listKey = type === 'thread' ? keys.threads : keys.projects
    const { result } = renderHook(() => useQueries({ queries: [{ queryKey: listKey, queryFn: list }] }), {
      wrapper: wrapperFor(client),
    })
    await waitFor(() => expect(result.current[0].isSuccess).toBe(true))
    const change = (id: string) => publish({ topics: [], target: { type, id } })
    act(() => change('one'))
    await waitFor(() => expect(result.current[0].data?.[0].status).toBe('archived'))
    expect(result.current[0].data?.[1]).toBe(initial[1])
    act(() => change('new'))
    await waitFor(() => expect(result.current[0].data?.map((item) => item.id)).toEqual(['one', 'two', 'new']))
    get.mockRejectedValueOnce(new ClientError('notFound', 'The object was removed.'))
    act(() => change('one'))
    await waitFor(() => expect(result.current[0].data?.map((item) => item.id)).toEqual(['two', 'new']))
    expect(get.mock.calls.map(([id]) => id)).toEqual(['one', 'new', 'one'])
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('refreshes connection-dependent topics on nodes.changed and rereads node status', async () => {
    let online = false
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
      Response.json(
        requestURL(input).endsWith('/me')
          ? { employee: { id: 'employee' } }
          : {
              nodes: [
                {
                  id: firstId,
                  display_name: 'Desk',
                  system: 'linux',
                  online,
                  synced: online,
                  revocation_status: 'none',
                },
              ],
              default_device: {},
            },
      ),
    )
    const client = createHttpClient({ fetch, WebSocket: Socket as unknown as typeof WebSocket })
    const listener = vi.fn()
    const unsubscribe = client.subscribe(listener)
    try {
      await client.getSession()
      expect((await client.listDevices())[0].connection).toBe('offline')
      online = true
      Socket.current.receive({ type: 'nodes.changed', node_id: firstId })
      expect(listener).toHaveBeenLastCalledWith({
        topics: ['devices', 'projects', 'threads', 'messages', 'inbox', 'operations', 'files'],
      })
      expect((await client.listDevices())[0].connection).toBe('online')
    } finally {
      unsubscribe()
    }
  })

  it.each(['thread', 'project'] as const)(
    'scopes %s detail events and falls back for missing IDs or unknown changes',
    async (type) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
        Response.json(
          requestURL(input).endsWith('/me') ? { employee: { id: 'employee' } } : { nodes: [], default_device: {} },
        ),
      )
      const client = createHttpClient({ fetch, WebSocket: Socket as unknown as typeof WebSocket })
      const listener = vi.fn()
      const unsubscribe = client.subscribe(listener)
      const topics = type === 'thread' ? ['threads', 'messages', 'operations'] : ['projects', 'inbox', 'operations']
      try {
        await client.getSession()
        Socket.current.receive({ type: `${type}.changed`, [`${type}_id`]: firstId, change: 'detail' })
        expect(listener).toHaveBeenLastCalledWith({ topics, target: { type, id: firstId } })
        for (const fields of [
          {},
          { change: 'detail' },
          { [`${type}_id`]: firstId },
          { [`${type}_id`]: firstId, change: 'future' },
          { [`${type}_id`]: '', change: 'detail' },
          { [`${type}_id`]: 'invalid', change: 'detail' },
        ]) {
          Socket.current.receive({ type: `${type}.changed`, ...fields })
          expect(listener).toHaveBeenLastCalledWith({ topics })
        }
      } finally {
        unsubscribe()
      }
    },
  )
})
