import type { DownloadsResponse } from '@baton/protocol/http-api'
import type { ActivitySnapshot, BrowserEvent } from '@baton/protocol'
import { ClientError, type BatonClient, type ChangeEvent, type NotificationReplay, type Topic } from '../client'
import type { AgentKind, Device, Enrollment, Operation, OperationPhase, Session } from '../types'
import type { HttpContext } from './context'
import { apiPath, timestamp } from './context'
import { createProjectAPI } from './projects'
import { createThreadAPI } from './threads'
import { createExecutionAPI } from './executions'
import { createOutputAPI, type OutputResult } from './output'
import { createTransport, HttpError } from './transport'

interface RuntimeReport {
  update_protocol?: number
  agents?: {
    agent_type: string
    version: string
    status: string
    reason?: string
    default_model: string
    runtime_modes?: Device['agents'][number]['runtimeModes']
    default_runtime_mode?: Device['agents'][number]['defaultRuntimeMode']
    models: { id: string; thinking?: import('@baton/protocol').ThinkingCapability }[]
    capabilities: {
      create?: boolean
      queue: boolean
      steer: boolean
      stop: boolean
      resume: boolean
      switch_model: boolean
    }
  }[]
  project_runtime?: {
    providers: {
      provider: string
      status: string
      reason?: string
      models?: { id: string }[]
      connection?: {
        id: string
        name: string
        protocol: 'openai-responses' | 'openai-completions' | 'anthropic-messages'
        base_url: string
      }
      login_methods?: ('oauth' | 'api_key' | 'device_code')[]
      models_truncated?: boolean
    }[]
  }
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
  credential_state?: Device['credentialState']
  idle_expires_at?: string
  last_contact_at?: string
  registered_at?: string
  batond_version?: string
  runtime_report?: RuntimeReport | null
  update_management_last_seen?: string | null
  update_availability?: { status: 'current' | 'available'; version: string; checked_at: string } | null
  update_request?: {
    operation_id: string
    attempt: number
    phase: import('@baton/protocol').NodeUpdateRequest['phase']
    reason?: string
    management_last_seen?: string
  } | null
  upgrade_state?: {
    operation_id: string
    source_version: string
    target_version: string
    phase: NonNullable<Device['upgradeState']>['phase']
  } | null
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
  const online =
    node.online &&
    node.revocation_status !== 'pending' &&
    node.credential_state !== 'idle_expired' &&
    node.credential_state !== 'revoked'
  return {
    id: node.id,
    name: node.display_name,
    os,
    system: node.system,
    batondVersion: node.batond_version ?? '未报告',
    updateProtocol: report?.update_protocol,
    updateRequest: node.update_request
      ? {
          operationId: node.update_request.operation_id,
          attempt: node.update_request.attempt,
          phase: node.update_request.phase,
          reason: node.update_request.reason,
        }
      : undefined,
    updateManagementLastSeen: node.update_management_last_seen
      ? timestamp(node.update_management_last_seen)
      : undefined,
    updateAvailability: node.update_availability
      ? {
          status: node.update_availability.status,
          version: node.update_availability.version,
          checkedAt: timestamp(node.update_availability.checked_at),
        }
      : undefined,
    connection: online ? (node.synced ? 'online' : 'syncing') : 'offline',
    upgradeState: node.upgrade_state
      ? {
          operationId: node.upgrade_state.operation_id,
          sourceVersion: node.upgrade_state.source_version,
          targetVersion: node.upgrade_state.target_version,
          phase: node.upgrade_state.phase,
        }
      : null,
    credentialState: node.credential_state,
    idleExpiresAt: node.idle_expires_at === undefined ? undefined : timestamp(node.idle_expires_at),
    lastSeenAt: timestamp(node.last_contact_at ?? node.registered_at),
    registeredAt: timestamp(node.registered_at),
    agents: (report?.agents ?? [])
      .filter((agent) => ['codex', 'kiro', 'pi', 'cursor', 'antigravity'].includes(agent.agent_type))
      .map((agent) => ({
        kind: agent.agent_type as AgentKind,
        status: agent.status,
        reason: agent.reason ?? null,
        version: agent.version === 'unknown' ? null : agent.version,
        models: (agent.models ?? []).map((model) => model.id),
        modelThinking: Object.fromEntries(
          (agent.models ?? []).flatMap((model) => (model.thinking ? [[model.id, model.thinking]] : [])),
        ),
        defaultModel: agent.default_model || null,
        runtimeModes: agent.runtime_modes,
        defaultRuntimeMode: agent.default_runtime_mode,
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
    subscriptions: (report?.project_runtime?.providers ?? [])
      .filter((item) => !item.connection)
      .map((item) => ({
        provider: subscriptionName(item.provider),
        providerId: item.provider,
        loginMethods: item.login_methods ?? [],
        signedIn: item.status === 'available',
        status: item.status === 'available' || item.status === 'login_required' ? item.status : 'unknown',
        reason: item.reason ?? null,
        models: item.models?.map((model) => model.id) ?? [],
      })),
    modelConnections: (report?.project_runtime?.providers ?? []).flatMap((item) =>
      item.connection
        ? [
            {
              ...item.connection,
              models: item.models?.map((model) => model.id) ?? [],
              keyNeeded: item.status === 'login_required',
              modelsTruncated: item.models_truncated,
            },
          ]
        : [],
    ),
    hasRuntime: !!report?.project_runtime,
    folders: (report?.roots ?? []).map((root) => root.path),
    repos: (report?.repos ?? []).map((repo) => repo.path),
    commandAccess: {
      enabled: !!report?.exec?.enabled,
      shell: report?.exec?.shell ?? '未报告',
      user: report?.exec?.user ?? '设备用户',
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
  let refreshTimer: ReturnType<typeof setInterval> | null = null
  let socket: WebSocket | null = null
  let socketReady = false
  let nodeRead: Promise<NodesDTO> | null = null
  let allThreadRevision = 0
  let sessionRevision = 0
  const threadRevisions = new Map<string, number>()
  const publish = (event: ChangeEvent) => {
    if (event.target?.type === 'thread') {
      threadRevisions.set(event.target.id, (threadRevisions.get(event.target.id) ?? 0) + 1)
    } else if (event.topics.includes('threads') || event.topics.includes('messages')) {
      allThreadRevision += 1
    }
    for (const listener of listeners) listener(event)
  }
  const emit = (...topics: Topic[]) => publish({ topics })
  const transport = createTransport({
    ...options,
    onUnauthorized: () => {
      if (signedIn) {
        signedIn = false
        sessionRevision += 1
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
  const ctx: HttpContext = {
    request,
    emit,
    threadChanged: (id) => publish({ topics: ['threads', 'messages', 'operations'], target: { type: 'thread', id } }),
    threadRevision: (id) => `${allThreadRevision}:${threadRevisions.get(id) ?? 0}`,
    sessionRevision: () => sessionRevision,
    devices: listDevices,
    operation,
  }
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
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = null
    globalThis.document?.removeEventListener('visibilitychange', refreshVisible)
    const previous = socket
    socket = null
    socketReady = false
    output.setConnection(null)
    previous?.close()
  }
  function start() {
    if (!signedIn || listeners.size === 0 || timer) return
    timer = setInterval(() => {
      if (!socket) connectSocket()
      if (socketReady) emit('operations')
      else refreshAll()
    }, options.pollInterval ?? 2000)
    refreshTimer = setInterval(refreshAll, 30000)
    globalThis.document?.addEventListener('visibilitychange', refreshVisible)
    connectSocket()
  }
  function refreshAll() {
    nodeRead = null
    emit('devices', 'projects', 'threads', 'messages', 'operations')
  }
  function refreshVisible() {
    if (globalThis.document?.visibilityState === 'visible') refreshAll()
  }
  function connectSocket() {
    const Socket = options.WebSocket === undefined ? globalThis.WebSocket : options.WebSocket
    if (!Socket || !signedIn || listeners.size === 0) return
    const url = new URL(`${options.baseUrl ?? '/api/v1'}/events`, origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const next = new Socket(url.href)
    transport.traceSocket(next)
    socket = next
    next.onmessage = (event) => {
      if (socket !== next) return
      let message: OutputResult & {
        type?: string
        thread_id?: string
        project_id?: string
        execution_id?: string
        change?: string
        node_id?: string
        report_version?: number
      }
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message.type === 'ready') refreshAll()
      if (message.type === 'ready' || message.type === 'notification') {
        publish({ topics: [], browserEvent: message as BrowserEvent })
      }
      if (message.type === 'ready') {
        socketReady = true
        output.setConnection((subscription) => {
          if (socket === next && next.readyState === 1) next.send(JSON.stringify(subscription))
        })
      }
      if (message.type === 'nodes.changed') {
        nodeRead = null
        emit('devices', 'projects', 'threads', 'messages', 'operations', 'files')
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
      if (message.type === 'execution.changed') {
        const id = message.execution_id
        if (typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
          publish({ topics: ['executions'], target: { type: 'execution', id } })
        else emit('executions')
      }
      if (message.type === 'thread.changed' || message.type === 'project.changed') {
        const type = message.type === 'thread.changed' ? 'thread' : 'project'
        const id = type === 'thread' ? message.thread_id : message.project_id
        const topics: Topic[] = type === 'thread' ? ['threads', 'messages', 'operations'] : ['projects', 'operations']
        if (
          message.change === 'detail' &&
          typeof id === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
        ) {
          publish({ topics, target: { type, id } })
        } else {
          emit(...topics)
        }
      }
      if (message.type === 'thread.output' && message.thread_id) output.receive(message.thread_id, message)
    }
    next.onclose = () => {
      if (socket === next) {
        socket = null
        socketReady = false
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
    getDownloads: () => request<DownloadsResponse>('/downloads'),
    getActivity: () => request<ActivitySnapshot>('/activity'),
    replayNotifications: (after) =>
      request<NotificationReplay>(
        `/events/replay?limit=100${after === undefined ? '' : `&after=${encodeURIComponent(after)}`}`,
      ),
    ...createThreadAPI(ctx, output),
    ...createExecutionAPI(ctx),
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
      sessionRevision += 1
      ended = null
      stop()
      transport.clear()
      output.clear()
      operations.clear()
      allThreadRevision += 1
      threadRevisions.clear()
      emit('session')
    },
    async changePassword(currentPassword, newPassword) {
      await request('/me/password', {
        method: 'POST',
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
      })
      transport.clear()
      signedIn = false
      sessionRevision += 1
      stop()
      output.clear()
      return { account: null, defaultDeviceId: null, ended: null }
    },
    listDevices,
    async listDeviceFolders(deviceId) {
      const folders: string[] = []
      const cursors = new Set<string>()
      let cursor: string | undefined
      do {
        const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
        const page = await request<{ roots: { root_id: string; path: string }[]; next_cursor?: string }>(
          `/nodes/${apiPath(deviceId)}/roots${query}`,
        )
        folders.push(...page.roots.map((root) => root.path))
        cursor = page.next_cursor
        if (cursor && (cursors.has(cursor) || !page.roots.length))
          throw new ClientError('unavailable', '无法加载文件夹，请重试。')
        if (cursor) cursors.add(cursor)
      } while (cursor)
      return folders
    },
    async getOperation(id) {
      const found = operations.get(id)
      if (!found) throw new ClientError('notFound', '此操作已不可用，请重新加载对话查看状态。')
      if (found.refresh && !['done', 'failed', 'conflict', 'stopped'].includes(found.operation.phase))
        Object.assign(found.operation, await found.refresh(), { updatedAt: Date.now() })
      return { ...found.operation }
    },
    async setDefaultDevice(deviceId) {
      await request('/me/default-device', { method: 'PUT', body: JSON.stringify({ node_id: deviceId }) })
      emit('session', 'devices')
      return getSession()
    },
    async updateDevice(deviceId) {
      await request(`/nodes/${apiPath(deviceId)}/update`, { method: 'POST', body: '{}' })
      emit('devices')
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
    async configureModelConnection({ deviceId, action, connection }) {
      const { keyNeeded: _keyNeeded, modelsTruncated: _modelsTruncated, ...metadata } = connection
      const result = await request<{ connection?: Omit<typeof connection, 'keyNeeded' | 'modelsTruncated'> }>(
        `/nodes/${apiPath(deviceId)}/model-connections`,
        {
          method: 'POST',
          body: JSON.stringify({ action, connection: metadata }),
        },
      )
      if (action !== 'get') emit('devices')
      return result.connection ? { ...result.connection, keyNeeded: connection.keyNeeded } : undefined
    },
    async logoutSubscription({ deviceId, provider }) {
      await request(`/nodes/${apiPath(deviceId)}/subscriptions/logout`, {
        method: 'POST',
        body: JSON.stringify({ provider }),
      })
      emit('devices')
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
      if (result.status !== 'effective') throw new ClientError('unavailable', '正在确认断开设备，请重试。')
    },
    async createEnrollment(nodeId) {
      const path = nodeId === undefined ? '/node-enrollments' : `/nodes/${apiPath(nodeId)}/reauth-enrollments`
      const value = await request<EnrollmentDTO>(path, { method: 'POST', body: '{}' })
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
