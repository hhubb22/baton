import { describe, expect, it, vi } from 'vitest'
import { ClientError } from '../client'
import type { Device, OperationPhase } from '../types'
import type { HttpContext } from './context'
import { createThreadAPI } from './threads'
import { createTransport, HttpError } from './transport'

const threadId = '74b66275-348c-4dd3-ae1d-7f3d21440f70'
const deviceId = '729f92e9-e68c-4a30-817a-0adb2da87b51'
const messageId = 'c6559d72-c581-4f4d-bef0-3f80724d1856'
const at = '2026-10-23T02:00:00Z'
const later = '2026-10-23T02:01:00Z'
const thread = (overrides: Record<string, unknown> = {}) => ({
  id: threadId,
  node_id: deviceId,
  agent_type: 'codex',
  model: 'reported-model',
  working_directory: '/work/baton',
  status: 'idle',
  status_reason: '',
  created_at: at,
  last_activity_at: later,
  node_online: true,
  node_synced: true,
  opened_at: at,
  native_session_id: 'native-session',
  current_turn: null,
  pending_messages: [],
  failed_messages: [],
  ...overrides,
})
const message = (overrides: Record<string, unknown> = {}) => ({
  id: messageId,
  thread_id: threadId,
  client_message_id: 'client-message',
  sender: 'employee',
  content: 'Inspect this repository',
  status: 'accepted',
  status_reason: '',
  created_at: at,
  ...overrides,
})
const event = (id: number, kind: string, payload: Record<string, unknown>, created_at = at) => ({
  id,
  kind,
  payload,
  created_at,
})
const accepted = () => event(1, 'message.accepted', message())
const device = (connection: Device['connection'] = 'online'): Device => ({
  id: deviceId,
  name: 'Device',
  os: 'Linux',
  system: 'Linux',
  batondVersion: '1',
  connection,
  lastSeenAt: 0,
  registeredAt: 0,
  agents: [
    {
      kind: 'codex',
      version: '1',
      models: ['reported-model', 'second-model'],
      defaultModel: 'reported-model',
      abilities: { queue: true, steer: true, stop: true, resume: true, switchModel: true },
      account: 'ChatGPT',
      problem: null,
    },
  ],
  subscriptions: [],
  hasRuntime: false,
  folders: ['/work'],
  repos: [],
  commandAccess: { enabled: false, shell: '/bin/sh', user: 'user' },
})
type Handler = (url: URL, init: RequestInit) => unknown | Promise<unknown>
function setup(handler: Handler, devices: Device[] = [device()]) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'https://baton.test')
    const result = url.pathname === '/api/v1/me' ? { csrf_token: 'csrf' } : await handler(url, init ?? {})
    if (result instanceof Response) return result
    if (result === undefined) throw new Error(`Unexpected request: ${url.pathname}${url.search}`)
    return Response.json(result)
  })
  const refreshes = new Map<string, () => Promise<{ phase: OperationPhase; detail?: string | null }>>()
  const transport = createTransport({ fetch: fetcher })
  const ctx: HttpContext = {
    request: transport.request,
    emit: vi.fn(),
    devices: vi.fn(async () => devices),
    operation: (kind, targetId, phase, detail = null, refresh) => {
      const id = `operation-${refreshes.size}`
      if (refresh) refreshes.set(id, refresh)
      return { id, kind, targetId, phase, detail, updatedAt: 0 }
    },
  }
  return { api: createThreadAPI(ctx), ctx, fetcher, refreshes }
}
const rootResponse = { kind: 'roots', roots: [{ id: 'root-id', path: '/work' }], truncated: false }

