import { createMemoryHistory } from '@tanstack/react-router'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { createHttpClient } from '../data/http/client'
import { App } from './App'
import { createAppRouter } from './router'

function requestURL(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input.toString()
}

function jsonBody(body: RequestInit['body']): string {
  if (typeof body !== 'string') throw new TypeError('Expected a JSON string request body')
  return body
}

const threadId = '74b66275-348c-4dd3-ae1d-7f3d21440f70'
const deviceId = '729f92e9-e68c-4a30-817a-0adb2da87b51'
const at = '2026-10-23T02:00:00Z'

class Socket {
  static current: Socket
  readyState = 1
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  send = vi.fn()
  constructor() {
    Socket.current = this
  }
  receive(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) })
  }
  close() {
    this.readyState = 3
  }
}

function mount(options: { existing?: boolean; resumePending?: boolean; status?: string; create?: boolean } = {}) {
  const state = {
    exists: options.existing ?? false,
    reason: 'Local sandbox needs setup.',
    thread: {
      id: threadId,
      node_id: deviceId,
      agent_type: 'cursor',
      model: '',
      working_directory: '/work',
      title: 'Remote Cursor chat',
      status: options.status ?? 'waiting_device',
      status_reason: '',
      created_at: at,
      last_activity_at: at,
      node_online: true,
      node_synced: true,
      opened_at: options.resumePending ? at : (null as string | null),
      resume_pending: options.resumePending ?? false,
      current_turn: null,
      pending_messages: [],
      failed_messages: [],
    },
    events: [] as { id: number; kind: string; created_at: string; payload: Record<string, unknown> }[],
  }
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(requestURL(input), 'https://baton.test')
    const path = url.pathname.replace('/api/v1', '')
    if (path === '/me')
      return Response.json({
        employee: { id: 'employee', username: 'dev', display_name: 'Dev', must_change_password: false },
        csrf_token: 'csrf',
      })
    if (path === '/nodes')
      return Response.json({
        nodes: [
          {
            id: deviceId,
            display_name: 'Desk',
            system: 'linux',
            online: true,
            synced: true,
            revocation_status: 'none',
            runtime_report: {
              agents: [
                {
                  agent_type: 'cursor',
                  version: '1.0.35',
                  status: options.create === false ? 'unverified' : 'available',
                  reason: state.reason,
                  models: [],
                  default_model: '',
                  capabilities: {
                    create: options.create !== false,
                    queue: true,
                    steer: false,
                    stop: true,
                    resume: true,
                    switch_model: false,
                  },
                },
              ],
              roots: [{ path: '/work' }],
            },
          },
        ],
        default_device: { node_id: deviceId },
      })
    if (path === '/threads' && init?.method !== 'POST')
      return Response.json({ threads: state.exists ? [state.thread] : [] })
    if (path === '/threads' && init?.method === 'POST') {
      state.exists = true
      const body = JSON.parse(jsonBody(init.body))
      state.events.push({
        id: 1,
        kind: 'message.accepted',
        created_at: at,
        payload: {
          id: 'message',
          thread_id: threadId,
          client_message_id: body.message.client_message_id,
          sender: 'employee',
          content: body.message.content,
          status: 'accepted',
          created_at: at,
        },
      })
      return Response.json(state.thread, { status: 202 })
    }
    if (path === `/threads/${threadId}`) return Response.json(state.thread)
    if (path === `/threads/${threadId}/timeline`) return Response.json({ events: state.events })
    if (path === `/threads/${threadId}/messages`) {
      const body = JSON.parse(jsonBody(init?.body))
      return Response.json(
        { id: 'follow-up', thread_id: threadId, ...body, sender: 'employee', status: 'accepted', created_at: at },
        { status: 202 },
      )
    }
    return Response.json({ code: 'not_implemented' }, { status: 501 })
  })
  const client = createHttpClient({
    fetch: fetcher,
    WebSocket: Socket as unknown as typeof WebSocket,
    pollInterval: 60_000,
  })
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [options.existing ? `/threads/${threadId}` : '/threads'] }),
  })
  render(<App client={client} router={router} />)
  return { state, fetcher }
}

beforeEach(() => localStorage.clear())

describe('remote Cursor threads', () => {
  it('creates, opens and sends over HTTP while Project and Inbox endpoints return 501', async () => {
    const user = userEvent.setup()
    const { state, fetcher } = mount()
    const input = await screen.findByLabelText('New chat message')
    expect(await screen.findByRole('button', { name: 'Cursor · Default model' })).toBeInTheDocument()
    expect(screen.getAllByText('Projects unavailable').length).toBeGreaterThan(0)
    await user.type(input, 'Inspect the repository')
    await user.click(within(input.parentElement!).getByRole('button', { name: 'Send' }))
    expect(await screen.findByRole('heading', { name: 'Remote Cursor chat' })).toBeInTheDocument()
    expect(await screen.findByText('Starting Cursor…')).toBeInTheDocument()
    expect(await screen.findByText('Inspect the repository')).toBeInTheDocument()
    const create = fetcher.mock.calls.find(
      ([url, init]) => requestURL(url) === '/api/v1/threads' && init?.method === 'POST',
    )!
    expect(JSON.parse(jsonBody(create[1]?.body))).toMatchObject({
      agent_type: 'cursor',
      model: '',
      working_directory: '/work',
    })
    state.thread.opened_at = at
    state.thread.status = 'idle'
    act(() => Socket.current.receive({ type: 'thread.changed', thread_id: threadId }))
    await waitFor(() => expect(screen.queryByText('Starting Cursor…')).not.toBeInTheDocument())
    const followUp = screen.getByLabelText('Message')
    await user.type(followUp, 'Continue')
    await user.click(within(followUp.parentElement!).getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(
          ([url, init]) => requestURL(url).endsWith(`/${threadId}/messages`) && init?.method === 'POST',
        ),
      ).toBe(true),
    )
  })

  it('keeps resume pending after reload until execution completion is reported', async () => {
    const { state } = mount({ existing: true, resumePending: true, status: 'stopped' })
    expect(await screen.findByRole('heading', { name: 'Remote Cursor chat' })).toBeInTheDocument()
    expect(await screen.findByText('Resuming Cursor…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Resume chat' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument()
    state.thread.status = 'idle'
    act(() => Socket.current.receive({ type: 'thread.changed', thread_id: threadId }))
    expect(await screen.findByText('Resuming Cursor…')).toBeInTheDocument()
    state.thread.resume_pending = false
    act(() => Socket.current.receive({ type: 'thread.changed', thread_id: threadId }))
    expect(await screen.findByLabelText('Message')).toBeInTheDocument()
    expect(screen.queryByText('Resuming Cursor…')).not.toBeInTheDocument()
  })

  it('explains an unverified Cursor and refuses creation', async () => {
    const user = userEvent.setup()
    const { fetcher } = mount({ create: false })
    await user.click(await screen.findByRole('button', { name: 'No agent' }))
    await user.click(await screen.findByRole('menuitem', { name: /Cursor.*Local sandbox needs setup/ }))
    expect(await screen.findByText('Local sandbox needs setup.')).toBeInTheDocument()
    await user.type(screen.getByLabelText('New chat message'), 'Hello')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(
      fetcher.mock.calls.some(([url, init]) => requestURL(url) === '/api/v1/threads' && init?.method === 'POST'),
    ).toBe(false)
  })
})
