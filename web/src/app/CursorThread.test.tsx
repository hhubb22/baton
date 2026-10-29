import { createMemoryHistory } from '@tanstack/react-router'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import type { ThreadTrace, ThreadTraceStep } from '@baton/protocol'
import { createHttpClient } from '../data/http/client'
import { App } from './App'
import { createAppRouter } from './router'

const bodyRender = vi.hoisted(() => vi.fn())
vi.mock('./MessageBody', async (importOriginal) => {
  const original = await importOriginal<typeof import('./MessageBody')>()
  return {
    ...original,
    MessageBody: (props: Parameters<typeof original.MessageBody>[0]) => {
      bodyRender(props.body)
      return <original.MessageBody {...props} />
    },
  }
})

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
  options: {
    existing?: boolean
    resumePending?: boolean
    status?: string
    create?: boolean
    offline?: boolean
    delayDetail?: Promise<void>
  } = {},
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
      current_turn: null as null | { worker_turn_seq: number; started_at: string },
      pending_messages: [],
      failed_messages: [],
    },
    traceSteps: [] as ThreadTraceStep[],
    failTimeline: false,
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
    if (path === `/threads/${threadId}`) {
      await options.delayDetail
      return Response.json(state.thread)
    }
    if (path === `/threads/${threadId}/timeline`)
      return state.failTimeline
        ? Response.json({ code: 'unavailable' }, { status: 502 })
        : Response.json({ events: state.events })
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
  const mounted = render(<App client={client} router={router} />)
  return { state, fetcher, unmount: mounted.unmount }
}

beforeEach(() => localStorage.clear())

