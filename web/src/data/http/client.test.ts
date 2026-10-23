import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTransport, HttpError } from './transport'
import { createHttpClient, mapDevice } from './client'
import { capabilityLines, setupNeeded } from '../derive'

const employee = {
  id: 'cc263ca7-58b5-48bc-b9b6-895141a9a951',
  username: 'alice',
  display_name: 'Alice',
  must_change_password: false,
}
const response = (value: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
const fetcher = () => vi.fn<typeof fetch>()
afterEach(() => vi.useRealTimers())

describe('HTTP transport', () => {
  it('uses session cookies and recovers CSRF from me before a write', async () => {
    const fetch = fetcher()
      .mockResolvedValueOnce(response({ employee, csrf_token: 'csrf-one' }))
      .mockResolvedValueOnce(response({ ok: true }))
    const client = createTransport({ fetch })
    await client.request('/projects', { method: 'POST', body: JSON.stringify({ title: 'Release' }) })
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/v1/me', '/api/v1/projects'])
    const init = fetch.mock.calls[1][1]!
    expect(init.credentials).toBe('same-origin')
    expect(new Headers(init.headers).get('X-CSRF-Token')).toBe('csrf-one')
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json')
  })

  it('refreshes a rejected CSRF token and retries only the rejected request', async () => {
    const fetch = fetcher()
      .mockResolvedValueOnce(response({ employee, csrf_token: 'first' }))
      .mockResolvedValueOnce(response({ code: 'csrf_rejected' }, 403))
      .mockResolvedValueOnce(response({ employee, csrf_token: 'second' }))
      .mockResolvedValueOnce(response({}, 200))
    const { request } = createTransport({ fetch })
    await request('/login', { method: 'POST', body: '{}' })
    await request('/logout', { method: 'POST', body: '{}' })
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(new Headers(fetch.mock.calls[3][1]?.headers).get('X-CSRF-Token')).toBe('second')
  })

  it('preserves authoritative conflict payloads and reports network failure', async () => {
    const current = { id: 'item', state: 'answered' }
    const fetch = fetcher()
      .mockResolvedValueOnce(response({ error: 'conflict', current }, 409))
      .mockRejectedValueOnce(new Error('socket closed'))
    const { request } = createTransport({ fetch })
    await expect(request('/attention-requests/item')).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
      payload: { current },
    })
    await expect(request('/me')).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('does not accept an HTML page as a successful API response', async () => {
    const fetch = fetcher().mockResolvedValueOnce(new Response('<html>not the API</html>', { status: 200 }))
    await expect(createTransport({ fetch }).request('/me')).rejects.toMatchObject({ code: 'unavailable' })
  })
})

describe('HTTP account and devices', () => {
  it('maps the server report without inventing models or installed programs', () => {
    const device = mapDevice({
      id: 'node',
      display_name: 'Mac',
      system: 'macos',
      online: true,
      synced: true,
      revocation_status: 'none',
      registered_at: '2026-01-01T00:00:00Z',
      runtime_report: {
        agents: [
          {
            agent_type: 'codex',
            version: '1.2.3',
            status: 'available',
            default_model: 'model-real',
            models: [{ id: 'model-real' }],
            capabilities: { queue: true, steer: false, stop: true, resume: true, switch_model: true },
          },
        ],
        project_runtime: {
          providers: [{ provider: 'openai-codex', status: 'available', models: [{ id: 'model-real' }] }],
        },
        exec: { enabled: false, shell: '/bin/zsh', user: 'alice' },
        roots: [{ path: '/work' }],
        repos: [{ path: '/work/release' }],
      },
    })
    expect(device).toMatchObject({
      os: 'macOS',
      connection: 'online',
      hasRuntime: true,
      folders: ['/work'],
      subscriptions: [{ provider: 'ChatGPT', signedIn: true, models: ['model-real'] }],
      commandAccess: { enabled: false, user: 'alice' },
    })
    expect(device.agents).toHaveLength(1)
    expect(device.agents[0]).toMatchObject({ kind: 'codex', models: ['model-real'], abilities: { steer: false } })
    expect(
      mapDevice({
        id: 'node',
        display_name: 'Mac',
        system: 'macos',
        online: false,
        synced: true,
        revocation_status: 'none',
      }),
    ).toMatchObject({ connection: 'offline', agents: [], folders: [], hasRuntime: false, subscriptions: [] })
  })

  it('accepts a signed-in xAI subscription and describes a first login accurately', () => {
    const node = {
      id: 'node',
      display_name: 'Mac',
      system: 'macos',
      online: true,
      synced: true,
      revocation_status: 'none',
      runtime_report: { project_runtime: { providers: [{ provider: 'xai', status: 'available' }] } },
    }
    const device = mapDevice(node)
    expect(setupNeeded(device)).toBe(false)
    expect(capabilityLines(device)).toContainEqual({ name: 'Project assistant', ok: true, detail: 'xAI signed in' })
    node.runtime_report.project_runtime.providers[0].status = 'login_required'
    expect(capabilityLines(mapDevice(node))).toContainEqual({
      name: 'Project assistant',
      ok: false,
      detail: 'Subscription sign-in needed',
    })
  })

  it('restores a session and its real default device after reload', async () => {
    const fetch = fetcher()
      .mockResolvedValueOnce(response({ employee, csrf_token: 'restored' }))
      .mockResolvedValueOnce(response({ nodes: [], default_device: { node_id: 'default' } }))
    expect(await createHttpClient({ fetch, WebSocket: null }).getSession()).toMatchObject({
      account: { name: 'Alice' },
      defaultDeviceId: 'default',
      mustChangePassword: false,
    })
  })

  it('keeps an authenticated account when device reads fail independently', async () => {
    const fetch = fetcher()
      .mockResolvedValueOnce(response({ employee, csrf_token: 'restored' }))
      .mockResolvedValueOnce(response({ code: 'unavailable' }, 503))
    expect(await createHttpClient({ fetch, WebSocket: null }).getSession()).toMatchObject({
      account: { name: 'Alice' },
      defaultDeviceId: null,
    })
  })

  it('never creates a fake signed-in session after a rejected login', async () => {
    const fetch = fetcher().mockResolvedValueOnce(response({ code: 'invalid_credentials' }, 401))
    const client = createHttpClient({ fetch, WebSocket: null })
    await expect(client.signIn('alice', 'incorrect')).rejects.toBeInstanceOf(HttpError)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps initial-password sessions out of device requests', async () => {
    const fetch = fetcher().mockResolvedValueOnce(
      response({ employee: { ...employee, must_change_password: true }, csrf_token: 'initial' }),
    )
    expect(await createHttpClient({ fetch, WebSocket: null }).getSession()).toMatchObject({ mustChangePassword: true })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('subscribes over the event socket, resumes after reconnecting, and unsubscribes without closing it', async () => {
    vi.useFakeTimers()
    class Socket {
      static instances: Socket[] = []
      readyState = 1
      onmessage: ((event: { data: string }) => void) | null = null
      onclose: (() => void) | null = null
      onerror: (() => void) | null = null
      send = vi.fn()
      url: string
      constructor(url: string) {
        this.url = url
        Socket.instances.push(this)
      }
      receive(value: unknown) {
        this.onmessage?.({ data: JSON.stringify(value) })
      }
      close() {
        this.readyState = 3
        this.onclose?.()
      }
    }
    const fetch = fetcher()
      .mockResolvedValueOnce(response({ employee, csrf_token: 'current' }))
      .mockResolvedValueOnce(response({ nodes: [], default_device: {} }))
      .mockResolvedValueOnce(response({ status: 'running', current_turn: { worker_turn_seq: 1 } }))
      .mockResolvedValueOnce(response({ ok: true, text: ' fallback', cursor: 'epoch:14' }))
    const client = createHttpClient({
      fetch,
      WebSocket: Socket as unknown as typeof WebSocket,
      origin: 'https://baton.test',
      pollInterval: 100,
    })
    const unsubscribe = client.subscribe(vi.fn())
    await client.getSession()
    const listener = vi.fn()
    const stopOutput = client.subscribeOutput!('thread', listener)
    const first = Socket.instances[0]
    expect(first.url).toBe('wss://baton.test/api/v1/events')
    expect(first.send).not.toHaveBeenCalled()
    first.receive({ type: 'ready' })
    expect(JSON.parse(first.send.mock.calls[0][0])).toEqual({ thread_id: 'thread' })
    first.receive({ type: 'thread.output', thread_id: 'thread', ok: true, text: 'stream', cursor: 'epoch:6' })
    expect((await client.readOutput('thread')).chunks).toEqual([{ kind: 'text', text: 'stream' }])
    await vi.advanceTimersByTimeAsync(200)
    expect((await client.readOutput('thread')).chunks).toEqual([{ kind: 'text', text: 'stream' }])
    expect(fetch).toHaveBeenCalledTimes(2)
    first.close()
    expect((await client.readOutput('thread')).chunks).toEqual([{ kind: 'text', text: 'stream fallback' }])
    await vi.advanceTimersByTimeAsync(100)
    const second = Socket.instances[1]
    second.receive({ type: 'ready' })
    expect(JSON.parse(second.send.mock.calls[0][0])).toEqual({ thread_id: 'thread', cursor: 'epoch:14' })
    first.receive({ type: 'thread.output', thread_id: 'thread', ok: true, text: 'late', cursor: 'epoch:18' })
    expect((await client.readOutput('thread')).chunks).toEqual([{ kind: 'text', text: 'stream fallback' }])
    stopOutput()
    expect(JSON.parse(second.send.mock.calls.at(-1)![0])).toEqual({ thread_id: '' })
    expect(second.readyState).toBe(1)
    unsubscribe()
    expect(second.readyState).toBe(3)
    expect(listener).toHaveBeenCalled()
  })

  it('stops polling when the last subscriber leaves', async () => {
    vi.useFakeTimers()
    const fetch = fetcher()
      .mockResolvedValueOnce(response({ employee, csrf_token: 'current' }))
      .mockResolvedValueOnce(response({ nodes: [], default_device: {} }))
    const client = createHttpClient({ fetch, WebSocket: null, pollInterval: 100 })
    const listener = vi.fn()
    const unsubscribe = client.subscribe(listener)
    await client.getSession()
    await vi.advanceTimersByTimeAsync(100)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    await vi.advanceTimersByTimeAsync(500)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
