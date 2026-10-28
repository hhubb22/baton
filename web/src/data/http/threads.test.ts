import { describe, expect, it, vi } from 'vite-plus/test'
import { threadMessageNotice, threadView } from '../derive'
import type { Device, OperationPhase, TraceStep } from '../types'
import type { HttpContext } from './context'
import { createThreadAPI } from './threads'
import { createTransport, HttpError } from './transport'

function requestURL(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input.toString()
}

function jsonBody(body: RequestInit['body']): string {
  if (typeof body !== 'string') throw new TypeError('Expected a JSON string request body')
  return body
}

const threadId = '74b66275-348c-4dd3-ae1d-7f3d21440f70'
const deviceId = '729f92e9-e68c-4a30-817a-0adb2da87b51'
const messageId = 'c6559d72-c581-4f4d-bef0-3f80724d1856'
const at = '2026-10-23T02:00:00Z'
const later = '2026-10-23T02:01:00Z'
const fullOutputReference = {
  id: '25689309-82b9-4cf7-8cba-7e84d7d30236',
  storage_generation: 'local-generation',
  total_bytes: 100000,
  expires_at: '2099-01-01T00:00:00.000Z',
}
const traceStep = (overrides: Partial<TraceStep> = {}): TraceStep => ({
  item_id: 'command-1',
  type: 'command_execution',
  status: 'completed',
  ordinal: 1,
  data: { input: 'pnpm test', output: 'ok' },
  truncated: false,
  original_bytes: 42,
  ...overrides,
})
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
      status: 'available',
      reason: null,
      version: '1',
      models: ['reported-model', 'second-model'],
      defaultModel: 'reported-model',
      abilities: { create: true, queue: true, steer: true, stop: true, resume: true, switchModel: true },
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
type Handler = (url: URL, init: RequestInit) => unknown
function setup(handler: Handler, devices: Device[] = [device()]) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(requestURL(input), 'https://baton.test')
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
  it('loads questions and submits answers through the answer endpoint while preserving durable unknown results', async () => {
    const question = {
      request_id: 'targets',
      kind: 'user_input',
      questions: [{ id: 'platform', header: 'Platforms', question: 'Which?', options: [], multiSelect: true }],
    }
    let current = thread({ status: 'running', node_online: false, pending_questions: [question], question_answers: [] })
    const writes: string[] = []
    const { api } = setup((url, init) => {
      if (url.pathname.endsWith('/timeline')) return { events: [] }
      if (init.method === 'POST') {
        writes.push(url.pathname)
        expect(JSON.parse(jsonBody(init.body))).toEqual({
          request_id: 'targets',
          decision: 'accept',
          answers: { platform: ['linux', 'macos'] },
        })
        current = thread({
          status: 'running',
          pending_questions: [],
          question_answers: [{ request_id: 'targets', decision: 'accept', outcome: 'pending' }],
        })
      }
      return current
    })
    expect((await api.getThread(threadId)).pendingQuestions).toEqual([question])
    expect(
      (
        await api.answerThreadQuestion({
          threadId,
          answer: { request_id: 'targets', decision: 'accept', answers: { platform: ['linux', 'macos'] } },
        })
      ).questionAnswers?.[0]?.outcome,
    ).toBe('pending')
    current = thread({
      status: 'running',
      question_answers: [
        { request_id: 'targets', decision: 'accept', outcome: 'unknown', reason: 'answer_delivery_uncertain' },
      ],
    })
    expect((await api.getThread(threadId)).questionAnswers?.[0]?.outcome).toBe('unknown')
    expect(writes).toEqual([`/api/v1/threads/${threadId}/answer`])
  })

  it('keeps Cursor startup separate from saved, accepted and actually opened execution', async () => {
    const cursorDevice = device()
    cursorDevice.agents[0].kind = 'cursor'
    let t = thread({ agent_type: 'cursor', opened_at: null, native_session_id: undefined, status: 'waiting_device' })
    const events = [accepted()]
    const { api } = setup((url) => (url.pathname.endsWith('/timeline') ? { events } : t), [cursorDevice])
    expect(await api.getThread(threadId)).toMatchObject({ agent: 'cursor', starting: true })
    expect(threadView(await api.getThread(threadId), cursorDevice).status.label).toBe('Starting…')
    const op = await api.createThread({
      deviceId,
      folder: '/work',
      agent: 'cursor',
      model: '',
      body: 'Hello',
      clientId: 'cursor-create',
    })
    expect(op.phase).toBe('saved')
    // 设备已持久接收消息，但尚未打开原生对话。
    events.push(event(2, 'message.queued', { client_message_id: 'client-message' }))
    expect(threadView(await api.getThread(threadId), cursorDevice).status.label).toBe('Starting…')
    t = thread({ agent_type: 'cursor' })
    expect(threadView(await api.getThread(threadId), cursorDevice).status.label).toBe('Idle')
    t = thread({
      agent_type: 'cursor',
      opened_at: null,
      status: 'stopped',
      status_reason: 'Local sandbox could not start.',
      stop_code: 'start_failed',
    })
    expect(threadView(await api.getThread(threadId), cursorDevice).notice).toMatchObject({
      title: 'Cursor could not start',
      detail: expect.stringContaining('Local sandbox could not start.'),
    })
  })

  it('offers reopening only when the server proves startup was rejected before Worker delivery', async () => {
    let t = thread({
      opened_at: null,
      status: 'stopped',
      stop_code: 'start_failed',
      retry_open_allowed: true,
      resume_pending: false,
    })
    const { api, refreshes } = setup((url, init) => {
      if (url.pathname.endsWith('/timeline')) return { events: [accepted()] }
      if (url.pathname.endsWith('/resume') && init?.method === 'POST')
        t = thread({ opened_at: null, status: 'waiting_device', resume_pending: true })
      return t
    })
    const stopped = await api.getThread(threadId)
    expect(threadView(stopped, device()).notice).toMatchObject({ action: 'resume' })
    expect(threadView(stopped, device()).composer).toBe(false)
    const op = await api.resumeThread(threadId)
    const refresh = refreshes.get(op.id)
    if (!refresh) throw new Error('Missing operation refresh')
    expect((await refresh()).phase).toBe('saved')
    t = thread({ resume_pending: false })
    expect((await refresh()).phase).toBe('done')
    t = thread({
      opened_at: null,
      status: 'stopped',
      stop_code: 'start_failed',
      retry_open_allowed: false,
      resume_pending: false,
    })
    expect(threadView(await api.getThread(threadId), device()).notice).toMatchObject({ action: 'newChat' })
  })

  it('rejects Cursor creation without explicit create capability', async () => {
    const cursorDevice = device()
    cursorDevice.agents[0] = {
      ...cursorDevice.agents[0],
      kind: 'cursor',
      reason: 'Creation disabled.',
      abilities: { ...cursorDevice.agents[0].abilities, create: false },
    }
    const { api, fetcher } = setup(() => thread(), [cursorDevice])
    await expect(
      api.createThread({ deviceId, folder: '/work', agent: 'cursor', model: '', body: 'Hello', clientId: 'id' }),
    ).rejects.toMatchObject({ code: 'invalid', message: 'Creation disabled.' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(['done', 'failed', 'stopped'] as const)(
    'keeps Cursor resume pending through receipt ACK and opened report until %s completion',
    async (outcome) => {
      const cursorDevice = device()
      cursorDevice.agents[0].kind = 'cursor'
      let t = thread({ agent_type: 'cursor', status: 'stopped', resume_pending: true })
      let events: ReturnType<typeof event>[] = []
      const { api, refreshes } = setup((url) => (url.pathname.endsWith('/timeline') ? { events } : t), [cursorDevice])
      const op = await api.resumeThread(threadId)
      expect(op.phase).toBe('saved')
      expect((await api.getThread(threadId)).resumePending).toBe(true)
      expect(threadView(await api.getThread(threadId), cursorDevice).composer).toBe(false)
      expect(await refreshes.get(op.id)!()).toMatchObject({ phase: 'saved' })
      events = [event(1, 'thread.resumed', {})]
      t = thread({ agent_type: 'cursor', resume_pending: true })
      expect(await refreshes.get(op.id)!()).toMatchObject({ phase: 'saved' })
      t = thread({
        agent_type: 'cursor',
        status: outcome === 'done' ? 'idle' : outcome === 'failed' ? 'unknown' : 'stopped',
        status_reason: outcome === 'done' ? '' : 'Resume did not finish.',
        resume_pending: false,
      })
      expect(await refreshes.get(op.id)!()).toMatchObject({ phase: outcome === 'done' ? 'done' : 'failed' })
      expect((await api.getThread(threadId)).resumePending).toBe(false)
    },
  )

  it('reads only list pages and preserves summary titles and pending actions', async () => {
    const secondId = '0d28bd24-30ed-419b-8bf3-9b783b9be9ba'
    const { api, fetcher } = setup((url) => {
      if (url.pathname !== '/api/v1/threads') throw new Error('List requested thread details')
      const t = thread({
        title: 'Inspect this repository',
        status: 'running',
        stop_requested_at: later,
        stop_canceled: 3,
        current_turn: { worker_turn_seq: 2, started_at: at },
      })
      return url.searchParams.has('cursor')
        ? { threads: [thread({ ...t, id: secondId, archive_requested_at: later })] }
        : { threads: [t], next_cursor: 'next/+' }
    })
    expect(await api.listThreads()).toMatchObject([
      {
        id: threadId,
        title: 'Inspect this repository',
        status: 'running',
        pending: 'stop',
        stopCanceled: 3,
        runStartedAt: Date.parse(at),
      },
      { id: secondId, status: 'running', pending: 'archive' },
    ])
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls.some(([url]) => requestURL(url).includes('cursor=next%2F%2B'))).toBe(true)
  })

  it('uses one request to list 20 threads and reads the timeline only for opened messages', async () => {
    const { api, fetcher } = setup((url) => {
      if (url.pathname === '/api/v1/threads')
        return { threads: Array.from({ length: 20 }, (_, i) => thread({ id: String(i), title: 'Title' })) }
      if (url.pathname.endsWith('/timeline')) return { events: [accepted()] }
      return thread()
    })
    expect(await api.listThreads()).toHaveLength(20)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(await api.listMessages(threadId)).toHaveLength(1)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it.each([
    ['history_lost', 'historyLost'],
    ['folder_missing', 'folderMissing'],
    ['forced_stop', 'forced'],
    ['user_stopped', 'byYou'],
    ['start_failed', 'startFailed'],
    ['interrupted', 'interrupted'],
    [undefined, 'interrupted'],
    ['future_stop_code', 'interrupted'],
    ['constructor', 'interrupted'],
  ])('maps stop code %s independently of reason text and timestamps', async (code, kind) => {
    const t = thread({
      status: 'stopped',
      stop_code: code,
      status_reason: 'history_missing: Agent 没有在 1 分钟内停下，已结束进程',
      stop_confirmed_at: later,
      opened_at: undefined,
    })
    const { api } = setup((url) =>
      url.pathname === '/api/v1/threads' ? { threads: [t] } : url.pathname.endsWith('/timeline') ? { events: [] } : t,
    )
    expect((await api.listThreads())[0].stop).toEqual({ kind, detail: t.status_reason })
  })

  it('reconstructs delivery from device reports and uses stable reply IDs without invented process', async () => {
    const events = [
      accepted(),
      event(2, 'message.queued', { client_message_id: 'client-message' }),
      event(3, 'message.sent', { client_message_id: 'client-message', worker_turn_seq: 4 }),
      event(
        4,
        'reply',
        {
          event_id: 'reply-report',
          worker_turn_seq: 4,
          content: 'Actual reply',
          metadata: { full_output: fullOutputReference },
        },
        later,
      ),
    ]
    const { api } = setup((url) => (url.pathname.endsWith('/timeline') ? { events } : thread()))
    expect(await api.listMessages(threadId)).toMatchObject([
      { id: messageId, sender: 'you', body: 'Inspect this repository', delivery: 'delivered' },
      {
        id: `reply:${threadId}:reply-report`,
        body: 'Actual reply',
        activity: null,
        fullOutput: fullOutputReference,
        attachments: [],
      },
    ])
    expect((await api.listMessages(threadId))[1].id).toBe(`reply:${threadId}:reply-report`)
  })

  it('keeps reply summaries readable when full-output metadata is missing or malformed', async () => {
    const references: unknown[] = [
      undefined,
      null,
      [],
      { ...fullOutputReference, id: 'invalid-id' },
      { ...fullOutputReference, storage_generation: 42 },
      { ...fullOutputReference, total_bytes: -1 },
      { ...fullOutputReference, expires_at: 'invalid-date' },
    ]
    const events = references.map((full_output, index) =>
      event(index + 1, 'reply', {
        event_id: `reply-${index}`,
        content: `Summary ${index}`,
        metadata: { full_output },
      }),
    )
    const { api } = setup((url) => (url.pathname.endsWith('/timeline') ? { events } : thread()))
    expect(
      (await api.listMessages(threadId)).map((reply) => ({ body: reply.body, fullOutput: reply.fullOutput })),
    ).toEqual(references.map((_, index) => ({ body: `Summary ${index}`, fullOutput: null })))
  })

  it.each([false, true])(
    'shows a failed reply in its timeline position and keeps delivery confirmed (partial reply: %s)',
    async (partialReply) => {
      const reason = 'Send your message again or check Codex on this device.'
      const events = [
        event(1, 'message.accepted', message({ client_message_id: messageId })),
        event(2, 'message.sent', { client_message_id: messageId, worker_turn_seq: 4 }),
        ...(partialReply ? [event(3, 'reply', { worker_turn_seq: 4, content: 'Partial reply' })] : []),
        event(4, 'turn.ended', {
          event_id: 'failed-report',
          worker_turn_seq: 4,
          reason: 'failed',
          content: reason,
          queue_empty: true,
        }),
      ]
      const { api, refreshes } = setup((url, init) => {
        if (init.method === 'POST') return message({ client_message_id: messageId })
        return url.pathname.endsWith('/timeline') ? { events } : thread()
      })
      const op = await api.sendMessage({ threadId, body: 'Inspect this repository', clientId: messageId, mode: 'next' })
      const refresh = refreshes.get(op.id)
      if (!refresh) throw new Error('Expected an execution refresh')
      expect(await refresh()).toMatchObject({ phase: 'failed', detail: reason })
      const failedMessages = await api.listMessages(threadId)
      expect(
        threadView(await api.getThread(threadId), device(), {
          unknownDelivery: failedMessages.some((item) => item.delivery === 'unknown'),
        }),
      ).toEqual({
        status: { tone: 'neutral', label: 'Idle' },
        group: 'idle',
        notice: null,
        composer: true,
        live: false,
      })

      events.push(
        event(
          5,
          'message.accepted',
          message({ id: 'next-message', client_message_id: 'next-client', content: 'Continue' }),
        ),
        event(6, 'message.sent', { client_message_id: 'next-client', worker_turn_seq: 5 }),
        event(7, 'reply', { event_id: 'next-reply', worker_turn_seq: 5, content: 'Next reply' }),
        event(8, 'turn.ended', { worker_turn_seq: 5, reason: 'completed', queue_empty: true }),
      )
      const messages = await api.listMessages(threadId)
      expect(messages.map((item) => item.body)).toEqual([
        'Inspect this repository',
        ...(partialReply ? ['Partial reply'] : []),
        reason,
        'Continue',
        'Next reply',
      ])
      expect(messages.filter((item) => item.role === 'user').map((item) => item.delivery)).toEqual([
        'delivered',
        'delivered',
      ])
      const failure = messages.find((item) => item.role === 'failure')
      if (!failure) throw new Error('Expected the failed reply in the timeline')
      expect(failure).toMatchObject({
        id: `turn-failed:${threadId}:failed-report`,
        body: reason,
        activity: null,
        attachments: [],
      })
      const current = await api.getThread(threadId)
      expect(threadMessageNotice(failure, current.agent)).toEqual({
        title: 'Codex could not finish this reply',
        detail: reason,
        tone: 'neutral',
        action: null,
      })
      expect(current.status).toBe('idle')
      expect((await api.listMessages(threadId)).map((item) => item.id)).toEqual(messages.map((item) => item.id))
      expect(await refresh()).toMatchObject({ phase: 'failed', detail: reason })
    },
  )

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
      bodies.push(JSON.parse(jsonBody(init.body)))
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

  it('sends a creation budget and saves an existing reply limit without resetting its start', async () => {
    const started = at
    const { api, fetcher } = setup((url, init) => {
      if (url.pathname.endsWith('/timeline')) return { events: [] }
      const execution_timeout_seconds = init.method === 'PATCH' ? 14400 : 3600
      return thread({
        execution_timeout_seconds,
        status: 'running',
        current_turn: { started_at: started, worker_turn_seq: 1 },
      })
    })
    await api.createThread({
      deviceId,
      folder: '/work',
      agent: 'codex',
      model: 'reported-model',
      executionTimeoutSeconds: 3600,
      body: 'Long task',
      clientId: 'budget-client',
    })
    const creation = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(JSON.parse(jsonBody(creation?.[1]?.body))).toMatchObject({ execution_timeout_seconds: 3600 })
    const updated = await api.setThreadExecutionLimit({ threadId, executionTimeoutSeconds: 14400 })
    const patch = fetcher.mock.calls.find(([, init]) => init?.method === 'PATCH')
    expect(patch?.[0]).toBe(`/api/v1/threads/${threadId}/settings`)
    expect(JSON.parse(jsonBody(patch?.[1]?.body))).toEqual({ execution_timeout_seconds: 14400 })
    expect(updated.executionTimeoutSeconds).toBe(14400)
    expect(updated.runStartedAt).toBe(Date.parse(started))
  })

  it('passes an explicit model ID outside the reported catalog when creating', async () => {
    const { api, fetcher } = setup(() => thread({ model: 'custom-model' }))
    await api.createThread({
      deviceId,
      folder: '/work',
      agent: 'codex',
      model: 'custom-model',
      body: 'Hi',
      clientId: 'id',
    })
    const request = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(JSON.parse(jsonBody(request?.[1]?.body))).toMatchObject({ model: 'custom-model' })
  })

  it('passes a custom model ID for switching and preserves the unsupported capability check', async () => {
    const d = device()
    const { api, fetcher } = setup(
      (url) => (url.pathname.endsWith('/timeline') ? { events: [] } : thread({ model: 'custom-model' })),
      [d],
    )
    expect((await api.setThreadModel({ threadId, model: 'custom-model' })).model).toBe('custom-model')
    const request = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(JSON.parse(jsonBody(request?.[1]?.body))).toEqual({ model: 'custom-model' })
    d.agents = d.agents.map((agent) => ({ ...agent, abilities: { ...agent.abilities, switchModel: false } }))
    fetcher.mockClear()
    await expect(api.setThreadModel({ threadId, model: 'other-custom-model' })).rejects.toThrow(
      'does not support changing models',
    )
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })

  it('passes execution limits when creating and maps settings updates', async () => {
    const writes: { path: string; method: string; body: unknown }[] = []
    const { api } = setup((url, init) => {
      if (url.pathname.endsWith('/timeline')) return { events: [] }
      if (init.method === 'POST' || init.method === 'PATCH')
        writes.push({ path: url.pathname, method: init.method, body: JSON.parse(jsonBody(init.body)) })
      return thread({ execution_timeout_seconds: url.pathname.endsWith('/settings') ? 14400 : 3600 })
    })
    await api.createThread({
      deviceId,
      folder: '/work',
      agent: 'codex',
      model: '',
      body: 'Hi',
      clientId: 'limit',
      executionTimeoutSeconds: 3600,
    })
    expect(writes[0]).toMatchObject({ method: 'POST', body: { execution_timeout_seconds: 3600 } })
    expect((await api.getThread(threadId)).executionTimeoutSeconds).toBe(3600)
    expect(
      (await api.setThreadExecutionLimit({ threadId, executionTimeoutSeconds: 14400 })).executionTimeoutSeconds,
    ).toBe(14400)
    expect(writes[1]).toEqual({
      path: `/api/v1/threads/${threadId}/settings`,
      method: 'PATCH',
      body: { execution_timeout_seconds: 14400 },
    })
  })

  it('maps next/now to queue/steer and completes sending only after the real turn ends', async () => {
    let events = [accepted()]
    const bodies: Record<string, string>[] = []
    const { api, refreshes } = setup((url, init) => {
      if (init.method === 'POST') {
        const body = JSON.parse(jsonBody(init.body)) as Record<string, string>
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

  it('reports a stop the device did not carry out and allows stopping again', async () => {
    let t = thread({ status: 'running', stop_requested_at: later })
    const { api, refreshes } = setup((url) => (url.pathname.endsWith('/timeline') ? { events: [] } : t))
    const op = await api.stopThread(threadId)
    t = thread({ status: 'running', stop_requested_at: later, stop_failure: 'stop_unavailable' })
    expect(await refreshes.get(op.id)!()).toMatchObject({ phase: 'failed' })
    const failed = await api.getThread(threadId)
    expect(failed).toMatchObject({ status: 'running', pending: null, stopFailed: true })
    expect(threadView(failed, device())).toMatchObject({
      status: { label: 'Stop failed' },
      group: 'attention',
      notice: { title: "Couldn't stop Codex", detail: 'Codex may still be running.' },
    })
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
      if (init.method === 'POST') calls.push({ path: url.pathname, body: JSON.parse(jsonBody(init.body)) })
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

  it('pages center timeline records and does not request native history', async () => {
    const pages = [
      {
        events: [accepted(), event(2, 'message.sent', { client_message_id: 'client-message', worker_turn_seq: 1 })],
        next_cursor: 'page-2',
      },
      {
        events: [event(3, 'reply', { event_id: 'reply-1', worker_turn_seq: 1, content: 'First reply' }, later)],
        next_cursor: 'page-3',
      },
      {
        events: [
          event(
            4,
            'message.accepted',
            message({ id: 'message-2', client_message_id: 'second', content: 'Next question', created_at: later }),
            later,
          ),
          event(5, 'message.sent', { client_message_id: 'second', worker_turn_seq: 2 }, later),
        ],
        next_cursor: 'page-4',
      },
      { events: [event(6, 'reply', { event_id: 'reply-2', worker_turn_seq: 2, content: 'Second reply' }, later)] },
    ]
    let index = 0
    const { api, fetcher } = setup((url) => {
      if (url.pathname.endsWith('/history')) throw new Error(`Unexpected history request: ${url.pathname}`)
      if (!url.pathname.endsWith('/timeline')) return thread({ node_online: false, node_synced: false })
      const page = pages[index]
      index += 1
      return page ?? { events: [] }
    })
    const messages = await api.listMessages(threadId)
    expect(messages.map((item) => item.body)).toEqual([
      'Inspect this repository',
      'First reply',
      'Next question',
      'Second reply',
    ])
    expect(messages.every((item) => item.delivery === 'delivered')).toBe(true)
    const timelines = fetcher.mock.calls.map(([url]) => requestURL(url)).filter((url) => url.includes('/timeline'))
    expect(timelines).toEqual([
      `/api/v1/threads/${threadId}/timeline?limit=100`,
      `/api/v1/threads/${threadId}/timeline?limit=100&cursor=page-2`,
      `/api/v1/threads/${threadId}/timeline?limit=100&cursor=page-3`,
      `/api/v1/threads/${threadId}/timeline?limit=100&cursor=page-4`,
    ])
    expect(fetcher.mock.calls.every(([url]) => !requestURL(url).includes('/history'))).toBe(true)
  })

  it('rejects a timeline cursor that does not advance', async () => {
    const { api } = setup((url) =>
      url.pathname.endsWith('/timeline') ? { events: [accepted()], next_cursor: 'stuck' } : thread(),
    )
    await expect(api.listMessages(threadId)).rejects.toThrow('cursor did not advance')
  })

  it('reads the actual trace for the reply turn and reports missing history honestly', async () => {
    let result: Record<string, unknown> = { ok: true, page_cursor: 'snapshot:start', steps: [traceStep()] }
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
      steps: [traceStep()],
    })
    expect(requestURL(fetcher.mock.calls.at(-1)![0])).toBe(`/api/v1/threads/${threadId}/trace?worker_turn_seq=3`)
    result = { ok: false, code: 'trace_missing', page_cursor: 'snapshot:start', steps: null }
    expect(await api.readTrace(replyId)).toEqual({ state: 'unavailable', messageId: replyId, reason: 'missing' })
  })

  it('reads all trace pages with opaque cursors while the device is offline and preserves raw JSON', async () => {
    const raw = 'Saved\u0000\ud800<img src=x> https://example.test'
    const steps = Array.from({ length: 120 }, (_, ordinal) =>
      traceStep({
        item_id: `step-${ordinal}`,
        ordinal,
        parent_id: ordinal ? 'step-0' : undefined,
        started_at: at,
        completed_at: later,
        title: `Saved step ${ordinal}`,
        data: { text: raw },
        truncated: ordinal === 119,
        original_bytes: ordinal === 119 ? 100000 : 100,
        ...(ordinal === 119 ? { full_output: fullOutputReference } : {}),
      }),
    )
    const cursors = ['page:50/+', 'page:100/=']
    const { api, fetcher } = setup(
      (url) => {
        if (url.pathname.endsWith('/timeline'))
          return { events: [event(1, 'reply', { worker_turn_seq: 3, content: 'Reply' })] }
        if (url.pathname.endsWith('/trace')) {
          const cursor = url.searchParams.get('cursor')
          const start = cursor === cursors[0] ? 50 : cursor === cursors[1] ? 100 : 0
          return {
            ok: true,
            page_cursor: cursor ?? 'snapshot:start',
            steps: steps.slice(start, start + 50),
            next_cursor: start < 100 ? cursors[start / 50] : undefined,
          }
        }
        return thread({ node_online: false })
      },
      [device('offline')],
    )
    const replyId = (await api.listMessages(threadId))[0].id
    const saved: TraceStep[] = []
    let cursor: string | undefined
    do {
      const page = await api.readTrace(replyId, cursor)
      if (page.state !== 'ready') throw new Error('Expected saved activity')
      saved.push(...page.steps)
      cursor = page.nextCursor
    } while (cursor)
    expect(saved).toEqual(steps)
    const requests = fetcher.mock.calls
      .map(([input]) => new URL(requestURL(input), 'https://baton.test'))
      .filter((url) => url.pathname.endsWith('/trace'))
    expect(requests.map((url) => url.searchParams.get('cursor'))).toEqual([null, ...cursors])
    expect(requests.every((url) => url.searchParams.get('worker_turn_seq') === '3')).toBe(true)
  })

  it('reports an incomplete or non-advancing trace page as a read error', async () => {
    let result: Record<string, unknown> = { ok: true, page_cursor: 'snapshot:start', steps: null }
    const { api } = setup((url) =>
      url.pathname.endsWith('/trace')
        ? result
        : url.pathname.endsWith('/timeline')
          ? { events: [event(1, 'reply', { worker_turn_seq: 1, content: 'Reply' })] }
          : thread(),
    )
    const id = (await api.listMessages(threadId))[0].id
    await expect(api.readTrace(id)).rejects.toThrow('incomplete')
    result = { ok: true, page_cursor: 'same', steps: [traceStep()], next_cursor: 'same' }
    await expect(api.readTrace(id, 'same')).rejects.toThrow("Couldn't load more activity")
  })

  it('shows the saved next model while the running turn keeps its reported model', async () => {
    const { api } = setup((url) =>
      url.pathname.endsWith('/timeline')
        ? { events: [] }
        : thread({ model: 'reported-model', next_model: 'second-model' }),
    )
    expect((await api.setThreadModel({ threadId, model: 'second-model' })).model).toBe('second-model')
  })

  it('does not complete an idle resume before execution completion', async () => {
    let events = [event(1, 'thread.resumed', {})]
    let pending = true
    const { api, refreshes } = setup((url) =>
      url.pathname.endsWith('/timeline') ? { events } : thread({ resume_pending: pending }),
    )
    const op = await api.resumeThread(threadId)
    expect(op.phase).toBe('saved')
    expect(await refreshes.get(op.id)!()).toMatchObject({ phase: 'saved' })
    events = [...events, event(2, 'thread.resumed', {})]
    expect(await refreshes.get(op.id)!()).toMatchObject({ phase: 'saved' })
    pending = false
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
    expect(fetcher.mock.calls.some(([url]) => requestURL(url).includes('/files'))).toBe(false)
  })

  it('keeps trace read failures retryable and does not hide a permission failure', async () => {
    let status = 409
    const { api } = setup((url) =>
      url.pathname.endsWith('/trace')
        ? Response.json({ code: status === 409 ? 'node_offline' : 'forbidden' }, { status })
        : url.pathname.endsWith('/timeline')
          ? { events: [event(1, 'reply', { worker_turn_seq: 1, content: 'Reply' })] }
          : thread(),
    )
    const id = (await api.listMessages(threadId))[0].id
    await expect(api.readTrace(id)).rejects.toMatchObject({ status: 409 })
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
    expect(fetcher.mock.calls.filter(([url]) => requestURL(url).includes('/output'))).toHaveLength(1)
    seq = 2
    expect((await api.readOutput(threadId)).chunks).toEqual([{ kind: 'text', text: 'turn-2' }])
    expect(requestURL(fetcher.mock.calls.at(-1)![0])).not.toContain('cursor=')
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
        return {
          ok: true,
          page_cursor: 'snapshot:start',
          steps: [traceStep({ data: { input: 'printf shell-output', output: 'shell-output' } })],
        }
      if (url.pathname.endsWith('/output'))
        return { ok: true, state: 'running', text: 'shell-output', cursor: 'shell-epoch:12', gap: false }
      return t
    })
    expect((await api.listThreads())[0]).toMatchObject({ id: threadId, agent: null, status: 'running' })
    const reply = (await api.listMessages(threadId)).find((m) => m.role === 'agent')!
    expect(await api.readTrace(reply.id)).toMatchObject({
      state: 'ready',
      steps: [traceStep({ data: { input: 'printf shell-output', output: 'shell-output' } })],
    })
    expect((await api.readOutput(threadId)).chunks).toEqual([{ kind: 'text', text: 'shell-output' }])
  })

  it('preserves truncated trace fragments and complete steps and represents empty output', async () => {
    let gap = false
    const { api } = setup((url) => {
      if (url.pathname.endsWith('/timeline'))
        return { events: [event(1, 'reply', { event_id: 'report', worker_turn_seq: 1, content: 'Reply' })] }
      if (url.pathname.endsWith('/trace'))
        return {
          ok: true,
          page_cursor: 'snapshot:start',
          steps: [
            traceStep({
              data: { input: 'printf', output: 'partial' },
              truncated: true,
              original_bytes: 100000,
              full_output: fullOutputReference,
            }),
            traceStep({
              item_id: 'tool-2',
              type: 'dynamic_tool',
              ordinal: 2,
              data: { toolName: 'Read', output: 'Complete content' },
            }),
          ],
        }
      if (url.pathname.endsWith('/output')) return { ok: true, state: 'running', cursor: 'epoch:0', gap }
      return thread({ status: 'running', current_turn: { worker_turn_seq: 1, started_at: at } })
    })
    const reply = (await api.listMessages(threadId))[0]
    expect(await api.readTrace(reply.id)).toMatchObject({
      state: 'ready',
      steps: [
        traceStep({
          data: { input: 'printf', output: 'partial' },
          truncated: true,
          original_bytes: 100000,
          full_output: fullOutputReference,
        }),
        traceStep({
          item_id: 'tool-2',
          type: 'dynamic_tool',
          ordinal: 2,
          data: { toolName: 'Read', output: 'Complete content' },
        }),
      ],
    })
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
    expect(requestURL(fetcher.mock.calls.at(-1)![0])).toContain('cursor=epoch%3A5')
    t = thread({ status: 'idle' })
    expect((await api.readOutput(threadId)).chunks).toEqual([])
  })
})

describe('HTTP file contracts', () => {
  it('collects all root pages before locating a file', async () => {
    const { api } = setup((url) => {
      if (url.searchParams.has('root_id')) {
        expect(url.searchParams.get('root_id')).toBe('later-root')
        return { kind: 'file', size: 4, content: 'text', offset: 0, version: 'v1', truncated: false }
      }
      return url.searchParams.has('cursor')
        ? { kind: 'roots', roots: [{ id: 'later-root', path: '/later' }], truncated: false }
        : { ...rootResponse, next_cursor: 'roots/+2', truncated: true }
    })
    expect(await api.listFolders(deviceId, null)).toMatchObject({ folders: ['/work', '/later'] })
    expect(await api.readFile(deviceId, '/later/file')).toMatchObject({ state: 'ready', content: 'text' })
  })

  it('continues a file with its byte offset and version and reports changes', async () => {
    let changed = false
    const { api } = setup((url) => {
      if (!url.searchParams.has('root_id')) return rootResponse
      expect(url.searchParams.get('offset')).toBe('6')
      expect(url.searchParams.get('version')).toBe('version/+1')
      return changed
        ? Response.json({ code: 'file_changed' }, { status: 409 })
        : { kind: 'file', size: 12, content: '中文', offset: 6, version: 'version/+1', truncated: false }
    })
    const options = { offset: 6, version: 'version/+1' }
    expect(await api.readFile(deviceId, '/work/file', options)).toMatchObject({
      state: 'ready',
      content: '中文',
      offset: 6,
      version: options.version,
    })
    changed = true
    await expect(api.readFile(deviceId, '/work/file', options)).rejects.toMatchObject({ code: 'conflict' })
  })

  it('rejects a fragment from another version', async () => {
    const { api } = setup((url) =>
      url.searchParams.has('root_id')
        ? { kind: 'file', size: 20, content: 'changed', offset: 6, version: 'v2', truncated: false }
        : rootResponse,
    )
    await expect(api.readFile(deviceId, '/work/file', { offset: 6, version: 'v1' })).rejects.toMatchObject({
      code: 'conflict',
    })
  })

  it.each([
    { root: '/work', path: '/work/name:part\\literal/file:part\\name', relative: 'name:part\\literal/file:part\\name' },
    { root: 'C:\\work', path: 'C:\\work\\folder\\file', relative: 'folder/file' },
    { root: '\\\\host\\share', path: '\\\\host\\share\\folder\\file', relative: 'folder/file' },
    { root: '/', path: '/file:part\\name', relative: 'file:part\\name' },
  ])('encodes paths according to the root $root', async ({ root, path, relative }) => {
    const { api } = setup((url) => {
      if (!url.searchParams.has('root_id')) return { ...rootResponse, roots: [{ id: 'root-id', path: root }] }
      expect(url.searchParams.get('path')).toBe(relative)
      return { kind: 'file', size: 4, content: 'text', offset: 0, version: 'v1', truncated: false }
    })
    expect(await api.readFile(deviceId, path)).toMatchObject({ state: 'ready', content: 'text' })
  })

  it('keeps entries while following a cursor past a limited scan', async () => {
    const { api } = setup((url) => {
      if (!url.searchParams.has('root_id')) return rootResponse
      return url.searchParams.has('cursor')
        ? { kind: 'directory', entries: [{ name: 'later', kind: 'directory' }], truncated: false }
        : {
            kind: 'directory',
            entries: [{ name: 'first', kind: 'directory' }],
            truncated: true,
            next_cursor: 'scan:4096/next',
            remainder: { scan_limited: true },
          }
    })
    expect(await api.listFolders(deviceId, '/work')).toMatchObject({
      state: 'ready',
      folders: ['/work/first', '/work/later'],
      scanLimited: false,
    })
  })

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
      scanLimited: false,
    })
    expect(fetcher.mock.calls.some(([url]) => requestURL(url).includes('cursor=page%2F%2B2'))).toBe(true)
  })

  it('maps text preview size and truncation without filling content', async () => {
    const { api } = setup((url) =>
      url.searchParams.has('root_id')
        ? {
            kind: 'file',
            size: 100000,
            content: 'Actual prefix',
            truncated: true,
            offset: 0,
            version: 'v1',
            next_offset: 13,
          }
        : rootResponse,
    )
    expect(await api.readFile(deviceId, '/work/file.txt')).toEqual({
      state: 'ready',
      deviceId,
      path: '/work/file.txt',
      size: 100000,
      content: 'Actual prefix',
      truncated: true,
      offset: 0,
      version: 'v1',
      nextOffset: 13,
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
    expect(fetcher.mock.calls.every(([url]) => !requestURL(url).includes('root_id='))).toBe(true)
  })

  it.each(['directory_changed', 'node_unavailable'])('keeps earlier directory pages after %s', async (code) => {
    const { api } = setup((url) => {
      if (!url.searchParams.has('root_id')) return rootResponse
      return url.searchParams.has('cursor')
        ? Response.json({ code }, { status: 409 })
        : {
            kind: 'directory',
            entries: [{ name: 'kept', kind: 'directory' }],
            truncated: true,
            next_cursor: 'v1:4096:hash',
          }
    })
    expect(await api.listFolders(deviceId, '/work')).toMatchObject({
      state: 'ready',
      folders: ['/work/kept'],
      scanLimited: true,
    })
  })

  it('keeps earlier roots when a later root page fails', async () => {
    const { api } = setup((url) =>
      url.searchParams.has('cursor')
        ? Response.json({ code: 'roots_changed' }, { status: 409 })
        : { ...rootResponse, next_cursor: 'v1:200:hash', truncated: true },
    )
    expect(await api.listFolders(deviceId, null)).toMatchObject({
      state: 'ready',
      folders: ['/work'],
      scanLimited: true,
    })
  })

  it('preserves transient failures and keeps entries from an incomplete directory scan', async () => {
    let response: unknown = Response.json({ code: 'node_unavailable' }, { status: 503 })
    const { api } = setup((url) => (url.searchParams.has('root_id') ? response : rootResponse))
    await expect(api.readFile(deviceId, '/work/file')).rejects.toMatchObject({ code: 'unavailable' })
    response = { kind: 'directory', entries: [{ name: 'kept', kind: 'directory' }], truncated: true }
    expect(await api.listFolders(deviceId, '/work/baton')).toMatchObject({
      state: 'ready',
      folders: ['/work/baton/kept'],
      scanLimited: true,
    })
    response = {
      kind: 'directory',
      entries: [{ name: 'kept', kind: 'directory' }],
      truncated: false,
      remainder: { scan_limited: true },
    }
    expect(await api.listFolders(deviceId, '/work/baton')).toMatchObject({
      state: 'ready',
      folders: ['/work/baton/kept'],
      scanLimited: true,
    })
  })
})
