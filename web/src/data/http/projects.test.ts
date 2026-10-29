import { Schema } from 'effect'
import { MemoryRevisionsResponse, type ProjectMemory } from '@baton/protocol'
import { createTransport } from './transport'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { ClientError } from '../client'
import type { Operation, Reference } from '../types'
import type { HttpContext } from './context'
import { createProjectAPI, mapInboxItem, mapProject, mapProjectEntries } from './projects'

function jsonBody(body: RequestInit['body']): string {
  if (typeof body !== 'string') throw new TypeError('Expected a JSON string request body')
  return body
}

const projectId = '11111111-1111-4111-8111-111111111111'
const conversationId = '22222222-2222-4222-8222-222222222222'
const threadId = '33333333-3333-4333-8333-333333333333'
const itemId = '44444444-4444-4444-8444-444444444444'
const noteId = '55555555-5555-4555-8555-555555555555'
const at = '2026-07-01T10:00:00Z'
const base = `/api/v1/projects/${projectId}`
const uuid = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/
const project = {
  id: projectId,
  title: 'Baton',
  goal: 'Ship the coordinator',
  status: 'active' as const,
  agent: { provider: 'openai-codex', model: 'gpt-5.4' },
  memory_embedding: null,
  conversation: { id: conversationId, state: 'active', last_seq: 4 },
  created_at: at,
  updated_at: at,
}
const status = { state: 'idle', pending_inputs: 0, last_seq: 4 }
const memory: ProjectMemory = {
  status: 'active',
  effective: true,
  kind: 'fact',
  basis: 'inferred',
  topic: '',
  conditions: '',
  semantic_key: '',
  core: false,
  valid_from: null,
  valid_until: null,
  time_precision: 'unknown',
  action: 'add',
  reason: '',
  retracted: false,
  source_seq: null,
  successor_id: null,
  suppression_id: null,
  evidence: [],
  id: noteId,
  title: 'Release policy',
  content: 'Run local tests',
  revision: 3,
  author: 'agent' as const,
  updated_at: at,
}
const item = {
  id: itemId,
  project_id: projectId,
  thread_id: threadId,
  source: 'agent' as const,
  title: 'Choose a platform',
  content: 'Which device should run the tests?',
  options: [
    { id: 'linux', label: 'Linux', recommended: true },
    { id: 'mac', label: 'macOS' },
  ],
  allow_text: true,
  state: 'open' as const,
  version: 1,
  created_at: at,
}
const message = { id: 81, client_message_id: 'client-1', content: 'Run the tests', created_at: at }
const event = (
  seq: number,
  kind: string,
  content: NonNullable<Parameters<typeof mapProjectEntries>[1][number]['payload']['message']>['content'],
  extra = {},
) => ({
  conversation_id: conversationId,
  seq,
  kind,
  created_at: at,
  payload: { format: 'pi-ai/1', message: { content, ...extra } },
})
const inputEvent = (seq: number, inputs: unknown[]) =>
  event(seq, 'input', [{ type: 'text', text: JSON.stringify(inputs) }])

interface Reply {
  path: string
  method?: string
  body?: unknown
  response: unknown
  status?: number
}
function setup(replies: Reply[]) {
  const queue = [...replies]
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/v1/me') return new Response(JSON.stringify({ csrf_token: 'csrf-test' }))
    const reply = queue.shift()
    expect(reply, `Unexpected request: ${path}`).toBeDefined()
    expect(path).toBe(reply!.path)
    expect(init?.method ?? 'GET').toBe(reply!.method ?? 'GET')
    if (reply!.body !== undefined) expect(JSON.parse(jsonBody(init?.body))).toEqual(reply!.body)
    return new Response(JSON.stringify(reply!.response), { status: reply!.status ?? 200 })
  })
  vi.stubGlobal('fetch', fetcher)
  const emit = vi.fn()
  const operation = vi.fn<HttpContext['operation']>((kind, targetId, phase, detail = null) => ({
    id: crypto.randomUUID(),
    kind,
    targetId,
    phase,
    detail,
    updatedAt: Date.parse(at),
  }))
  const ctx: HttpContext = {
    request: createTransport({ fetch: fetcher as typeof fetch }).request,
    emit,
    devices: async () => [],
    operation,
  }
  return { api: createProjectAPI(ctx), ctx, emit, operation, fetcher, done: () => expect(queue).toHaveLength(0) }
}