describe('remote Cursor threads', () => {
  it('shows the thread shell and list title while the detail loads', async () => {
    let release!: () => void
    const delayDetail = new Promise<void>((resolve) => {
      release = resolve
    })
    mount({ existing: true, delayDetail })
    expect(await screen.findByText('正在加载对话…')).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Remote Cursor thread' })).toBeInTheDocument()
    act(() => release())
    expect(await screen.findByRole('region', { name: '消息记录' })).toBeInTheDocument()
  })
  it('keeps saved content visible when a background refresh fails', async () => {
    const { state } = mount({ existing: true, status: 'idle' })
    state.thread.opened_at = at
    state.events.push({
      id: 1,
      kind: 'reply',
      created_at: at,
      payload: { event_id: 'saved', content: 'Saved response' },
    })
    expect(await screen.findByText('Saved response')).toBeInTheDocument()
    state.failTimeline = true
    act(() => Socket.current.receive({ type: 'thread.changed', thread_id: threadId, change: 'detail' }))
    expect(await screen.findByText(/更新失败，显示上次内容/)).toBeInTheDocument()
    expect(screen.getByText('Saved response')).toBeInTheDocument()
  })
  it.each([7, undefined])(
    'keeps a live reply through idle (sequence %s) until the matching saved reply arrives',
    async (sequence) => {
      const { state } = mount({ existing: true, status: 'running' })
      state.thread.opened_at = at
      state.thread.current_turn = { worker_turn_seq: 7, started_at: at }
      await screen.findByRole('region', { name: '消息记录' })
      act(() => Socket.current.receive({ type: 'ready' }))
      act(() =>
        Socket.current.receive({
          type: 'thread.output',
          thread_id: threadId,
          ok: true,
          cursor: 'epoch:4',
          worker_turn_seq: 7,
          reply_id: 'reply-a',
          text: 'Live answer',
          gap: false,
        }),
      )
      const article = await screen.findByText(
        (_, node) => node?.tagName === 'ARTICLE' && node.textContent?.includes('Live answer') === true,
      )
      act(() =>
        Socket.current.receive({
          type: 'thread.output',
          thread_id: threadId,
          ok: true,
          state: 'idle',
          worker_turn_seq: sequence,
          gap: false,
        }),
      )
      expect(article).toHaveTextContent('Live answer')
      state.thread.status = 'idle'
      state.thread.current_turn = null
      act(() => Socket.current.receive({ type: 'thread.changed', thread_id: threadId, change: 'detail' }))
      await screen.findByText('空闲')
      expect(article).toHaveTextContent('Live answer')
      state.events.push({
        id: 1,
        kind: 'reply',
        created_at: at,
        payload: { event_id: 'saved-a', worker_turn_seq: 7, content: 'Live answer', metadata: { reply_id: 'reply-a' } },
      })
      act(() => Socket.current.receive({ type: 'thread.changed', thread_id: threadId, change: 'detail' }))
      await waitFor(() => expect(article?.id).toContain('reply:'))
      expect(article).toHaveTextContent('Live answer')
    },
  )
  it('keeps a turn activity before its replies and preserves its expanded choice at completion', async () => {
    const user = userEvent.setup()
    const { state, fetcher } = mount({ existing: true, status: 'running' })
    state.thread.opened_at = at
    state.thread.current_turn = { worker_turn_seq: 9, started_at: at }
    state.events.push({
      id: 1,
      kind: 'reply',
      created_at: at,
      payload: { event_id: 'one', worker_turn_seq: 9, content: 'First answer' },
    })
    state.events.push({
      id: 2,
      kind: 'reply',
      created_at: at,
      payload: { event_id: 'two', worker_turn_seq: 9, content: 'Second answer' },
    })
    state.traceSteps.push({
      item_id: 'command',
      type: 'command_execution',
      status: 'completed',
      ordinal: 0,
      data: { input: 'echo ok', output: 'ok' },
      truncated: false,
      original_bytes: 7,
    })
    const toggle = await screen.findByRole('button', { name: /执行过程 · 1 个步骤/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    const traceReads = () => fetcher.mock.calls.filter(([url]) => requestURL(url).includes('/trace')).length
    const beforeEnd = traceReads()
    state.thread.status = 'idle'
    state.thread.current_turn = null
    state.events.push({
      id: 3,
      kind: 'turn.ended',
      created_at: at,
      payload: { worker_turn_seq: 9, reason: 'completed', item_count: 1 },
    })
    act(() => Socket.current.receive({ type: 'thread.changed', thread_id: threadId, change: 'detail' }))
    await screen.findByText('空闲')
    await waitFor(() => expect(traceReads()).toBeGreaterThan(beforeEnd))
    expect(screen.getByRole('button', { name: /执行过程 · 1 个步骤/ })).toBe(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(
      toggle.compareDocumentPosition(screen.getByText('First answer')) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      screen.getByText('First answer').compareDocumentPosition(screen.getByText('Second answer')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })
  it('keeps an activity summary when its turn has no saved step count', async () => {
    const { state } = mount({ existing: true, status: 'idle' })
    state.thread.opened_at = at
    state.events.push({
      id: 1,
      kind: 'reply',
      created_at: at,
      payload: {
        event_id: 'reply',
        worker_turn_seq: 9,
        content: 'Saved answer',
        metadata: { activity: { commands: 1, tools: 0, files: 0 } },
      },
    })
    expect(await screen.findByRole('button', { name: /运行 1 条命令/ })).toBeInTheDocument()
  })
  it('reopens a finished turn with replies before a later queued message', async () => {
    const open = () => {
      const mounted = mount({ existing: true, status: 'idle' })
      mounted.state.thread.opened_at = at
      mounted.state.events.push(
        { id: 1, kind: 'turn.started', created_at: at, payload: { worker_turn_seq: 9 } },
        {
          id: 2,
          kind: 'message.accepted',
          created_at: '2026-10-23T02:00:01Z',
          payload: {
            id: 'queued',
            thread_id: threadId,
            client_message_id: 'queued-client',
            sender: 'employee',
            content: 'Queued input',
            status: 'accepted',
            created_at: '2026-10-23T02:00:01Z',
          },
        },
        {
          id: 3,
          kind: 'reply',
          created_at: '2026-10-23T02:00:02Z',
          payload: { event_id: 'first', worker_turn_seq: 9, content: 'First answer' },
        },
        {
          id: 4,
          kind: 'reply',
          created_at: '2026-10-23T02:00:03Z',
          payload: { event_id: 'second', worker_turn_seq: 9, content: 'Second answer' },
        },
        {
          id: 5,
          kind: 'turn.ended',
          created_at: '2026-10-23T02:00:04Z',
          payload: { worker_turn_seq: 9, reason: 'completed', item_count: 0 },
        },
      )
      return mounted
    }
    const inspect = async () => {
      const timeline = await screen.findByRole('region', { name: '消息记录' })
      await within(timeline).findByText('Second answer')
      const text = timeline.textContent ?? ''
      expect(text.indexOf('First answer')).toBeLessThan(text.indexOf('Second answer'))
      expect(text.indexOf('Second answer')).toBeLessThan(text.indexOf('Queued input'))
    }
    const first = open()
    await inspect()
    first.unmount()
    open()
    await inspect()
  })
  it('keeps running when a reply is saved before its live output ends', async () => {
    const { state } = mount({ existing: true, status: 'running' })
    state.thread.opened_at = at
    state.thread.current_turn = { worker_turn_seq: 7, started_at: at }
    await screen.findByRole('region', { name: '消息记录' })
    act(() => Socket.current.receive({ type: 'ready' }))
    act(() =>
      Socket.current.receive({
        type: 'thread.output',
        thread_id: threadId,
        ok: true,
        cursor: 'epoch:4',
        worker_turn_seq: 7,
        reply_id: 'reply-a',
        text: 'Live answer',
        gap: false,
      }),
    )
    const article = await screen.findByText(
      (_, node) => node?.tagName === 'ARTICLE' && node.textContent?.includes('Live answer') === true,
    )
    state.events.push({
      id: 1,
      kind: 'reply',
      created_at: at,
      payload: { event_id: 'saved-a', worker_turn_seq: 7, content: 'Live answer', metadata: { reply_id: 'reply-a' } },
    })
    act(() => Socket.current.receive({ type: 'thread.changed', thread_id: threadId, change: 'detail' }))
    await waitFor(() => expect(article?.id).toContain('reply:'))
    expect(article).toHaveTextContent('Live answer')
  })
  it('does not keep an older live reply when a new turn starts', async () => {
    const { state } = mount({ existing: true, status: 'running' })
    state.thread.opened_at = at
    state.thread.current_turn = { worker_turn_seq: 7, started_at: at }
    const timeline = await screen.findByRole('region', { name: '消息记录' })
    act(() => Socket.current.receive({ type: 'ready' }))
    act(() =>
      Socket.current.receive({
        type: 'thread.output',
        thread_id: threadId,
        ok: true,
        cursor: 'epoch:4',
        worker_turn_seq: 7,
        reply_id: 'reply-a',
        text: 'Old live answer',
        gap: false,
      }),
    )
    await waitFor(() => expect(timeline).toHaveTextContent('Old live answer'))
    state.thread.current_turn = { worker_turn_seq: 8, started_at: at }
    act(() => Socket.current.receive({ type: 'thread.changed', thread_id: threadId, change: 'detail' }))
    await waitFor(() => expect(timeline).not.toHaveTextContent('Old live answer'))
  })
  it.each(['stopped', 'failed'])(
    'clears an unsaved live reply only after its %s turn end is in the timeline',
    async (reason) => {
      const { state } = mount({ existing: true, status: 'running' })
      state.thread.opened_at = at
      state.thread.current_turn = { worker_turn_seq: 7, started_at: at }
      state.events.push({ id: 1, kind: 'turn.started', created_at: at, payload: { worker_turn_seq: 7 } })
      const timeline = await screen.findByRole('region', { name: '消息记录' })
      act(() => Socket.current.receive({ type: 'ready' }))
      act(() =>
        Socket.current.receive({
          type: 'thread.output',
          thread_id: threadId,
          ok: true,
          cursor: 'epoch:4',
          worker_turn_seq: 7,
          reply_id: 'reply-a',
          text: 'Unsaved text',
          gap: false,
        }),
      )
      await waitFor(() => expect(timeline).toHaveTextContent('Unsaved text'))
      state.events.push({
        id: 2,
        kind: 'turn.ended',
        created_at: at,
        payload: { worker_turn_seq: 7, reason, item_count: 0 },
      })
      act(() => Socket.current.receive({ type: 'thread.changed', thread_id: threadId, change: 'detail' }))
      await waitFor(() => expect(timeline).toHaveTextContent('回复中断，内容未保存。'))
      expect(timeline).not.toHaveTextContent('Unsaved text')
    },
  )
  it('keeps saved message bodies rendered while editing the composer', async () => {
    const user = userEvent.setup()
    const { state } = mount({ existing: true, status: 'idle' })
    state.thread.opened_at = at
    state.events.push({
      id: 1,
      kind: 'reply',
      created_at: at,
      payload: { event_id: 'saved', content: 'Saved response' },
    })
    expect(await screen.findByText('Saved response')).toBeInTheDocument()
    const input = screen.getByLabelText('消息')
    bodyRender.mockClear()
    await user.type(input, 'Next question')
    expect(bodyRender.mock.calls.filter(([body]) => body === 'Saved response')).toHaveLength(0)
  })
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
      const detail = await screen.findByRole('region', { name: '消息记录' })
      await waitFor(() => expect(within(detail).queryByText('正在加载消息…')).not.toBeInTheDocument())
      if (count === 0) {
        expect(within(detail).queryByRole('button', { name: /执行过程/ })).not.toBeInTheDocument()
        return
      }
      const toggle = await within(detail).findByRole('button', {
        name: `执行过程 · ${count} 个步骤`,
      })
      expect(within(detail).getAllByRole('button', { name: /执行过程/ })).toHaveLength(1)
      if (replies > 0) {
        expect(within(detail).getByText('Saved reply 0')).toBeInTheDocument()
        expect(within(detail).getByText('Saved reply 1')).toBeInTheDocument()
      }
      if (reason === 'failed') expect(within(detail).getByText('Cursor 未能完成此回复')).toBeInTheDocument()
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
    expect(screen.getByRole('button', { name: '读取完整输出' })).toBeInTheDocument()
  })

  it('creates, opens and sends over HTTP while Project and Inbox endpoints return 501', async () => {
    const user = userEvent.setup()
    const { state, fetcher } = mount()
    const input = await screen.findByLabelText('新对话消息')
    expect(await screen.findByRole('button', { name: 'Cursor · 默认模型' })).toBeInTheDocument()
    expect(screen.getAllByText('无法加载项目').length).toBeGreaterThan(0)
    await user.type(input, 'Inspect the repository')
    await user.click(within(input.parentElement!).getByRole('button', { name: '发送' }))
    expect(await screen.findByRole('heading', { name: 'Remote Cursor thread' })).toBeInTheDocument()
    expect(await screen.findByText('正在启动 Cursor…')).toBeInTheDocument()
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
    await waitFor(() => expect(screen.queryByText('正在启动 Cursor…')).not.toBeInTheDocument())
    const followUp = screen.getByLabelText('消息')
    await user.type(followUp, 'Continue')
    await user.click(within(followUp.parentElement!).getByRole('button', { name: '发送' }))
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
    await user.click(await screen.findByRole('button', { name: 'Cursor · 默认模型' }))
    await user.click(await screen.findByRole('menuitem', { name: '输入模型 ID…' }))
    const dialog = await screen.findByRole('dialog', { name: '选择 Cursor 模型' })
    await user.type(within(dialog).getByLabelText('模型 ID'), '  custom-model  ')
    await user.click(within(dialog).getByRole('button', { name: '使用模型' }))
    expect(await screen.findByRole('button', { name: 'Cursor · custom-model' })).toBeInTheDocument()
    await user.type(screen.getByLabelText('新对话消息'), 'Hello')
    await user.click(screen.getByRole('button', { name: '发送' }))
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
    expect(await screen.findByText('正在恢复 Cursor…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Resume thread' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('消息')).not.toBeInTheDocument()
    state.thread.status = 'idle'
    act(() => Socket.current.receive({ type: 'thread.changed', thread_id: threadId }))
    expect(await screen.findByText('正在恢复 Cursor…')).toBeInTheDocument()
    state.thread.resume_pending = false
    act(() => Socket.current.receive({ type: 'thread.changed', thread_id: threadId }))
    expect(await screen.findByLabelText('消息')).toBeInTheDocument()
    expect(screen.queryByText('正在恢复 Cursor…')).not.toBeInTheDocument()
  })

  it('explains an unverified Cursor and refuses creation', async () => {
    const user = userEvent.setup()
    const { fetcher } = mount({ create: false })
    await user.click(await screen.findByRole('button', { name: '没有可用的助手' }))
    await user.click(await screen.findByRole('menuitem', { name: /Cursor.*Local sandbox needs setup/ }))
    expect(await screen.findByText('Local sandbox needs setup.')).toBeInTheDocument()
    await user.type(screen.getByLabelText('新对话消息'), 'Hello')
    await user.click(screen.getByRole('button', { name: '发送' }))
    expect(
      fetcher.mock.calls.some(([url, init]) => requestURL(url) === '/api/v1/threads' && init?.method === 'POST'),
    ).toBe(false)
  })
})