describe('HTTP thread contracts', () => {
  it('reads every thread and timeline page and keeps unconfirmed stop/archive pending', async () => {
    const secondId = '0d28bd24-30ed-419b-8bf3-9b783b9be9ba'
    const { api, fetcher } = setup((url) => {
      if (url.pathname === '/api/v1/threads')
        return url.searchParams.has('cursor')
          ? { threads: [thread({ id: secondId })] }
          : { threads: [thread()], next_cursor: 'next/+' }
      if (url.pathname.endsWith('/timeline'))
        return url.searchParams.has('cursor')
          ? { events: [event(2, 'stop.requested', {})] }
          : { events: [accepted()], next_cursor: '1' }
      return thread({
        id: url.pathname.split('/').at(-1),
        status: 'running',
        stop_requested_at: later,
        archive_requested_at: url.pathname.endsWith(secondId) ? later : undefined,
        current_turn: { worker_turn_seq: 2, started_at: at },
      })
    })
    expect(await api.listThreads()).toMatchObject([
      {
        id: threadId,
        title: 'Inspect this repository',
        status: 'running',
        pending: 'stop',
        runStartedAt: Date.parse(at),
      },
      { id: secondId, status: 'running', pending: 'archive' },
    ])
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('cursor=next%2F%2B'))).toBe(true)
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('cursor=1'))).toBe(true)
  })

  it.each([
    ['history_missing', {}, 'historyLost'],
    ['folder_missing', {}, 'folderMissing'],
    ['Agent 没有在 1 分钟内停下，已结束进程', {}, 'forced'],
    ['', { stop_confirmed_at: later }, 'byYou'],
    ['Cannot start the agent', { opened_at: undefined }, 'startFailed'],
    ['Device restarted', {}, 'interrupted'],
  ])('maps a stopped thread reason %s', async (reason, extra, kind) => {
    const t = thread({ status: 'stopped', status_reason: reason, ...extra })
    const { api } = setup((url) =>
      url.pathname === '/api/v1/threads' ? { threads: [t] } : url.pathname.endsWith('/timeline') ? { events: [] } : t,
    )
    expect((await api.listThreads())[0].stop?.kind).toBe(kind)
  })

  it('reconstructs delivery from device reports and uses stable reply IDs without invented process', async () => {
    const events = [
      accepted(),
      event(2, 'message.queued', { client_message_id: 'client-message' }),
      event(3, 'message.sent', { client_message_id: 'client-message', worker_turn_seq: 4 }),
      event(4, 'reply', { event_id: 'reply-report', worker_turn_seq: 4, content: 'Actual reply' }, later),
    ]
    const { api } = setup((url) => (url.pathname.endsWith('/timeline') ? { events } : thread()))
    expect(await api.listMessages(threadId)).toMatchObject([
      { id: messageId, sender: 'you', body: 'Inspect this repository', delivery: 'delivered' },
      { id: `reply:${threadId}:reply-report`, body: 'Actual reply', activity: null, attachments: [] },
    ])
    expect((await api.listMessages(threadId))[1].id).toBe(`reply:${threadId}:reply-report`)
  })

  it('shows a saved message waiting for an offline device and preserves unknown delivery', async () => {
    let events = [accepted()]
    const { api } = setup((url) => (url.pathname.endsWith('/timeline') ? { events } : thread({ node_online: false })))
    expect((await api.listMessages(threadId))[0].delivery).toBe('waitingDevice')
    events = [
      ...events,
      event(2, 'message.unknown', { client_message_id: 'client-message', reason: 'Device restarted' }),
    ]
    expect((await api.listMessages(threadId))[0].delivery).toBe('unknown')
  })

  it('sends JSON with actual UUIDs and reuses both IDs after an uncertain create', async () => {
    const bodies: { client_thread_id: string; message: { client_message_id: string; content: string } }[] = []
    const { api } = setup((_url, init) => {
      bodies.push(JSON.parse(String(init.body)))
      if (bodies.length === 1) throw new Error('Lost response')
      return thread({ status: 'waiting_device', node_online: false })
    })
    const input = {
      deviceId,
      folder: '/work/baton',
      agent: 'codex' as const,
      model: 'reported-model',
      body: 'Hello',
      clientId: 'web-uuid-prefix',
    }
    await expect(api.createThread(input)).rejects.toMatchObject({ code: 'unavailable' })
    const op = await api.createThread(input)
    expect(op).toMatchObject({ targetId: threadId, phase: 'waitingDevice' })
    expect(bodies[0]).toEqual(bodies[1])
    expect(bodies[1].client_thread_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(bodies[1].message.client_message_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(bodies[1].client_thread_id).not.toBe(bodies[1].message.client_message_id)
    expect(bodies[1].message.content).toBe('Hello')
  })

  it('rejects unavailable models using device capabilities before creating', async () => {
    const { api, fetcher } = setup(() => {
      throw new Error('Unexpected write')
    })
    await expect(
      api.createThread({ deviceId, folder: '/work', agent: 'codex', model: 'invented', body: 'Hi', clientId: 'id' }),
    ).rejects.toMatchObject({ code: 'invalid' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('maps next/now to queue/steer and completes sending only after the real turn ends', async () => {
    let events = [accepted()]
    const bodies: Record<string, string>[] = []
    const { api, refreshes } = setup((url, init) => {
      if (init.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, string>
        bodies.push(body)
        return message({ client_message_id: body.client_message_id })
      }
      if (url.pathname.endsWith('/timeline')) return { events }
      return thread({ status: 'running', current_turn: { worker_turn_seq: 4, started_at: at } })
    })
    const op = await api.sendMessage({ threadId, body: 'Next message', clientId: 'send-1', mode: 'next' })
    expect(op.phase).toBe('saved')
    expect(bodies[0].mode).toBe('queue')
    const clientId = bodies[0].client_message_id
    events = [
      event(1, 'message.accepted', message({ client_message_id: clientId })),
      event(2, 'message.sent', { client_message_id: clientId, worker_turn_seq: 4 }),
    ]
    expect(await refreshes.get(op.id)!()).toMatchObject({ phase: 'running' })
    events.push(event(3, 'turn.ended', { worker_turn_seq: 4, reason: 'completed' }))
    expect(await refreshes.get(op.id)!()).toMatchObject({ phase: 'done' })
    await api.sendMessage({ threadId, body: 'Insert', clientId: 'send-2', mode: 'now' })
    expect(bodies[1].mode).toBe('steer')
  })

  it.each(['stop', 'archive'] as const)('waits for device acknowledgement of %s', async (action) => {
    let t = thread({
      status: 'running',
      stop_requested_at: later,
      archive_requested_at: action === 'archive' ? later : undefined,
    })
    const { api, refreshes } = setup(() => t)
    const op = action === 'stop' ? await api.stopThread(threadId) : await api.archiveThread(threadId)
    expect(op.phase).toBe('stopping')
    expect(await refreshes.get(op.id)!()).toMatchObject({ phase: 'stopping' })
    t = thread(action === 'stop' ? { status: 'stopped', stop_confirmed_at: later } : { status: 'archived' })
    expect(await refreshes.get(op.id)!()).toMatchObject({ phase: action === 'stop' ? 'stopped' : 'done' })
  })

  it('keeps failed or uncertain stop confirmation out of the stopped phase', async () => {
    let t = thread({ status: 'running', stop_requested_at: later })
    const { api, refreshes } = setup(() => t)
    const op = await api.stopThread(threadId)
    t = thread({ status: 'unknown', status_reason: 'Cannot confirm process cleanup', stop_requested_at: later })
    expect(await refreshes.get(op.id)!()).toMatchObject({ phase: 'failed', detail: 'Cannot confirm process cleanup' })
  })

  it('keeps withdrawal queued until a device report arrives and preserves conflicts', async () => {
    let conflict = false
    let events = [accepted()]
    const { api } = setup((url, init) => {
      if (init.method === 'POST')
        return conflict ? Response.json({ code: 'message_already_sent' }, { status: 409 }) : thread()
      return url.pathname.endsWith('/timeline') ? { events } : thread()
    })
    await api.listMessages(threadId)
    expect((await api.cancelMessage(messageId)).delivery).toBe('saved')
    events = [...events, event(2, 'message.withdrawn', { client_message_id: 'client-message' })]
    expect((await api.cancelMessage(messageId)).delivery).toBe('withdrawn')
    conflict = true
    await expect(api.cancelMessage(messageId)).rejects.toBeInstanceOf(HttpError)
  })

  it('uses real model and resume endpoints without claiming an immediate resume', async () => {
    const calls: { path: string; body: unknown }[] = []
    const { api } = setup((url, init) => {
      if (init.method === 'POST') calls.push({ path: url.pathname, body: JSON.parse(String(init.body)) })
      if (url.pathname.endsWith('/timeline')) return { events: [] }
      return thread({ status: 'stopped', model: url.pathname.endsWith('/model') ? 'second-model' : 'reported-model' })
    })
    expect((await api.setThreadModel({ threadId, model: 'second-model' })).model).toBe('second-model')
    expect((await api.resumeThread(threadId)).phase).toBe('saved')
    expect(calls).toEqual([
      { path: `/api/v1/threads/${threadId}/model`, body: { model: 'second-model' } },
      { path: `/api/v1/threads/${threadId}/resume`, body: {} },
    ])
  })

  it('reads raw history with stable references and translates forward cursors into older message pages', async () => {
    const entries = Array.from({ length: 20 }, (_, index) => ({
      text: JSON.stringify({
        timestamp: new Date(Date.parse(at) + index * 1000).toISOString(),
        type: 'response_item',
        payload: {
          type: 'message',
          role: index % 2 ? 'assistant' : 'user',
          content: [{ type: index % 2 ? 'output_text' : 'input_text', text: `Native message ${index}` }],
        },
      }),
      reference: `codex:native-session:${index * 100}`,
      truncated: false,
    }))
    const { api, fetcher } = setup((url) => {
      if (url.pathname.endsWith('/timeline')) return { events: [] }
      if (!url.pathname.endsWith('/history')) return thread()
      const last = url.searchParams.has('cursor')
      return {
        ok: true,
        history: {
          entries: last ? entries.slice(16) : entries.slice(0, 16),
          cursor: last ? 'end-digest' : '16:digest',
          has_more: !last,
          gap: false,
        },
      }
    })
    const recent = await api.readHistory(threadId, null)
    expect(recent).toMatchObject({ state: 'ready', more: true })
    if (recent.state !== 'ready') throw new Error('Expected a ready page')
    expect(recent.messages).toHaveLength(16)
    const firstID = `history:${threadId}:${encodeURIComponent('codex:native-session:400')}`
    expect(recent.messages[0].id).toBe(firstID)
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('cursor=16%3Adigest'))).toBe(true)
    const older = await api.readHistory(threadId, firstID)
    expect(older).toMatchObject({ state: 'ready', more: false })
    if (older.state === 'ready') expect(older.messages).toHaveLength(4)
    expect(fetcher.mock.calls.every(([url]) => !String(url).includes('/history/messages'))).toBe(true)
  })

  it('only returns native messages before the uniquely matched saved conversation', async () => {
    const raw = (id: string, role: string, body: string) => ({
      id,
      reference: id,
      truncated: false,
      text: JSON.stringify({
        id,
        type: 'message',
        timestamp: at,
        message: { role, content: [{ type: 'text', text: body }] },
      }),
    })
    const entries = [
      raw('old', 'assistant', 'An earlier reply'),
      raw('user', 'user', 'Inspect this repository'),
      raw('reply', 'assistant', 'Actual reply'),
    ]
    const events = [
      accepted(),
      event(2, 'message.sent', { client_message_id: 'client-message', worker_turn_seq: 1 }),
      event(3, 'reply', { event_id: 'report', worker_turn_seq: 1, content: 'Actual reply' }, later),
    ]
    const { api } = setup((url) =>
      url.pathname.endsWith('/history')
        ? { ok: true, history: { entries, cursor: 'end', has_more: false, gap: false } }
        : url.pathname.endsWith('/timeline')
          ? { events }
          : thread({ agent_type: 'pi' }),
    )
    expect(await api.readHistory(threadId, null)).toMatchObject({
      state: 'ready',
      more: false,
      messages: [{ id: `history:${threadId}:old`, body: 'An earlier reply' }],
    })
  })

  it('uses the active parent chain for Pi native history branches', async () => {
    const raw = (id: string, parentId: string | null) => ({
      id,
      parent_id: parentId,
      reference: id,
      truncated: false,
      text: JSON.stringify({
        id,
        parentId,
        type: 'message',
        timestamp: at,
        message: { role: 'assistant', content: id },
      }),
    })
    const entries = [raw('root', null), raw('other-branch', 'root'), raw('active-branch', 'root')]
    const { api } = setup((url) =>
      url.pathname.endsWith('/history')
        ? { ok: true, history: { entries, cursor: 'end', has_more: false, gap: false } }
        : url.pathname.endsWith('/timeline')
          ? { events: [] }
          : thread({ agent_type: 'pi' }),
    )
    const history = await api.readHistory(threadId, null)
    if (history.state !== 'ready') throw new Error('Expected ready history')
    expect(history.messages.map((m) => m.body)).toEqual(['root', 'active-branch'])
  })

  it('maps explicit native missing/offline states and preserves other failures', async () => {
    let response: Record<string, unknown> = { ok: false, code: 'history_missing' }
    const { api } = setup((url) => (url.pathname.endsWith('/history') ? response : thread()))
    expect(await api.readHistory(threadId, null)).toEqual({ state: 'unavailable', threadId, reason: 'missing' })
    response = { ok: false, code: 'node_offline' }
    expect(await api.readHistory(threadId, null)).toMatchObject({ reason: 'offline' })
    response = { ok: false, code: 'history_busy' }
    await expect(api.readHistory(threadId, null)).rejects.toBeInstanceOf(ClientError)
  })

  it.each([
    { gap: true, entries: [] },
    { gap: false, entries: [{ reference: 'raw', text: '{}', truncated: true }] },
    { gap: false, entries: [{ reference: 'raw', text: '{', truncated: false }] },
    {
      gap: false,
      entries: [
        {
          reference: 'raw',
          truncated: false,
          text: JSON.stringify({ type: 'message', id: 'no-time', message: { role: 'user', content: 'Hello' } }),
        },
      ],
    },
  ])('does not invent complete history for incomplete native records %#', async (page) => {
    const { api } = setup((url) =>
      url.pathname.endsWith('/history')
        ? { ok: true, history: { ...page, cursor: 'end', has_more: false } }
        : url.pathname.endsWith('/timeline')
          ? { events: [] }
          : thread({ agent_type: 'pi' }),
    )
    expect(await api.readHistory(threadId, null)).toMatchObject({ state: 'ready', messages: [], gap: true })
  })

  it('retains complete messages and advances the cursor through a page containing a gap and truncated JSON', async () => {
    const raw = (text: string) => ({
      text: JSON.stringify({
        type: 'response_item',
        timestamp: at,
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
      }),
      reference: `codex:native:${text}`,
      truncated: false,
    })
    const { api, fetcher } = setup((url) => {
      if (url.pathname.endsWith('/timeline')) return { events: [] }
      if (!url.pathname.endsWith('/history')) return thread()
      const second = url.searchParams.has('cursor')
      return {
        ok: true,
        history: {
          entries: second
            ? [raw('second-page')]
            : [{ kind: 'session_meta', text: '{', reference: 'codex:native:0', truncated: true }, raw('first-page')],
          cursor: second ? '3:digest' : '2:digest',
          has_more: !second,
          gap: !second,
        },
      }
    })
    const history = await api.readHistory(threadId, null)
    expect(history).toMatchObject({ state: 'ready', gap: true, more: false })
    if (history.state !== 'ready') throw new Error('Expected ready history')
    expect(history.messages.map((message) => message.body)).toEqual(['first-page', 'second-page'])
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('cursor=2%3Adigest'))).toBe(true)
  })

  it('displays the bounded text of a complete but truncated JSON message with an explicit marker', async () => {
    const { api } = setup((url) =>
      url.pathname.endsWith('/history')
        ? {
            ok: true,
            history: {
              entries: [
                {
                  reference: 'native:bounded',
                  truncated: true,
                  text: JSON.stringify({
                    type: 'response_item',
                    timestamp: at,
                    payload: {
                      type: 'message',
                      role: 'assistant',
                      content: [{ type: 'output_text', text: 'Actual bounded text' }],
                    },
                  }),
                },
              ],
              cursor: '1:digest',
              has_more: false,
              gap: true,
            },
          }
        : url.pathname.endsWith('/timeline')
          ? { events: [] }
          : thread(),
    )
    expect(await api.readHistory(threadId, null)).toMatchObject({
      state: 'ready',
      gap: true,
      messages: [
        { body: 'Actual bounded text\n\n[History entry truncated]', createdAt: Date.parse(at), role: 'agent' },
      ],
    })
  })

  it('rejects an ambiguous center boundary and a history cursor that does not advance', async () => {
    let repeatCursor = false
    const entries = [0, 1].map((i) => ({
      reference: `ref-${i}`,
      truncated: false,
      text: JSON.stringify({
        type: 'response_item',
        timestamp: at,
        payload: { type: 'message', role: 'user', content: 'Inspect this repository' },
      }),
    }))
    const { api } = setup((url) =>
      url.pathname.endsWith('/history')
        ? { ok: true, history: { entries, cursor: 'same', has_more: repeatCursor, gap: false } }
        : url.pathname.endsWith('/timeline')
          ? {
              events: [
                accepted(),
                event(2, 'message.sent', { client_message_id: 'client-message', worker_turn_seq: 1 }),
              ],
            }
          : thread(),
    )
    await expect(api.readHistory(threadId, null)).rejects.toThrow('could not be matched')
    repeatCursor = true
    await expect(api.readHistory(threadId, null)).rejects.toThrow('cursor did not advance')
  })

  it('reads the actual trace for the reply turn and reports missing history honestly', async () => {
    let result: Record<string, unknown> = { ok: true, steps: [{ kind: 'command', command: 'go test', output: 'ok' }] }
    const { api, fetcher } = setup((url) =>
      url.pathname.endsWith('/trace')
        ? result
        : url.pathname.endsWith('/timeline')
          ? { events: [event(1, 'reply', { event_id: 'report-id', worker_turn_seq: 3, content: 'Reply' })] }
          : thread(),
    )
    const replyId = (await api.listMessages(threadId))[0].id
    expect(await api.readTrace(replyId)).toMatchObject({
      state: 'ready',
      steps: [{ kind: 'command', command: 'go test', output: 'ok' }],
    })
    expect(String(fetcher.mock.calls.at(-1)![0])).toBe(`/api/v1/threads/${threadId}/trace?worker_turn_seq=3`)
    result = { ok: false, code: 'trace_missing' }
    expect(await api.readTrace(replyId)).toEqual({ state: 'unavailable', messageId: replyId, reason: 'missing' })
  })

  it('shows the saved next model while the running turn keeps its reported model', async () => {
    const { api } = setup((url) =>
      url.pathname.endsWith('/timeline')
        ? { events: [] }
        : thread({ model: 'reported-model', next_model: 'second-model' }),
    )
    expect((await api.setThreadModel({ threadId, model: 'second-model' })).model).toBe('second-model')
  })

  it('does not complete an idle resume before a new device report', async () => {
    let events = [event(1, 'thread.resumed', {})]
    const { api, refreshes } = setup((url) => (url.pathname.endsWith('/timeline') ? { events } : thread()))
    const op = await api.resumeThread(threadId)
    expect(op.phase).toBe('saved')
    expect(await refreshes.get(op.id)!()).toMatchObject({ phase: 'saved' })
    events = [...events, event(2, 'thread.resumed', {})]
    expect(await refreshes.get(op.id)!()).toMatchObject({ phase: 'done' })
  })

  it('reports a real resume failure', async () => {
    let events = [event(1, 'thread.stopped', { reason: 'Earlier stop' })]
    const { api, refreshes } = setup((url) =>
      url.pathname.endsWith('/timeline') ? { events } : thread({ status: 'stopped' }),
    )
    const op = await api.resumeThread(threadId)
    events = [...events, event(2, 'thread.stopped', { reason: 'Native history missing' })]
    expect(await refreshes.get(op.id)!()).toMatchObject({ phase: 'failed', detail: 'Native history missing' })
  })

  it('reports an actual create failure without an optimistic success phase', async () => {
    const { api } = setup(() =>
      thread({ status: 'stopped', opened_at: undefined, status_reason: 'Could not launch agent' }),
    )
    const op = await api.createThread({
      deviceId,
      folder: '/work',
      agent: 'codex',
      model: 'reported-model',
      body: 'Hello',
      clientId: 'create-failure',
    })
    expect(op).toMatchObject({ phase: 'failed', detail: 'Could not launch agent' })
  })

  it('preserves actual file attachments while the device is offline', async () => {
    const { api, fetcher } = setup((url) =>
      url.pathname.endsWith('/timeline')
        ? {
            events: [
              event(1, 'reply', {
                event_id: 'with-file',
                worker_turn_seq: 1,
                content: 'Wrote the file',
                attachments: [
                  {
                    kind: 'file',
                    node_id: deviceId,
                    root_id: 'root-id',
                    path: 'result.txt',
                    absolute_path: '/work/result.txt',
                    size: 25,
                  },
                  { kind: 'commit', repo: 'https://example.test/repo', sha: 'a'.repeat(40), subject: 'Save result' },
                ],
              }),
            ],
          }
        : thread({ node_online: false }),
    )
    expect((await api.listMessages(threadId))[0].attachments).toEqual([
      { kind: 'file', deviceId, path: '/work/result.txt', size: 25 },
      { kind: 'commit', repo: 'https://example.test/repo', sha: 'a'.repeat(40), subject: 'Save result' },
    ])
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/files'))).toBe(false)
  })

  it('maps an HTTP offline trace response and does not hide a permission failure', async () => {
    let status = 409
    const { api } = setup((url) =>
      url.pathname.endsWith('/trace')
        ? Response.json({ code: status === 409 ? 'node_offline' : 'forbidden' }, { status })
        : url.pathname.endsWith('/timeline')
          ? { events: [event(1, 'reply', { worker_turn_seq: 1, content: 'Reply' })] }
          : thread(),
    )
    const id = (await api.listMessages(threadId))[0].id
    expect(await api.readTrace(id)).toMatchObject({ state: 'unavailable', reason: 'offline' })
    status = 403
    await expect(api.readTrace(id)).rejects.toMatchObject({ status: 403 })
  })

  it('shares concurrent output reads and starts each turn from its own cursor', async () => {
    let seq = 1
    const { api, fetcher } = setup((url) =>
      url.pathname.endsWith('/output')
        ? { ok: true, state: 'running', text: `turn-${seq}`, cursor: `epoch-${seq}:6`, gap: false }
        : thread({ status: 'running', current_turn: { worker_turn_seq: seq, started_at: at } }),
    )
    const first = await Promise.all([api.readOutput(threadId), api.readOutput(threadId)])
    expect(first[0].chunks).toEqual([{ kind: 'text', text: 'turn-1' }])
    expect(first[1]).toEqual(first[0])
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/output'))).toHaveLength(1)
    seq = 2
    expect((await api.readOutput(threadId)).chunks).toEqual([{ kind: 'text', text: 'turn-2' }])
    expect(String(fetcher.mock.calls.at(-1)![0])).not.toContain('cursor=')
  })

  it('clears output when the worker reports completion before the coordinator snapshot', async () => {
    const { api } = setup((url) =>
      url.pathname.endsWith('/output')
        ? { ok: true, state: 'idle', text: 'Previous output', cursor: 'epoch:15', gap: false }
        : thread({ status: 'running', current_turn: { worker_turn_seq: 1, started_at: at } }),
    )
    expect((await api.readOutput(threadId)).chunks).toEqual([])
  })

  it('retains command threads with agent=null and reads their real trace and output', async () => {
    const t = thread({
      agent_type: 'shell',
      model: '',
      status: 'running',
      current_turn: { worker_turn_seq: 1, started_at: at },
    })
    const { api } = setup((url) => {
      if (url.pathname === '/api/v1/threads') return { threads: [t] }
      if (url.pathname.endsWith('/timeline'))
        return {
          events: [
            accepted(),
            event(2, 'reply', { event_id: 'shell-report', worker_turn_seq: 1, content: 'shell output' }, later),
          ],
        }
      if (url.pathname.endsWith('/trace'))
        return { ok: true, steps: [{ kind: 'command', command: 'printf shell-output', output: 'shell-output' }] }
      if (url.pathname.endsWith('/output'))
        return { ok: true, state: 'running', text: 'shell-output', cursor: 'shell-epoch:12', gap: false }
      return t
    })
    expect((await api.listThreads())[0]).toMatchObject({ id: threadId, agent: null, status: 'running' })
    const reply = (await api.listMessages(threadId)).find((m) => m.role === 'agent')!
    expect(await api.readTrace(reply.id)).toMatchObject({
      state: 'ready',
      steps: [{ kind: 'command', command: 'printf shell-output', output: 'shell-output' }],
    })
    expect((await api.readOutput(threadId)).chunks).toEqual([{ kind: 'text', text: 'shell-output' }])
  })

  it('rejects truncated trace and represents truly empty output without generated text', async () => {
    let gap = false
    const { api } = setup((url) => {
      if (url.pathname.endsWith('/timeline'))
        return { events: [event(1, 'reply', { event_id: 'report', worker_turn_seq: 1, content: 'Reply' })] }
      if (url.pathname.endsWith('/trace'))
        return { ok: true, steps: [{ kind: 'command', command: 'printf', output: 'partial', truncated: true }] }
      if (url.pathname.endsWith('/output')) return { ok: true, state: 'running', cursor: 'epoch:0', gap }
      return thread({ status: 'running', current_turn: { worker_turn_seq: 1, started_at: at } })
    })
    const reply = (await api.listMessages(threadId))[0]
    await expect(api.readTrace(reply.id)).rejects.toThrow('incomplete')
    expect((await api.readOutput(threadId)).chunks).toEqual([])
    gap = true
    expect((await api.readOutput(threadId)).chunks).toEqual([{ kind: 'gap' }])
  })

  it('bounds accumulated UTF-8 output, merges text chunks, and marks evicted history with a gap', async () => {
    let cursor = 0
    const text = '中文'.repeat(3000)
    const { api } = setup((url) =>
      url.pathname.endsWith('/output')
        ? { ok: true, state: 'running', text, cursor: `epoch:${++cursor}`, gap: false }
        : thread({ status: 'running', current_turn: { worker_turn_seq: 1, started_at: at } }),
    )
    let result = await api.readOutput(threadId)
    for (let index = 0; index < 20; index += 1) result = await api.readOutput(threadId)
    expect(result.chunks[0]).toEqual({ kind: 'gap' })
    expect(result.chunks).toHaveLength(2)
    const retained = result.chunks
      .filter((chunk) => chunk.kind === 'text')
      .map((chunk) => chunk.text)
      .join('')
    expect(new TextEncoder().encode(retained).byteLength).toBeLessThanOrEqual(256 * 1024)
    expect(retained).not.toContain('\uFFFD')
    expect(retained.endsWith(text)).toBe(true)
  })

  it('tracks output cursors, preserves gaps, and clears output when a turn ends', async () => {
    let t = thread({ status: 'running', current_turn: { worker_turn_seq: 1, started_at: at } })
    let count = 0
    const { api, fetcher } = setup((url) => {
      if (url.pathname.endsWith('/output'))
        return ++count === 1
          ? { ok: true, text: 'first', cursor: 'epoch:5', gap: false }
          : { ok: true, text: 'last', cursor: 'epoch:9', gap: true }
      return t
    })
    expect((await api.readOutput(threadId)).chunks).toEqual([{ kind: 'text', text: 'first' }])
    expect((await api.readOutput(threadId)).chunks).toEqual([
      { kind: 'text', text: 'first' },
      { kind: 'gap' },
      { kind: 'text', text: 'last' },
    ])
    expect(String(fetcher.mock.calls.at(-1)![0])).toContain('cursor=epoch%3A5')
    t = thread({ status: 'idle' })
    expect((await api.readOutput(threadId)).chunks).toEqual([])
  })
})