beforeEach(async () => {
  const { webcrypto } = await vi.importActual<{ webcrypto: Crypto }>('node:crypto')
  vi.stubGlobal('crypto', webcrypto)
})
afterEach(() => vi.unstubAllGlobals())

describe('Project and Inbox DTO mapping', () => {
  it('reads one project and its status without listing or enriching unrelated projects', async () => {
    const f = setup([
      { path: base, response: project },
      { path: `${base}/status`, response: status },
    ])
    expect(await f.api.getProject(projectId)).toMatchObject({ id: projectId, name: 'Baton' })
    f.done()
  })

  it('maps the runtime provider, placement reason and current preview', () => {
    expect(mapProject(project, { ...status, state: 'waiting', waiting_reason: 'login_required' })).toMatchObject({
      name: 'Baton',
      subscription: 'ChatGPT',
      model: 'gpt-5.4',
      agent: { state: 'waitingDevice', reason: 'login_required' },
    })
    expect(
      mapProject(
        { ...project, agent: { provider: 'xai', model: 'grok-4' } },
        {
          ...status,
          state: 'running',
          run: { node_id: threadId, effective: true },
          preview: { after_seq: 4, text: 'Checking devices', truncated: true },
        },
      ),
    ).toMatchObject({
      subscription: 'xAI',
      agent: {
        state: 'running',
        deviceId: threadId,
        activity: null,
        preview: { afterSeq: 4, text: 'Checking devices', truncated: true },
      },
    })
    expect(
      mapProject(project, { ...status, state: 'running', preview: { after_seq: 3, text: 'Old preview' } }).agent
        .preview,
    ).toBeNull()
    expect(mapProject({ ...project, agent: { provider: 'xai', model: 'grok-4' } }, status).subscription).toBe('xAI')
  })

  it('distinguishes initial, blocked, stopping, stopped and archived states', () => {
    expect(mapProject(project, { ...status, last_seq: 0 }).agent.state).toBe('notStarted')
    expect(mapProject(project, { ...status, last_seq: 0, pending_inputs: 1 }).agent.state).toBe('idle')
    expect(
      mapProject(project, { ...status, state: 'needs_attention', last_error: 'Login expired' }).agent,
    ).toMatchObject({ state: 'blocked', reason: 'Login expired' })
    const run = { node_id: threadId, effective: false, end_reason: 'user_stopped' }
    expect(mapProject(project, { ...status, run }).agent.state).toBe('stopping')
    expect(mapProject(project, { ...status, run: { ...run, stop_acked_at: at } }).agent.state).toBe('stopped')
    expect(mapProject({ ...project, status: 'archived' }, status)).toMatchObject({
      status: 'archived',
      archivedAt: Date.parse(at),
      agent: { state: 'stopped' },
    })
  })

  it('retains the real block reason while the project is paused', () => {
    expect(
      mapProject(
        { ...project, status: 'paused', conversation: { ...project.conversation, state: 'needs_attention' } },
        { ...status, state: 'paused', last_error: 'Sign-in expired' },
      ),
    ).toMatchObject({ status: 'paused', agent: { state: 'blocked', reason: 'Sign-in expired' } })
  })

  it('does not present a turn with zero replies as a thread reply', async () => {
    const events = [
      inputEvent(1, [
        {
          id: 91,
          source_type: 'turn_ended',
          source_key: `thread:${threadId}:turn:1`,
          payload: { thread_id: threadId, reply_count: 0, reason: 'stopped' },
        },
      ]),
    ]
    expect(await mapProjectEntries(projectId, events, [])).toMatchObject([
      { kind: 'note', body: expect.stringContaining('stopped') },
    ])
  })

  it('maps actual option labels, resolutions and system withdrawals', () => {
    expect(mapInboxItem(item)).toMatchObject({
      kind: 'question',
      options: ['Linux', 'macOS'],
      recommended: 0,
      status: 'pending',
      revision: 1,
      result: null,
    })
    expect(
      mapInboxItem({
        ...item,
        state: 'answered',
        resolution: { employee_id: 'employee-id', option_label: 'macOS', text: 'Use the laptop' },
        resolved_at: at,
      }),
    ).toMatchObject({
      result: { option: 'macOS', note: 'Use the laptop', actor: 'employee-id', at: Date.parse(at), inputId: null },
    })
    expect(
      mapInboxItem({
        ...item,
        source: 'system',
        options: null,
        state: 'withdrawn',
        withdraw_reason: 'Project 已归档',
        resolved_at: at,
      }),
    ).toMatchObject({
      kind: 'system',
      options: [],
      recommended: null,
      status: 'withdrawn',
      result: { reason: 'Project 已归档' },
    })
  })

  it('merges claimed input and queued messages using stable UUIDs', async () => {
    const claimed = inputEvent(1, [
      { id: 81, source_type: 'user_message', source_key: 'user:client-1', payload: { content: message.content } },
    ])
    const pending = await mapProjectEntries(projectId, [], [message])
    const entries = await mapProjectEntries(projectId, [claimed], [message])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual({ ...pending[0], delivery: 'delivered', sourceSeq: 1 })
    expect(entries[0].id).toMatch(uuid)
  })

  it('maps saved assistant text, tool arguments and results, and thread cards', async () => {
    const events = [
      event(1, 'assistant', [
        { type: 'thinking', thinking: 'private reasoning' },
        { type: 'text', text: 'Opening a test thread' },
        {
          type: 'toolCall',
          id: 'call-1',
          name: 'threads.create',
          arguments: { node_id: threadId, message: 'Run tests' },
        },
        {
          type: 'toolCall',
          id: 'call-2',
          name: 'threads.send',
          arguments: { thread_id: threadId, message: 'Run lint too' },
        },
      ]),
      event(2, 'tool_result', [{ type: 'text', text: JSON.stringify({ thread_id: threadId, status: 'waiting' }) }], {
        toolCallId: 'call-1',
        toolName: 'threads.create',
        isError: false,
      }),
      event(3, 'tool_result', [{ type: 'text', text: JSON.stringify({ thread_id: threadId, status: 'running' }) }], {
        toolCallId: 'call-2',
        toolName: 'threads.send',
        isError: false,
      }),
      inputEvent(4, [
        {
          id: 90,
          source_type: 'thread_reply',
          source_key: `thread:${threadId}:reply:1`,
          payload: { thread_id: threadId, content: 'Tests passed' },
        },
      ]),
      event(5, 'assistant', [{ type: 'text', text: 'The tests passed on Linux.' }]),
    ]
    const entries = await mapProjectEntries(projectId, events, [])
    expect(entries).toHaveLength(4)
    expect(entries[0]).toMatchObject({
      kind: 'assistant',
      body: 'Opening a test thread',
      threads: { action: 'opened', threadIds: [threadId] },
      process: expect.arrayContaining([
        {
          kind: 'tool',
          name: 'threads.create',
          input: expect.stringContaining('Run tests'),
          output: expect.stringContaining('waiting'),
          status: 'completed',
        },
      ]),
    })
    expect(entries[1]).toMatchObject({ threads: { action: 'messaged', threadIds: [threadId] } })
    expect(entries[2]).toMatchObject({ body: 'Tests passed', threads: { action: 'replies', threadIds: [threadId] } })
    expect(entries[3]).toMatchObject({ body: 'The tests passed on Linux.', streamAnchor: 4 })
    expect(JSON.stringify(entries)).not.toContain('private reasoning')
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(4)
  })

  it('keeps failed tools and command output without inventing completion facts', async () => {
    const events = [
      event(1, 'assistant', [
        {
          type: 'toolCall',
          id: 'exec',
          name: 'nodes.exec',
          arguments: { node_id: threadId, command: 'pnpm test' },
        },
      ]),
      event(
        2,
        'tool_result',
        [
          {
            type: 'text',
            text: '{"thread_id":"33333333-3333-4333-8333-333333333333","command_result":{"output":"PASS","exit_code":0}}',
          },
        ],
        { toolCallId: 'exec', toolName: 'nodes.exec' },
      ),
      event(3, 'assistant', [{ type: 'toolCall', id: 'failed', name: 'threads.create', arguments: {} }]),
      event(4, 'tool_result', [{ type: 'text', text: '{"thread_id":"ignored","error":"unavailable"}' }], {
        toolCallId: 'failed',
        isError: true,
      }),
    ]
    const entries = await mapProjectEntries(projectId, events, [])
    expect(entries[0]).toMatchObject({
      threads: null,
      process: expect.arrayContaining([
        expect.objectContaining({ kind: 'tool', name: 'nodes.exec', output: expect.stringContaining('PASS') }),
      ]),
    })
    expect(entries[1]).toMatchObject({
      threads: null,
      process: [
        { kind: 'tool', name: 'threads.create', status: 'failed', output: expect.stringContaining('unavailable') },
      ],
    })
    expect(JSON.stringify(entries)).not.toContain('durationMs')
  })

  it('keeps an unfinished tool call as awaiting a result', async () => {
    const entries = await mapProjectEntries(
      projectId,
      [event(1, 'assistant', [{ type: 'toolCall', id: 'pending', name: 'nodes.exec', arguments: { command: 'pwd' } }])],
      [],
    )
    expect(entries[0]).toMatchObject({
      process: [
        { kind: 'tool', name: 'nodes.exec', input: expect.stringContaining('pwd'), output: null, status: 'pending' },
      ],
    })
  })
})

