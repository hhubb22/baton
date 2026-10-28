import { createMemoryHistory } from '@tanstack/react-router'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import type { ThreadTrace, ThreadTraceStep } from '@baton/protocol'
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

function mount(
  options: { existing?: boolean; resumePending?: boolean; status?: string; create?: boolean; offline?: boolean } = {},
) {
  const state = {
    exists: options.existing ?? false,
    reason: 'Local sandbox needs setup.',
    thread: {
      id: threadId,
      node_id: deviceId,
      agent_type: 'cursor',
      model: '',
      working_directory: '/work',
      title: 'Remote Cursor thread',
      status: options.status ?? 'waiting_device',
      status_reason: '',
      created_at: at,
      last_activity_at: at,
      node_online: !options.offline,
      node_synced: true,
      opened_at: options.resumePending ? at : (null as string | null),
      resume_pending: options.resumePending ?? false,
      current_turn: null,
      pending_messages: [],
      failed_messages: [],
    },
    traceSteps: [] as ThreadTraceStep[],
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
            online: !options.offline,
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
    if (path === `/threads/${threadId}/trace`)
      return Response.json({
        ok: true,
        page_cursor: url.searchParams.get('cursor') ?? 'snapshot:start',
        steps: state.traceSteps,
      } satisfies ThreadTrace)
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
  it.each([
    { reason: 'completed', replies: 2, count: 2 },
    { reason: 'failed', replies: 0, count: 1 },
    { reason: 'stopped', replies: 0, count: 1 },
    { reason: 'completed', replies: 0, count: 1 },
    { reason: 'completed', replies: 0, count: 0 },
    { reason: 'completed', replies: 1, count: 0 },
  ])(
    'opens one saved activity entry from an offline HTTP timeline: $reason, $replies replies, $count steps',
    async ({ reason, replies, count }) => {
      const user = userEvent.setup()
      const { state, fetcher } = mount({
        existing: true,
        status: reason === 'completed' ? 'idle' : 'stopped',
        offline: true,
      })
      state.thread.opened_at = at
      for (let index = 0; index < replies; index++)
        state.events.push({
          id: index + 1,
          kind: 'reply',
          created_at: at,
          payload: { event_id: `reply-${index}`, worker_turn_seq: 9, content: `Saved reply ${index}` },
        })
      state.events.push({
        id: 10,
        kind: 'turn.ended',
        created_at: at,
        payload: {
          worker_turn_seq: 9,
          reason,
          item_count: count,
          content: reason === 'failed' ? 'The command was interrupted.' : undefined,
        },
      })
      state.traceSteps = Array.from({ length: count }, (_, ordinal) => ({
        item_id: `item-${ordinal}`,
        type: 'command_execution',
        status: 'completed',
        ordinal,
        data: { input: `command-${ordinal}`, output: `Saved output ${ordinal}`, exitCode: 0 },
        truncated: false,
        original_bytes: 100,
      }))
      const detail = await screen.findByRole('region', { name: 'Messages' })
      await waitFor(() => expect(within(detail).queryByText('Loading messages…')).not.toBeInTheDocument())
      if (count === 0) {
        expect(within(detail).queryByRole('button', { name: /Activity/ })).not.toBeInTheDocument()
        return
      }
      const toggle = await within(detail).findByRole('button', {
        name: `Activity · ${count} ${count === 1 ? 'step' : 'steps'}`,
      })
      expect(within(detail).getAllByRole('button', { name: /Activity/ })).toHaveLength(1)
      if (replies > 0) {
        expect(within(detail).getByText('Saved reply 0')).toBeInTheDocument()
        expect(within(detail).getByText('Saved reply 1')).toBeInTheDocument()
      }
      if (reason === 'failed')
        expect(within(detail).getByText('Cursor could not finish this reply')).toBeInTheDocument()
      await user.click(toggle)
      expect(await within(detail).findByText('Saved output 0')).toBeInTheDocument()
      const requests = fetcher.mock.calls
        .map(([input]) => new URL(requestURL(input), 'https://baton.test'))
        .filter((url) => url.pathname.endsWith('/trace'))
      expect(requests).toHaveLength(1)
      expect(requests[0].searchParams.get('worker_turn_seq')).toBe('9')
    },
  )

  it('shows full-output reading after a reply mapped from the HTTP timeline', async () => {
    const { state } = mount({ existing: true, status: 'idle' })
    state.thread.opened_at = at
    state.events.push({
      id: 1,
      kind: 'reply',
      created_at: at,
      payload: {
        event_id: 'long-reply',
        content: 'Saved reply summary',
        metadata: {
          full_output: {
            id: '25689309-82b9-4cf7-8cba-7e84d7d30236',
            storage_generation: 'local-generation',
            total_bytes: 100000,
            expires_at: '2099-01-01T00:00:00.000Z',
          },
        },
      },
    })
    expect(await screen.findByText('Saved reply summary')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Read full output' })).toBeInTheDocument()
  })

  it('creates, opens and sends over HTTP while Project and Inbox endpoints return 501', async () => {
    const user = userEvent.setup()
    const { state, fetcher } = mount()
    const input = await screen.findByLabelText('New thread message')
    expect(await screen.findByRole('button', { name: 'Cursor · Default model' })).toBeInTheDocument()
    expect(screen.getAllByText('Projects unavailable').length).toBeGreaterThan(0)
    await user.type(input, 'Inspect the repository')
    await user.click(within(input.parentElement!).getByRole('button', { name: 'Send' }))
    expect(await screen.findByRole('heading', { name: 'Remote Cursor thread' })).toBeInTheDocument()
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

  it('keeps a manually entered model when composing and sends it in the create request', async () => {
    const user = userEvent.setup()
    const { fetcher } = mount()
    await user.click(await screen.findByRole('button', { name: 'Cursor · Default model' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Enter model ID…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Choose Cursor model' })
    await user.type(within(dialog).getByLabelText('Model ID'), '  custom-model  ')
    await user.click(within(dialog).getByRole('button', { name: 'Use model' }))
    expect(await screen.findByRole('button', { name: 'Cursor · custom-model' })).toBeInTheDocument()
    await user.type(screen.getByLabelText('New thread message'), 'Hello')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => {
      const request = fetcher.mock.calls.find(
        ([url, init]) => requestURL(url) === '/api/v1/threads' && init?.method === 'POST',
      )
      expect(JSON.parse(jsonBody(request?.[1]?.body))).toMatchObject({
        model: 'custom-model',
      })
      expect(JSON.parse(jsonBody(request?.[1]?.body))).not.toHaveProperty('execution_timeout_seconds')
    })
  })

  it('keeps resume pending after reload until execution completion is reported', async () => {
    const { state } = mount({ existing: true, resumePending: true, status: 'stopped' })
    expect(await screen.findByRole('heading', { name: 'Remote Cursor thread' })).toBeInTheDocument()
    expect(await screen.findByText('Resuming Cursor…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Resume thread' })).not.toBeInTheDocument()
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
    await user.type(screen.getByLabelText('New thread message'), 'Hello')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(
      fetcher.mock.calls.some(([url, init]) => requestURL(url) === '/api/v1/threads' && init?.method === 'POST'),
    ).toBe(false)
  })
})
