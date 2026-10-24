import { ClientError, type BatonClient, type ChangeEvent, type Topic } from '../client'
import type { AgentKind, Device, Enrollment, Operation, OperationPhase, Session } from '../types'
import type { HttpContext } from './context'
import { apiPath, timestamp } from './context'
import { createProjectAPI } from './projects'
import { createThreadAPI } from './threads'
import { createOutputAPI, type OutputResult } from './output'
import { createTransport, HttpError } from './transport'

interface RuntimeReport {
  agents?: {
    agent_type: string
    version: string
    status: string
    reason?: string
    default_model: string
    models: { id: string }[]
    capabilities: {
      create?: boolean
      queue: boolean
      steer: boolean
      stop: boolean
      resume: boolean
      switch_model: boolean
    }
  }[]
  project_runtime?: { providers: { provider: string; status: string; models?: { id: string }[] }[] }
  exec?: { enabled: boolean; shell: string; user?: string }
  roots?: { path: string }[]
  repos?: { path: string }[]
}
interface NodeDTO {
  id: string
  display_name: string
  system: string
  online: boolean
  synced: boolean
  revocation_status: string
  last_contact_at?: string
  registered_at?: string
  batond_version?: string
  runtime_report?: RuntimeReport | null
}
interface NodesDTO {
  nodes: NodeDTO[]
  default_device: { node_id?: string; invalid?: boolean }
}
interface MeDTO {
  employee: { id: string; display_name: string; username: string; must_change_password: boolean }
  csrf_token?: string
}
interface EnrollmentDTO {
  enrollment_id?: string
  id?: string
  enrollment_token?: string
  state?: Enrollment['state']
  device_id?: string | null
  node_id?: string | null
  expires_at: string
  expires_in_ms?: number
}

export const subscriptionName = (provider: string) =>
  ({ 'openai-codex': 'ChatGPT', anthropic: 'Claude', xai: 'xAI' })[provider] ?? provider

export function mapDevice(node: NodeDTO): Device {
  const report = node.runtime_report
  const os = /win/i.test(node.system) ? 'Windows' : /mac|darwin/i.test(node.system) ? 'macOS' : 'Linux'
  return {
    id: node.id,
    name: node.display_name,
    os,
    system: node.system,
    batondVersion: node.batond_version ?? 'Not reported',
    connection: node.online && node.revocation_status !== 'pending' ? (node.synced ? 'online' : 'syncing') : 'offline',
    lastSeenAt: timestamp(node.last_contact_at ?? node.registered_at),
    registeredAt: timestamp(node.registered_at),
    agents: (report?.agents ?? [])
      .filter((agent) => ['codex', 'kiro', 'pi', 'cursor'].includes(agent.agent_type))
      .map((agent) => ({
        kind: agent.agent_type as AgentKind,
        status: agent.status,
        reason: agent.reason ?? null,
        version: agent.version === 'unknown' ? null : agent.version,
        models: (agent.models ?? []).map((model) => model.id),
        defaultModel: agent.default_model || null,
        abilities: {
          create: agent.capabilities?.create === true,
          queue: !!agent.capabilities.queue,
          steer: !!agent.capabilities.steer,
          stop: !!agent.capabilities.stop,
          resume: !!agent.capabilities.resume,
          switchModel: !!agent.capabilities.switch_model,
        },
        account: agent.agent_type === 'codex' ? 'ChatGPT' : null,
        problem: agent.status === 'available' ? null : ('unavailable' as const),
      })),
    subscriptions: (report?.project_runtime?.providers ?? []).map((item) => ({
      provider: subscriptionName(item.provider),
      signedIn: item.status === 'available',
      status: item.status === 'available' || item.status === 'login_required' ? item.status : 'unknown',
      models: item.models?.map((model) => model.id) ?? [],
    })),
    hasRuntime: !!report?.project_runtime,
    folders: (report?.roots ?? []).map((root) => root.path),
    repos: (report?.repos ?? []).map((repo) => repo.path),
    commandAccess: {
      enabled: !!report?.exec?.enabled,
      shell: report?.exec?.shell ?? 'Not reported',
      user: report?.exec?.user ?? 'Device user',
    },
  }
}

export interface HttpClientOptions {
  fetch?: typeof fetch
  baseUrl?: string
  origin?: string
  WebSocket?: typeof WebSocket | null
  pollInterval?: number
}