describe('Project HTTP contract', () => {
  it('reads all project pages and fetches authoritative runtime status', async () => {
    const next = '99999999-9999-4999-8999-999999999999'
    const h = setup([
      { path: '/api/v1/projects?limit=100', response: { projects: [project], next_after_id: projectId } },
      {
        path: `${'/api/v1/projects?limit=100'}&after_id=${projectId}`,
        response: { projects: [{ ...project, id: next }] },
      },
      { path: `${base}/status`, response: { ...status, state: 'waiting', waiting_reason: 'runtime_missing' } },
      { path: `/api/v1/projects/${next}/status`, response: status },
    ])
    expect(await h.api.listProjects()).toMatchObject([{ agent: { state: 'waitingDevice' } }, { id: next }])
    h.done()
  })

  it('follows byte-limited event pages and every queued-message page', async () => {
    const h = setup([
      {
        path: `${base}/events?limit=100&after_seq=0`,
        response: {
          events: [event(1, 'assistant', [{ type: 'text', text: 'First reply' }])],
          next_after_seq: 1,
          has_more: true,
        },
      },
      {
        path: `${base}/events?limit=100&after_seq=1`,
        response: {
          events: [event(2, 'assistant', [{ type: 'text', text: 'Second reply' }])],
          next_after_seq: 2,
          has_more: false,
        },
      },
      { path: `${base}/messages?limit=100&after_id=0`, response: { messages: [message], next_after_id: 81 } },
      {
        path: `${base}/messages?limit=100&after_id=81`,
        response: { messages: [{ ...message, id: 82, client_message_id: 'client-2' }] },
      },
    ])
    expect(await h.api.listProjectEntries(projectId)).toHaveLength(4)
    h.done()
  })

  it('reads memory work diagnostics independently of the foreground status', async () => {
    const status = { pending_batches: 2, attention: ['login_required'], jobs: [], has_more: false }
    const h = setup([{ path: `${base}/memory/status`, response: status }])
    expect(await h.api.getMemoryStatus(projectId)).toEqual(status)
    h.done()
  })

  it('reads all memory pages and only includes revisions returned by the server', async () => {
    const h = setup([
      {
        path: `${base}/memory?include_inactive=true&limit=100`,
        response: { entries: [memory], next_after_id: noteId },
      },
      { path: `${base}/memory?include_inactive=true&limit=100&after_id=${noteId}`, response: { entries: null } },
      {
        path: `${base}/memory/${noteId}/revisions?limit=100&after_revision=0`,
        response: {
          revisions: Schema.decodeUnknownSync(MemoryRevisionsResponse)({
            revisions: [
              {
                ...memory,
                revision: 1,
                content: 'Old policy',
                author: 'user',
                updated_at: '2026-06-01T10:00:00Z',
                retracted: true,
              },
            ],
          }).revisions,
          next_after_revision: 1,
        },
      },
      {
        path: `${base}/memory/${noteId}/revisions?limit=100&after_revision=1`,
        response: Schema.decodeUnknownSync(MemoryRevisionsResponse)({ revisions: [memory] }),
      },
    ])
    const [note] = await h.api.listProjectMemory(projectId)
    expect(note).toMatchObject({ id: noteId, body: memory.content, version: 3, source: 'assistant' })
    expect(note.versions).toMatchObject([
      {
        version: 1,
        body: 'Old policy',
        source: 'you',
        updatedAt: Date.parse('2026-06-01T10:00:00Z'),
        details: { retracted: true },
      },
      { version: 3, body: memory.content, source: 'assistant', updatedAt: Date.parse(at) },
    ])
    h.done()
  })

  it('creates a project using a stable client_project_id across client instances', async () => {
    const body = {
      title: 'Baton',
      emoji: '🚀',
      goal: project.goal,
      provider: 'openai-codex',
      model: 'gpt-5.4',
      client_project_id: '66666666-6666-4666-8666-666666666666',
    }
    const h = setup([
      { path: '/api/v1/projects', method: 'POST', body, response: { ...project, emoji: '🚀' } },
      { path: `${base}/status`, response: status },
      { path: '/api/v1/projects', method: 'POST', body, response: { ...project, emoji: '🚀' } },
      { path: `${base}/status`, response: status },
      {
        path: '/api/v1/projects',
        method: 'POST',
        body: { ...body, title: 'Changed' },
        response: { code: 'message_conflict' },
        status: 409,
      },
    ])
    const input = {
      name: 'Baton',
      emoji: '🚀',
      goal: project.goal,
      subscription: 'ChatGPT',
      model: 'gpt-5.4',
      clientId: body.client_project_id,
    }
    expect(await h.api.createProject(input)).toMatchObject({ id: projectId, emoji: '🚀' })
    expect(await createProjectAPI(h.ctx).createProject(input)).toMatchObject({ id: projectId })
    await expect(h.api.createProject({ ...input, name: 'Changed' })).rejects.toMatchObject({ code: 'conflict' })
    h.done()
  })

  it('sends stable UUIDs and persists references separately from message content', async () => {
    const reference: Reference = {
      kind: 'file',
      title: 'server.ts',
      threadId,
      reply: null,
      deviceId: itemId,
      path: '/src/apps/server/src/server.ts',
      lines: { from: 10, to: 12 },
      itemId: null,
      excerpt: '汉'.repeat(4000),
      bytes: 12000,
    }
    const requests: { client_message_id: string; content: string; reference?: Reference }[] = []
    const h = setup([])
    h.ctx.request = async <T>(_path: string, init?: RequestInit) => {
      expect(_path).toBe(`/projects/${projectId}/messages`)
      expect(init?.method).toBe('POST')
      const body = JSON.parse(jsonBody(init?.body)) as (typeof requests)[number]
      requests.push(body)
      return { ...message, ...body } as T
    }
    const input = { projectId, body: 'Explain this code', clientId: 'web-message-1', reference }
    const first = await h.api.sendProjectMessage(input)
    const second = await h.api.sendProjectMessage(input)
    expect(first).toEqual(second)
    expect(requests[0]).toEqual(requests[1])
    expect(requests[0].client_message_id).toMatch(uuid)
    expect(requests[0].content).toBe(input.body)
    expect(requests[0].reference).toEqual({ ...reference, excerpt: '汉'.repeat(2730) })
    expect(first).toMatchObject({
      body: input.body,
      delivery: 'saved',
      reference: { ...reference, excerpt: '汉'.repeat(2730) },
    })
    const claimed = inputEvent(1, [
      {
        id: message.id,
        source_type: 'user_message',
        source_key: `user:${requests[0].client_message_id}`,
        payload: { content: requests[0].content, reference: requests[0].reference },
      },
    ])
    expect((await mapProjectEntries(projectId, [claimed], []))[0]).toEqual({
      ...first,
      delivery: 'delivered',
      sourceSeq: 1,
    })
  })

  it('patches settings and status, and reads project/status after stop and retry', async () => {
    const embedding = {
      base_url: 'http://localhost:11434/v1',
      model: 'local-embed',
      credential_profile: 'local-embeddings',
    }
    const config = { ...embedding, config_id: noteId }
    const h = setup([
      {
        path: base,
        method: 'PATCH',
        body: { title: 'Release', provider: 'xai', model: 'grok-4', memory_embedding: embedding },
        response: { ...project, title: 'Release', memory_embedding: config },
      },
      { path: `${base}/status`, response: status },
      { path: base, method: 'PATCH', body: { memory_embedding: null }, response: project },
      { path: `${base}/status`, response: status },
      { path: base, method: 'PATCH', body: { status: 'paused' }, response: { ...project, status: 'paused' } },
      { path: `${base}/status`, response: { ...status, state: 'paused' } },
      { path: `${base}/stop`, method: 'POST', body: {}, response: { ok: true } },
      { path: base, response: project },
      {
        path: `${base}/status`,
        response: { ...status, run: { node_id: itemId, effective: false, end_reason: 'user_stopped' } },
      },
      { path: `${base}/retry`, method: 'POST', body: {}, response: { ok: true } },
      { path: base, response: project },
      { path: `${base}/status`, response: { ...status, state: 'waiting', waiting_reason: 'scheduling' } },
    ])
    expect(
      await h.api.updateProject({
        projectId,
        patch: { name: 'Release', subscription: 'xAI', model: 'grok-4', memoryEmbedding: config },
      }),
    ).toMatchObject({ memoryEmbedding: config })
    expect(await h.api.updateProject({ projectId, patch: { memoryEmbedding: null } })).toMatchObject({
      memoryEmbedding: null,
    })
    expect(await h.api.setProjectStatus({ projectId, status: 'paused' })).toMatchObject({ status: 'paused' })
    expect((await h.api.stopProjectRun(projectId)).agent.state).toBe('stopping')
    expect((await h.api.retryProject(projectId)).agent.state).toBe('waitingDevice')
    expect(h.emit).toHaveBeenCalledWith('projects', 'inbox', 'messages', 'threads')
    h.done()
  })

  it('preserves an existing memory title and uses optimistic revision checks', async () => {
    const h = setup([
      { path: `${base}/memory/${noteId}`, response: memory },
      {
        path: `${base}/memory/${noteId}`,
        method: 'PUT',
        body: { title: memory.title, content: 'New policy', expected_revision: 3, operation_id: noteId },
        response: { ...memory, content: 'New policy', revision: 4, author: 'user' },
      },
      {
        path: `${base}/memory/${noteId}/revisions?limit=100&after_revision=0`,
        response: {
          revisions: [memory, { ...memory, revision: 4, content: 'New policy', author: 'user' }],
        },
      },
    ])
    expect(
      await h.api.saveMemory({ projectId, noteId, body: 'New policy', version: 3, clientId: noteId }),
    ).toMatchObject({ state: 'saved', note: { version: 4, source: 'you' } })
    h.done()
  })

  it('uses a stable UUID for new memory and reads the latest version after 409', async () => {
    const h = setup([])
    const paths: string[] = []
    let writes = 0
    h.ctx.request = async <T>(path: string, init?: RequestInit) => {
      if (path.includes('/revisions?')) return { revisions: [] } as T
      paths.push(path)
      expect(path.split('/').at(-1)).toMatch(uuid)
      if (init) {
        expect(init.method).toBe('PUT')
        expect(JSON.parse(jsonBody(init.body))).toMatchObject({ expected_revision: 0, content: 'New note' })
        if (++writes === 2)
          throw Object.assign(new ClientError('conflict', 'Changed'), {
            status: 409,
            payload: { current: { ...memory, revision: 1 } },
          })
      }
      return { ...memory, revision: init ? 1 : 2, author: 'user' } as T
    }
    const input = { projectId, noteId: null, body: 'New note', version: null, clientId: 'web-memory-2' }
    expect(await h.api.saveMemory(input)).toMatchObject({ state: 'saved' })
    expect(await h.api.saveMemory(input)).toMatchObject({ state: 'conflict', note: { version: 2 } })
    expect(new Set(paths).size).toBe(1)
  })

  it.each([
    ['Claude', 'anthropic'],
    ['anthropic', 'anthropic'],
    ['registered-provider', 'registered-provider'],
  ])('creates and updates projects with provider %s', async (subscription, provider) => {
    const saved = { ...project, agent: { provider, model: 'local-model' } }
    const h = setup([
      {
        path: '/api/v1/projects',
        method: 'POST',
        body: {
          title: 'Test',
          goal: '',
          provider,
          model: 'local-model',
          client_project_id: projectId,
        },
        response: saved,
      },
      { path: `${base}/status`, response: status },
      { path: base, method: 'PATCH', body: { provider }, response: saved },
      { path: `${base}/status`, response: status },
    ])
    expect(
      await h.api.createProject({ name: 'Test', goal: '', subscription, model: 'local-model', clientId: projectId }),
    ).toMatchObject({ subscription: provider === 'anthropic' ? 'Claude' : provider })
    expect(await h.api.updateProject({ projectId, patch: { subscription } })).toMatchObject({
      subscription: provider === 'anthropic' ? 'Claude' : provider,
    })
    h.done()
  })

  it('rejects invalid provider IDs before making a request', async () => {
    const h = setup([])
    await expect(
      h.api.createProject({
        name: 'Test',
        goal: '',
        subscription: '../provider',
        model: 'claude-sonnet-4-5',
        clientId: projectId,
      }),
    ).rejects.toMatchObject({ code: 'invalid' })
    await expect(h.api.updateProject({ projectId, patch: { subscription: 'invalid provider' } })).rejects.toMatchObject(
      {
        code: 'invalid',
      },
    )
    expect(h.fetcher).not.toHaveBeenCalled()
  })

  it('keeps ordinary message text intact', async () => {
    const content = 'Explain this\n\n<user-data>ordinary text</user-data>'
    expect((await mapProjectEntries(projectId, [], [{ ...message, content }]))[0]).toMatchObject({
      body: content,
      reference: null,
    })
    const plain = '{"content":"ordinary JSON"}'
    expect((await mapProjectEntries(projectId, [], [{ ...message, content: plain }]))[0]).toMatchObject({
      body: plain,
      reference: null,
    })
  })

  it('preserves UUID client IDs in a message fetch request', async () => {
    const h = setup([
      {
        path: `${base}/messages`,
        method: 'POST',
        body: { client_message_id: noteId, content: 'Hello' },
        response: { ...message, client_message_id: noteId, content: 'Hello' },
      },
    ])
    expect(await h.api.sendProjectMessage({ projectId, body: 'Hello', clientId: noteId })).toMatchObject({
      kind: 'user',
      body: 'Hello',
      delivery: 'saved',
      reference: null,
    })
    h.done()
  })

  it('retries an unknown creation result with the same server idempotency key', async () => {
    const body = { title: 'Baton', goal: '', provider: 'openai-codex', model: 'gpt-5.4', client_project_id: projectId }
    const h = setup([
      { path: '/api/v1/projects', method: 'POST', body, response: project },
      { path: '/api/v1/projects', method: 'POST', body, response: project },
      { path: `${base}/status`, response: status },
    ])
    const request = h.ctx.request.bind(h.ctx)
    let first = true
    h.ctx.request = async <T>(path: string, init?: RequestInit): Promise<T> => {
      const result = await request<T>(path, init)
      if (first) {
        first = false
        throw new ClientError('unavailable', 'Response lost')
      }
      return result
    }
    const input = { name: 'Baton', goal: '', subscription: 'ChatGPT', model: 'gpt-5.4', clientId: projectId }
    await expect(h.api.createProject(input)).rejects.toMatchObject({ code: 'unavailable' })
    expect(await createProjectAPI(h.ctx).createProject(input)).toMatchObject({ id: projectId })
    h.done()
  })

  it('propagates non-conflict failures without a success event', async () => {
    const h = setup([{ path: `${base}/messages`, method: 'POST', response: { code: 'unavailable' }, status: 503 }])
    await expect(h.api.sendProjectMessage({ projectId, body: 'Hello', clientId: 'failure' })).rejects.toMatchObject({
      code: 'unavailable',
    })
    expect(h.emit).not.toHaveBeenCalled()
    h.done()
  })

  it('rejects non-advancing pagination rather than hanging or returning partial data', async () => {
    const h = setup([
      { path: `${base}/events?limit=100&after_seq=0`, response: { events: [], next_after_seq: 0, has_more: true } },
    ])
    await expect(h.api.listProjectEntries(projectId)).rejects.toMatchObject({ code: 'unavailable' })
    h.done()
  })
})

