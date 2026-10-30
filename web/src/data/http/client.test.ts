import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { createTransport, HttpError } from './transport'
import { mockDownloads } from '../mock/downloads'
import { createHttpClient, mapDevice } from './client'
import { assistantBlock, capabilityLines, deviceConnectionView, setupNeeded, setupSteps, usableAgents } from '../derive'

function requestURL(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input.toString()
}

function jsonBody(body: RequestInit['body']): string {
  if (typeof body !== 'string') throw new TypeError('Expected a JSON string request body')
  return body
}

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
  it('submits a device update with an empty JSON body', async () => {
    const fetch = fetcher()
      .mockResolvedValueOnce(response({ employee, csrf_token: 'token' }))
      .mockResolvedValueOnce(response({ operation_id: 'operation' }, 202))
    const client = createHttpClient({ fetch, WebSocket: null })
    await client.updateDevice('node/one')
    expect(requestURL(fetch.mock.calls[1]![0])).toBe('/api/v1/nodes/node%2Fone/update')
    expect(fetch.mock.calls[1]![1]).toMatchObject({ method: 'POST', body: '{}' })
  })
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

describe('HTTP downloads', () => {
  it.each([true, false])('reads the anonymous manifest with enabled=%s without fetching a session', async (enabled) => {
    const manifest = mockDownloads(enabled, 'https://baton.local')
    const fetch = fetcher().mockResolvedValueOnce(response(manifest))
    const client = createHttpClient({ fetch, WebSocket: null })
    expect(await client.getDownloads()).toEqual(manifest)
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('/api/v1/downloads')
    expect(init?.method ?? 'GET').toBe('GET')
    expect(new Headers(init?.headers).has('X-CSRF-Token')).toBe(false)
  })
})

it('reads notification baselines and decimal cursors without losing precision', async () => {
  const page = { events: [], cursor: '9007199254740993', has_more: false }
  const fetch = fetcher().mockImplementation(async () => response(page))
  const client = createHttpClient({ fetch, WebSocket: null })
  expect(await client.replayNotifications!()).toEqual(page)
  expect(await client.replayNotifications!(page.cursor)).toEqual(page)
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    '/api/v1/events/replay?limit=100',
    '/api/v1/events/replay?limit=100&after=9007199254740993',
  ])
})