export function createHttpClient(options: HttpClientOptions = {}): BatonClient {
  const listeners = new Set<(event: ChangeEvent) => void>()
  const operations = new Map<
    string,
    { operation: Operation; refresh?: () => Promise<{ phase: OperationPhase; detail?: string | null }> }
  >()
  let signedIn = false
  let ended: Session['ended'] = null
  let timer: ReturnType<typeof setInterval> | null = null
  let socket: WebSocket | null = null
  let nodeRead: Promise<NodesDTO> | null = null
  const emit = (...topics: Topic[]) => {
    for (const listener of listeners) listener({ topics })
  }
  const transport = createTransport({
    ...options,
    onUnauthorized: () => {
      if (signedIn) {
        signedIn = false
        ended = 'expired'
        stop()
        output.clear()
        emit('session')
      }
    },
  })
  const request = transport.request
  const output = createOutputAPI(request)
  const nodes = () => {
    if (!nodeRead) {
      const pending = request<NodesDTO>('/nodes').finally(() => {
        if (nodeRead === pending) nodeRead = null
      })
      nodeRead = pending
    }
    return nodeRead
  }
  const listDevices = async () =>
    (await nodes()).nodes.filter((node) => node.revocation_status !== 'effective').map(mapDevice)
  const operation: HttpContext['operation'] = (kind, targetId, phase, detail = null, refresh) => {
    const value = { id: crypto.randomUUID(), kind, targetId, phase, detail, updatedAt: Date.now() }
    operations.set(value.id, { operation: value, refresh })
    return value
  }
  const ctx: HttpContext = { request, emit, devices: listDevices, operation }
  const origin = options.origin ?? globalThis.location?.origin ?? 'https://localhost'
  const enrollment = (value: EnrollmentDTO): Enrollment => ({
    id: value.enrollment_id ?? value.id ?? '',
    state: value.state ?? 'pending',
    coordinatorUrl: origin,
    expiresIn: Math.max(0, value.expires_in_ms ?? timestamp(value.expires_at) - Date.now()),
    deviceId: value.device_id ?? value.node_id ?? null,
  })

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
    const previous = socket
    socket = null
    output.setConnection(null)
    previous?.close()
  }
  function start() {
    if (!signedIn || listeners.size === 0 || timer) return
    timer = setInterval(() => {
      emit('devices', 'projects', 'threads', 'messages', 'inbox', 'operations', 'files')
      if (!socket) connectSocket()
    }, options.pollInterval ?? 2000)
    connectSocket()
  }
  function connectSocket() {
    const Socket = options.WebSocket === undefined ? globalThis.WebSocket : options.WebSocket
    if (!Socket || !signedIn || listeners.size === 0) return
    const url = new URL(`${options.baseUrl ?? '/api/v1'}/events`, origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const next = new Socket(url.href)
    socket = next
    next.onmessage = (event) => {
      if (socket !== next) return
      let message: OutputResult & { type?: string; thread_id?: string; node_id?: string; report_version?: number }
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message.type === 'ready') {
        output.setConnection((subscription) => {
          if (socket === next && next.readyState === 1) next.send(JSON.stringify(subscription))
        })
      }
      if (
        message.type === 'devices.changed' &&
        typeof message.node_id === 'string' &&
        message.node_id.length > 0 &&
        Number.isSafeInteger(message.report_version) &&
        (message.report_version ?? -1) >= 0
      ) {
        nodeRead = null
        emit('devices', 'files')
      }
      if (message.type === 'thread.changed') emit('threads', 'messages', 'operations')
      if (message.type === 'thread.output' && message.thread_id) output.receive(message.thread_id, message)
    }
    next.onclose = () => {
      if (socket === next) {
        socket = null
        output.setConnection(null)
        emit('session')
      }
    }
    next.onerror = () => next.close()
  }
  const getSession = async (): Promise<Session> => {
    try {
      const me = await request<MeDTO>('/me')
      signedIn = true
      ended = null
      start()
      let defaultDeviceId: string | null = null
      if (!me.employee.must_change_password) {
        try {
          const all = await nodes()
          if (!all.default_device.invalid) defaultDeviceId = all.default_device.node_id || null
        } catch (cause) {
          if (cause instanceof HttpError && cause.status === 401) throw cause
        }
      }
      return {
        account: { id: me.employee.id, name: me.employee.display_name, username: me.employee.username },
        defaultDeviceId,
        ended,
        mustChangePassword: me.employee.must_change_password,
      }
    } catch (cause) {
      if (cause instanceof HttpError && cause.status === 401) return { account: null, defaultDeviceId: null, ended }
      throw cause
    }
  }

  return {
    mode: 'http',
    ...createThreadAPI(ctx, output),
    subscribeOutput: (id, listener) => output.subscribeOutput(id, listener),
    ...createProjectAPI(ctx),
    getSession,
    async signIn(username, password) {
      await request('/login', { method: 'POST', body: JSON.stringify({ username, password }) })
      return getSession()
    },
    async signOut() {
      await request('/logout', { method: 'POST', body: '{}' })
      signedIn = false
      ended = null
      stop()
      transport.clear()
      output.clear()
      operations.clear()
      emit('session')
    },
    async changePassword(currentPassword, newPassword) {
      await request('/me/password', {
        method: 'POST',
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
      })
      transport.clear()
      signedIn = false
      stop()
      output.clear()
      return { account: null, defaultDeviceId: null, ended: null }
    },
    listDevices,
    async getOperation(id) {
      const found = operations.get(id)
      if (!found)
        throw new ClientError('notFound', 'This operation is no longer available. Reload the thread to see its state.')
      if (found.refresh && !['done', 'failed', 'conflict', 'stopped'].includes(found.operation.phase))
        Object.assign(found.operation, await found.refresh(), { updatedAt: Date.now() })
      return { ...found.operation }
    },
    async setDefaultDevice(deviceId) {
      await request('/me/default-device', { method: 'PUT', body: JSON.stringify({ node_id: deviceId }) })
      emit('session', 'devices')
      return getSession()
    },
    async addDeviceFolder({ deviceId, path }) {
      const value = await request<NodeDTO>(`/nodes/${apiPath(deviceId)}/roots`, {
        method: 'POST',
        body: JSON.stringify({ path }),
      })
      emit('devices', 'files')
      return mapDevice(value)
    },
    async removeDeviceFolder({ deviceId, path }) {
      const value = await request<NodeDTO>(`/nodes/${apiPath(deviceId)}/roots`, {
        method: 'DELETE',
        body: JSON.stringify({ path }),
      })
      emit('devices', 'files')
      return mapDevice(value)
    },
    async startSubscriptionLogin({ deviceId, provider }) {
      const value = await request<{
        provider: string
        verification_uri: string
        user_code: string
        expires_in_seconds: number
      }>(`/nodes/${apiPath(deviceId)}/subscriptions/login`, {
        method: 'POST',
        body: JSON.stringify({ provider }),
      })
      return {
        provider: subscriptionName(value.provider),
        verificationUri: value.verification_uri,
        userCode: value.user_code,
        expiresInSeconds: value.expires_in_seconds,
      }
    },
    async setCommandAccess({ deviceId, enabled }) {
      const value = await request<NodeDTO>(`/nodes/${apiPath(deviceId)}/project-exec`, {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      })
      emit('devices')
      return mapDevice(value)
    },
    async removeDevice(deviceId) {
      let result = await request<{ status: string }>(`/nodes/${apiPath(deviceId)}/revoke`, {
        method: 'POST',
        body: '{}',
      })
      for (let attempt = 0; result.status === 'pending' && attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        const node = await request<NodeDTO>(`/nodes/${apiPath(deviceId)}`)
        result = { status: node.revocation_status }
      }
      emit('devices', 'session', 'threads', 'projects', 'files')
      if (result.status !== 'effective')
        throw new ClientError('unavailable', 'Disconnect is still being confirmed. Try again.')
    },
    async createEnrollment() {
      const value = await request<EnrollmentDTO>('/node-enrollments', { method: 'POST', body: '{}' })
      return { ...enrollment(value), code: value.enrollment_token ?? '' }
    },
    async getEnrollment(id) {
      return enrollment(await request<EnrollmentDTO>(`/node-enrollments/${apiPath(id)}`))
    },
    subscribe(listener) {
      listeners.add(listener)
      start()
      return () => {
        listeners.delete(listener)
        if (!listeners.size) stop()
      }
    },
  }
}