describe('Inbox HTTP contract', () => {
  it('requests every page including handled items and preserves backend option IDs', async () => {
    const h = setup([
      { path: '/api/v1/inbox?state=all', response: { requests: [item], next_cursor: 'opaque/cursor+token' } },
      {
        path: '/api/v1/inbox?state=all&cursor=opaque%2Fcursor%2Btoken',
        response: { requests: [{ ...item, id: noteId, state: 'resolved', resolved_at: at }] },
      },
      {
        path: `/api/v1/attention-requests/${itemId}/answer`,
        method: 'POST',
        body: {
          expected_version: 1,
          client_request_id: expect.stringMatching(uuid),
          option_id: 'linux',
          text: 'Run all tests',
        },
        response: {
          ...item,
          state: 'answered',
          version: 2,
          resolution: { employee_id: projectId, option_label: 'Linux', text: 'Run all tests' },
          resolved_at: at,
        },
      },
    ])
    expect(await h.api.listInbox()).toHaveLength(2)
    expect(
      await h.api.handleItem({
        itemId,
        revision: 1,
        decision: { kind: 'answer', option: 'Linux', note: 'Run all tests' },
      }),
    ).toMatchObject({ kind: 'answerItem', targetId: itemId, phase: 'done' })
    expect(h.emit).toHaveBeenCalledWith('operations')
    h.done()
  })

  it('returns conflict with the actual winning resolution and emits changes', async () => {
    const current = {
      ...item,
      state: 'answered',
      version: 2,
      resolution: { employee_id: projectId, option_label: 'macOS', text: 'Use my laptop' },
      resolved_at: at,
    }
    const h = setup([
      { path: `/api/v1/attention-requests/${itemId}`, response: item },
      {
        path: `/api/v1/attention-requests/${itemId}/answer`,
        method: 'POST',
        response: { error: 'conflict', current },
        status: 409,
      },
      { path: '/api/v1/inbox?state=all', response: { requests: [current] } },
    ])
    const operation: Operation = await h.api.handleItem({
      itemId,
      revision: 1,
      decision: { kind: 'answer', option: 'Linux', note: '' },
    })
    expect(operation).toMatchObject({ phase: 'conflict', detail: expect.stringContaining('macOS') })
    expect(operation.detail).toContain('Use my laptop')
    expect(h.emit).toHaveBeenCalledWith('projects', 'inbox', 'messages', 'threads')
    expect(await h.api.listInbox()).toMatchObject([
      { status: 'answered', revision: 2, result: { option: 'macOS', note: 'Use my laptop' } },
    ])
    h.done()
  })

  it('closes a system item with an idempotent request ID and no answer fields', async () => {
    const h = setup([
      { path: `/api/v1/attention-requests/${itemId}`, response: { ...item, source: 'system', options: [] } },
      {
        path: `/api/v1/attention-requests/${itemId}/close`,
        method: 'POST',
        body: { expected_version: 1, client_request_id: expect.stringMatching(uuid) },
        response: { ...item, source: 'system', state: 'closed', version: 2 },
      },
    ])
    expect(await h.api.handleItem({ itemId, revision: 1, decision: { kind: 'close' } })).toMatchObject({
      phase: 'done',
    })
    h.done()
  })

  it('recovers current state via GET when a conflict error has no payload', async () => {
    const h = setup([])
    let count = 0
    h.ctx.request = async <T>(_path: string, init?: RequestInit) => {
      if (init) throw new ClientError('conflict', 'Already handled')
      return (
        ++count === 1
          ? item
          : { ...item, state: 'withdrawn', version: 2, withdraw_reason: 'Cancelled', resolved_at: at }
      ) as T
    }
    expect(await h.api.handleItem({ itemId, revision: 1, decision: { kind: 'close' } })).toMatchObject({
      phase: 'conflict',
      detail: expect.stringContaining('Cancelled'),
    })
  })

  it('returns the committed operation when the same answer is retried', async () => {
    const h = setup([])
    const paths: string[] = []
    h.ctx.request = async <T>(path: string, init?: RequestInit): Promise<T> => {
      paths.push(path)
      if (!init) return item as T
      const body = JSON.parse(jsonBody(init.body)) as { client_request_id: string }
      return {
        ...item,
        state: 'answered',
        version: 2,
        resolution: { client_request_id: body.client_request_id, employee_id: projectId, option_label: 'Linux' },
        resolved_at: at,
      } as T
    }
    const decision = { kind: 'answer' as const, option: 'Linux', note: '' }
    expect(await h.api.handleItem({ itemId, revision: 1, decision })).toMatchObject({ phase: 'done' })
    expect(
      await h.api.handleItem({ itemId, revision: 1, decision: { note: '', option: 'Linux', kind: 'answer' } }),
    ).toMatchObject({ phase: 'done' })
    expect(await h.api.handleItem({ itemId, revision: 1, decision: { ...decision, option: 'macOS' } })).toMatchObject({
      phase: 'conflict',
      detail: expect.stringContaining('Linux'),
    })
    expect(paths).toHaveLength(2)
  })

  it('does not submit a stale decision or guess an unknown option ID', async () => {
    const h = setup([{ path: `/api/v1/attention-requests/${itemId}`, response: { ...item, version: 2 } }])
    expect(await h.api.handleItem({ itemId, revision: 1, decision: { kind: 'close' } })).toMatchObject({
      phase: 'conflict',
    })
    await expect(
      h.api.handleItem({ itemId, revision: 2, decision: { kind: 'answer', option: 'Windows', note: '' } }),
    ).rejects.toMatchObject({ code: 'invalid' })
    h.done()
  })
})