describe('HTTP account and devices', () => {
  it('maps update availability and the management channel independently of business connection', () => {
    const device = mapDevice({
      id: 'desk',
      display_name: 'Desk',
      system: 'linux',
      online: false,
      synced: false,
      revocation_status: 'none',
      update_management_last_seen: '2026-10-30T10:00:00Z',
      update_availability: { status: 'available', version: 'v1.2.3', checked_at: '2026-10-30T09:00:00Z' },
    })
    expect(device).toMatchObject({
      connection: 'offline',
      updateManagementLastSeen: Date.parse('2026-10-30T10:00:00Z'),
      updateAvailability: { status: 'available', version: 'v1.2.3', checkedAt: Date.parse('2026-10-30T09:00:00Z') },
    })
  })
  it.each([
    ['draining', 'neutral', '等待升级'],
    ['ready', 'neutral', '等待升级'],
    ['migrating', 'neutral', '正在升级'],
    ['syncing', 'neutral', '正在升级'],
    ['completed', 'success', '在线'],
    ['failed', 'attention', '升级已暂停'],
    ['cancelled', 'success', '在线'],
  ] as const)('preserves upgrade phase %s separately from the connection', (phase, tone, label) => {
    const device = mapDevice({
      id: 'desk',
      display_name: 'Desk',
      system: 'linux',
      online: true,
      synced: true,
      revocation_status: 'none',
      upgrade_state: {
        operation_id: 'upgrade-one',
        source_version: '0.9.1',
        target_version: '0.9.2',
        phase,
      },
    })
    expect(device).toMatchObject({
      connection: 'online',
      upgradeState: {
        operationId: 'upgrade-one',
        sourceVersion: '0.9.1',
        targetVersion: '0.9.2',
        phase,
      },
    })
    expect(deviceConnectionView(device, [], Date.now())).toEqual({ tone, label })
    if (phase !== 'cancelled' && phase !== 'completed') {
      for (const connection of ['offline', 'syncing'] as const) {
        expect(deviceConnectionView({ ...device, connection }, [], Date.now())).toEqual({ tone, label })
      }
    }
  })

  it.each([undefined, null])('keeps ordinary status when upgrade state is %s', (upgrade_state) => {
    const device = mapDevice({
      id: 'desk',
      display_name: 'Desk',
      system: 'linux',
      online: true,
      synced: true,
      revocation_status: 'none',
      upgrade_state,
    })
    expect(device.upgradeState).toBeNull()
    expect(deviceConnectionView(device, [], Date.now())).toEqual({ tone: 'success', label: '在线' })
  })

  it.each(['active', 'idle_expired', 'revoked'] as const)('maps device credentials in state %s', (state) => {
    const expiresAt = '2026-07-01T12:00:00Z'
    const device = mapDevice({
      id: 'desk',
      display_name: 'Desk',
      system: 'linux',
      online: true,
      synced: true,
      revocation_status: 'none',
      credential_state: state,
      idle_expires_at: expiresAt,
    })
    expect(device).toMatchObject({
      credentialState: state,
      idleExpiresAt: Date.parse(expiresAt),
      connection: state === 'active' ? 'online' : 'offline',
    })
    if (state === 'idle_expired')
      expect(deviceConnectionView(device, [], Date.now())).toEqual({ tone: 'attention', label: '需要登录' })
  })

  it.each([undefined, 'node/id'])('issues a setup code for %s and polls its existing enrollment', async (nodeId) => {
    const issued = {
      enrollment_id: 'enrollment/id',
      enrollment_token: 'sample-setup-code',
      expires_at: '2026-07-01T12:00:00Z',
      expires_in_ms: 600_000,
    }
    const fetch = fetcher()
      .mockResolvedValueOnce(response({ employee, csrf_token: 'enrollment-csrf' }))
      .mockResolvedValueOnce(response(issued))
      .mockResolvedValueOnce(
        response({ ...issued, enrollment_token: undefined, state: 'connected', node_id: 'node/id' }),
      )
    const client = createHttpClient({ fetch, WebSocket: null, origin: 'https://baton.local' })
    expect(await client.createEnrollment(nodeId)).toEqual({
      id: 'enrollment/id',
      code: 'sample-setup-code',
      state: 'pending',
      coordinatorUrl: 'https://baton.local',
      expiresIn: 600_000,
      deviceId: null,
    })
    const [url, init] = fetch.mock.calls[1]
    expect(url).toBe(nodeId === undefined ? '/api/v1/node-enrollments' : '/api/v1/nodes/node%2Fid/reauth-enrollments')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe('{}')
    expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('enrollment-csrf')
    const connected = await client.getEnrollment('enrollment/id')
    expect(connected).toMatchObject({ state: 'connected', deviceId: 'node/id' })
    expect(connected).not.toHaveProperty('code')
    expect(fetch.mock.calls[2][0]).toBe('/api/v1/node-enrollments/enrollment%2Fid')
  })

  it.each([
    ['available', true, true],
    ['available', false, false],
    ['available', undefined, false],
    ['unverified', true, false],
    ['unavailable', true, false],
    ['future-status', true, false],
  ])('preserves Cursor status %s, create %s and the reported reason', (status, create, enabled) => {
    const device = mapDevice({
      id: 'cursor-device',
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
            status,
            reason: 'Local sandbox needs setup.',
            models: [],
            default_model: '',
            capabilities: { create, queue: true, steer: false, stop: true, resume: true, switch_model: false },
          },
        ],
      },
    })
    expect(device.agents[0]).toMatchObject({
      kind: 'cursor',
      status,
      reason: 'Local sandbox needs setup.',
      models: [],
      defaultModel: null,
      abilities: { create: create === true, steer: false, resume: true },
    })
    expect(usableAgents(device)).toHaveLength(enabled ? 1 : 0)
    if (!enabled) expect(capabilityLines(device)[0]).toMatchObject({ ok: false, detail: 'Local sandbox needs setup.' })
  })

  it('loads all allowed folders from management pages independently of reports', async () => {
    const fetch = fetcher()
      .mockResolvedValueOnce(response({ roots: [{ root_id: 'one', path: '/one' }], next_cursor: 'version:1' }))
      .mockResolvedValueOnce(response({ roots: [{ root_id: 'two', path: '/two' }] }))
    const client = createHttpClient({ fetch, WebSocket: null })
    expect(await client.listDeviceFolders('node/id')).toEqual(['/one', '/two'])
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/nodes/node%2Fid/roots',
      '/api/v1/nodes/node%2Fid/roots?cursor=version%3A1',
    ])
  })

  it('fails a changed roots list so retry starts from its first page', async () => {
    const fetch = fetcher()
      .mockResolvedValueOnce(response({ roots: [{ root_id: 'old', path: '/old' }], next_cursor: 'version:1' }))
      .mockResolvedValueOnce(response({ code: 'roots_changed' }, 409))
      .mockResolvedValueOnce(response({ roots: [{ root_id: 'new', path: '/new' }] }))
    const client = createHttpClient({ fetch, WebSocket: null })
    await expect(client.listDeviceFolders('desk')).rejects.toMatchObject({ code: 'conflict' })
    expect(await client.listDeviceFolders('desk')).toEqual(['/new'])
  })

  it('adds and removes shared folders and notifies device and file queries', async () => {
    const node = {
      id: 'node/id',
      display_name: 'Desk',
      system: 'linux',
      online: true,
      synced: true,
      revocation_status: 'none',
      runtime_report: { roots: [{ path: '/work' }], repos: [{ path: '/work/repo' }] },
    }
    const fetch = fetcher()
      .mockResolvedValueOnce(response({ employee, csrf_token: 'folder-csrf' }))
      .mockResolvedValueOnce(response(node))
      .mockResolvedValueOnce(response({ ...node, runtime_report: { roots: [], repos: [] } }))
    const client = createHttpClient({ fetch, WebSocket: null })
    const listener = vi.fn()
    const unsubscribe = client.subscribe(listener)
    expect(await client.addDeviceFolder({ deviceId: node.id, path: '/work' })).toMatchObject({
      folders: ['/work'],
      repos: ['/work/repo'],
    })
    expect(await client.removeDeviceFolder({ deviceId: node.id, path: '/work' })).toMatchObject({
      folders: [],
      repos: [],
    })
    for (const [index, method] of [
      [1, 'POST'],
      [2, 'DELETE'],
    ] as const) {
      const [url, init] = fetch.mock.calls[index]
      expect(url).toBe('/api/v1/nodes/node%2Fid/roots')
      expect(init?.method).toBe(method)
      expect(JSON.parse(jsonBody(init?.body))).toEqual({ path: '/work' })
      expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('folder-csrf')
    }
    expect(listener.mock.calls.map(([event]) => event.topics)).toEqual([
      ['devices', 'files'],
      ['devices', 'files'],
    ])
    unsubscribe()
  })

  it.each([
    ['openai-codex', 'ChatGPT'],
    ['xai', 'xAI'],
  ])('starts a %s device login without claiming it is complete', async (provider, name) => {
    const fetch = fetcher()
      .mockResolvedValueOnce(response({ employee, csrf_token: 'login-csrf' }))
      .mockResolvedValueOnce(
        response({
          provider,
          verification_uri: 'https://example.test/device',
          user_code: 'CODE-1234',
          expires_in_seconds: 600,
        }),
      )
    const client = createHttpClient({ fetch, WebSocket: null })
    expect(await client.startSubscriptionLogin({ deviceId: 'desk', provider: name })).toEqual({
      provider: name,
      verificationUri: 'https://example.test/device',
      userCode: 'CODE-1234',
      expiresInSeconds: 600,
    })
    const [url, init] = fetch.mock.calls[1]
    expect(url).toBe('/api/v1/nodes/desk/subscriptions/login')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(jsonBody(init?.body))).toEqual({ provider: name })
    expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('login-csrf')
  })

  it('propagates invalid folder and offline login responses without emitting changes', async () => {
    const fetch = fetcher()
      .mockResolvedValueOnce(response({ employee, csrf_token: 'csrf' }))
      .mockResolvedValueOnce(response({ code: 'invalid_path' }, 400))
      .mockResolvedValueOnce(response({ code: 'node_offline' }, 503))
    const client = createHttpClient({ fetch, WebSocket: null })
    const listener = vi.fn()
    const unsubscribe = client.subscribe(listener)
    await expect(client.addDeviceFolder({ deviceId: 'desk', path: 'relative' })).rejects.toMatchObject({
      status: 400,
      code: 'invalid',
    })
    await expect(client.startSubscriptionLogin({ deviceId: 'desk', provider: 'ChatGPT' })).rejects.toMatchObject({
      status: 503,
      code: 'unavailable',
    })
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

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
            capabilities: { create: true, queue: true, steer: false, stop: true, resume: true, switch_model: true },
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
    expect(capabilityLines(device)).toContainEqual({ name: '项目助手', ok: true, detail: 'xAI 已登录' })
    node.runtime_report.project_runtime.providers[0].status = 'login_required'
    expect(capabilityLines(mapDevice(node))).toContainEqual({
      name: '项目助手',
      ok: false,
      detail: '需要登录订阅账号',
    })
  })

  it('preserves unknown subscription diagnostics, permits attempts and keeps login-required blocked', () => {
    const device = mapDevice({
      id: 'node',
      display_name: 'Mac',
      system: 'macos',
      online: true,
      synced: true,
      revocation_status: 'none',
      runtime_report: {
        project_runtime: {
          providers: [{ provider: 'openai-codex', status: 'unknown', reason: 'credential_read_failed' }],
        },
      },
    })
    expect(device.subscriptions[0]).toMatchObject({
      status: 'unknown',
      reason: 'credential_read_failed',
      signedIn: false,
    })
    expect(assistantBlock(device, 'ChatGPT')).toBeNull()
    expect(setupNeeded(device)).toBe(false)
    expect(capabilityLines(device)).toContainEqual({
      name: '项目助手',
      ok: true,
      detail: 'ChatGPT 无法检查登录状态 · 可以尝试',
    })
    for (const [reason, detail] of Object.entries({
      credential_permissions_invalid: '凭据文件权限不安全',
      credential_owner_invalid: '凭据文件属于其他用户',
      credential_path_invalid: '凭据路径无效',
      credential_private_file_failed: '无法安全地打开凭据文件',
    })) {
      device.subscriptions = [{ provider: 'ChatGPT', signedIn: false, status: 'unknown', reason }]
      expect(capabilityLines(device).find((line) => line.name === '项目助手')?.detail).toContain(detail)
      expect(setupSteps(device)).toContain(detail)
      expect(setupNeeded(device)).toBe(true)
    }
    device.subscriptions = [{ provider: 'ChatGPT', signedIn: false, status: 'login_required' }]
    expect(assistantBlock(device, 'ChatGPT')).toBe('signedOut')
    expect(setupNeeded(device)).toBe(true)
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

  it('does not retry a login even when the server rejects CSRF', async () => {
    const fetch = fetcher().mockResolvedValue(response({ code: 'csrf_rejected' }, 403))
    await expect(createHttpClient({ fetch, WebSocket: null }).signIn('alice', 'password')).rejects.toBeInstanceOf(
      HttpError,
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps initial-password sessions out of device requests', async () => {
    const fetch = fetcher().mockResolvedValueOnce(
      response({ employee: { ...employee, must_change_password: true }, csrf_token: 'initial' }),
    )
    expect(await createHttpClient({ fetch, WebSocket: null }).getSession()).toMatchObject({ mustChangePassword: true })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('uses fast fallback before ready, calibrates on ready and visibility, and cleans up timers', async () => {
    vi.useFakeTimers()
    class Socket {
      static current: Socket
      onmessage: ((event: { data: string }) => void) | null = null
      onclose: (() => void) | null = null
      constructor() {
        Socket.current = this
      }
      close() {
        this.onclose?.()
      }
      receive(value: unknown) {
        this.onmessage?.({ data: JSON.stringify(value) })
      }
    }
    const fetch = fetcher()
      .mockResolvedValueOnce(response({ employee, csrf_token: 'current' }))
      .mockResolvedValueOnce(response({ nodes: [], default_device: {} }))
    const client = createHttpClient({ fetch, WebSocket: Socket as unknown as typeof WebSocket, pollInterval: 2000 })
    const changes = vi.fn()
    const unsubscribe = client.subscribe(changes)
    await client.getSession()
    await vi.advanceTimersByTimeAsync(2000)
    expect(changes.mock.calls.some(([event]) => event.topics.includes('threads'))).toBe(true)
    changes.mockClear()
    Socket.current.receive({ type: 'ready' })
    expect(changes.mock.calls.some(([event]) => event.topics.includes('threads'))).toBe(true)
    changes.mockClear()
    await vi.advanceTimersByTimeAsync(2000)
    expect(changes.mock.calls.some(([event]) => event.topics.includes('threads'))).toBe(false)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(changes.mock.calls.some(([event]) => event.topics.includes('threads'))).toBe(true)
    changes.mockClear()
    unsubscribe()
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(30000)
    expect(changes).not.toHaveBeenCalled()
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
    const changes = vi.fn()
    const unsubscribe = client.subscribe(changes)
    await client.getSession()
    const listener = vi.fn()
    const stopOutput = client.subscribeOutput!('thread', listener)
    const first = Socket.instances[0]
    expect(first.url).toBe('wss://baton.test/api/v1/events')
    expect(first.send).not.toHaveBeenCalled()
    first.receive({ type: 'ready' })
    expect(changes).toHaveBeenLastCalledWith({ topics: [], browserEvent: { type: 'ready' } })
    const notification = {
      type: 'notification',
      event_id: '00000000-0000-4000-8000-000000000001',
      cursor: '12',
      kind: 'question',
      thread_id: '00000000-0000-4000-8000-000000000002',
      project_id: '00000000-0000-4000-8000-000000000003',
      title: 'Reconnect',
      body: 'Which branch?',
    }
    first.receive(notification)
    expect(changes).toHaveBeenLastCalledWith({ topics: [], browserEvent: notification })
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

  it('refreshes a reason-only device report from devices.changed without treating the event as capability data', async () => {
    class Socket {
      static instance: Socket
      onmessage: ((event: { data: string }) => void) | null = null
      constructor() {
        Socket.instance = this
      }
      close() {}
      receive(value: unknown) {
        this.onmessage?.({ data: JSON.stringify(value) })
      }
    }
    let reason = 'Checking local sandbox.'
    const fetch = fetcher().mockImplementation(async (url) => {
      if (requestURL(url).endsWith('/me')) return response({ employee })
      return response({
        nodes: [
          {
            id: 'desk',
            display_name: 'Desk',
            system: 'linux',
            online: true,
            synced: true,
            revocation_status: 'none',
            runtime_report: {
              agents: [
                {
                  agent_type: 'cursor',
                  version: '1',
                  status: 'unverified',
                  reason,
                  models: [],
                  default_model: '',
                  capabilities: { create: false },
                },
              ],
            },
          },
        ],
        default_device: {},
      })
    })
    const client = createHttpClient({ fetch, WebSocket: Socket as unknown as typeof WebSocket })
    const listener = vi.fn()
    const unsubscribe = client.subscribe(listener)
    try {
      await client.getSession()
      expect((await client.listDevices())[0].agents[0].reason).toBe(reason)
      reason = 'Local sandbox unavailable.'
      Socket.instance.receive({ type: 'devices.changed', node_id: 'desk', report_version: 2 })
      expect(listener).toHaveBeenLastCalledWith({ topics: ['devices', 'files'] })
      expect((await client.listDevices())[0].agents[0].reason).toBe(reason)
      listener.mockClear()
      Socket.instance.receive({ type: 'devices.changed', node_id: 'desk', report_version: -1 })
      Socket.instance.receive({ type: 'devices.changed', node_id: 'desk' })
      expect(listener).not.toHaveBeenCalled()
    } finally {
      unsubscribe()
    }
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