describe('HTTP file contracts', () => {
  it('lists real root paths and follows every directory cursor', async () => {
    const { api, fetcher } = setup((url) => {
      if (!url.searchParams.has('root_id')) return rootResponse
      expect(url.searchParams.get('root_id')).toBe('root-id')
      expect(url.searchParams.get('path')).toBe('baton')
      return url.searchParams.has('cursor')
        ? { kind: 'directory', entries: [{ name: 'README.md', kind: 'file', size: 31 }], truncated: false }
        : { kind: 'directory', entries: [{ name: 'src', kind: 'directory' }], next_cursor: 'page/+2', truncated: true }
    })
    expect(await api.listFolders(deviceId, null)).toMatchObject({ state: 'ready', folders: ['/work'] })
    expect(await api.listFolders(deviceId, '/work/baton')).toEqual({
      state: 'ready',
      deviceId,
      path: '/work/baton',
      folders: ['/work/baton/src'],
      files: [{ path: '/work/baton/README.md', size: 31 }],
    })
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('cursor=page%2F%2B2'))).toBe(true)
  })

  it('maps text preview size and truncation without filling content', async () => {
    const { api } = setup((url) =>
      url.searchParams.has('root_id')
        ? { kind: 'file', size: 100000, content: 'Actual prefix', truncated: true }
        : rootResponse,
    )
    expect(await api.readFile(deviceId, '/work/file.txt')).toEqual({
      state: 'ready',
      deviceId,
      path: '/work/file.txt',
      size: 100000,
      content: 'Actual prefix',
      truncated: true,
    })
  })

  it.each([
    ['node_offline', 409, 'offline'],
    ['node_syncing', 409, 'syncing'],
    ['root_forbidden', 403, 'outsideFolders'],
    ['path_escaped', 403, 'outsideFolders'],
    ['not_found', 404, 'missing'],
    ['not_text', 415, 'binary'],
  ])('maps file HTTP error %s to %s', async (code, status, reason) => {
    const { api } = setup((url) =>
      url.searchParams.has('root_id') ? Response.json({ code }, { status }) : rootResponse,
    )
    expect(await api.readFile(deviceId, '/work/file')).toMatchObject({ state: 'unavailable', reason, size: null })
  })

  it.each(['offline', 'syncing'] as const)(
    'reports %s from the real device state before browsing',
    async (connection) => {
      const { api, fetcher } = setup(() => rootResponse, [device(connection)])
      expect(await api.readFile(deviceId, '/work/file')).toMatchObject({ state: 'unavailable', reason: connection })
      expect(await api.listFolders(deviceId, null)).toMatchObject({ state: 'unavailable', reason: connection })
      expect(fetcher).not.toHaveBeenCalled()
    },
  )

  it.each(['/work-other/file', '/work/../private/file'])('does not send an unauthorized path %s', async (path) => {
    const { api, fetcher } = setup(() => rootResponse)
    expect(await api.readFile(deviceId, path)).toMatchObject({ state: 'unavailable', reason: 'outsideFolders' })
    expect(fetcher.mock.calls.every(([url]) => !String(url).includes('root_id='))).toBe(true)
  })

  it('preserves transient failures and refuses an incomplete directory scan', async () => {
    let response: unknown = Response.json({ code: 'node_unavailable' }, { status: 503 })
    const { api } = setup((url) => (url.searchParams.has('root_id') ? response : rootResponse))
    await expect(api.readFile(deviceId, '/work/file')).rejects.toMatchObject({ code: 'unavailable' })
    response = { kind: 'directory', entries: [], truncated: true, remainder: { scan_limited: true } }
    await expect(api.listFolders(deviceId, '/work/baton')).rejects.toMatchObject({ code: 'unavailable' })
  })
})
