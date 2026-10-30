import { randomUUID } from 'node:crypto'
import type { IncomingMessage, Server } from 'node:http'
import { Effect, Predicate, Schema, Tracer } from 'effect'
import { captureTrace, withTraceSpan } from '@baton/telemetry'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { AuthFrame, BrowserSubscription, Envelope, NodeToControlBody, TelemetryExport } from '@baton/protocol'
import type {
  BrowserEvent,
  SessionResult,
  AuthFrame as NodeAuth,
  ReleaseMetadata,
  NodeVersionIncompatibility,
} from '@baton/protocol'
import { AppError, type NodeSource } from './errors.ts'

export const webSocketText = (data: RawData): string =>
  (Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)).toString('utf8')

type PSubscription = typeof BrowserSubscription.Type
type Body = Record<string, unknown>
const rpcResponses = new Map([
  ['files.browse', 'files.browse_result'],
  ['session.request', 'session.result'],
  ['execution.output_request', 'execution.output_result'],
  ['node.project_exec_set', 'node.project_exec_result'],
  ['node.browse_roots_set', 'node.browse_roots_result'],
  ['node.browse_roots_get', 'node.browse_roots_get_result'],
  ['node.subscription_login', 'node.subscription_login_result'],
  ['node.model_connection', 'node.model_connection_result'],
  ['node.subscription_logout', 'node.subscription_logout_result'],
])
const defaultRPCTimeouts: Readonly<Record<string, number>> = {
  'files.browse': 12_000,
  'session.request': 12_000,
  'execution.output_request': 12_000,
  'node.project_exec_set': 5000,
  'node.browse_roots_set': 5000,
  'node.subscription_login': 12_000,
  'node.model_connection': 12_000,
  'node.subscription_logout': 12_000,
}
export const checkNodeVersion = (
  daemon: Pick<NodeAuth, 'daemon_version' | 'protocol_version'>,
  center: Pick<ReleaseMetadata, 'version' | 'protocol_version' | 'supported_daemon_versions'>,
): void => {
  const reason =
    daemon.protocol_version !== center.protocol_version
      ? 'protocol_version_unsupported'
      : daemon.daemon_version !== 'development' &&
          center.version !== 'development' &&
          !center.supported_daemon_versions.includes(daemon.daemon_version)
        ? 'daemon_version_unsupported'
        : undefined
  if (!reason) return
  const detail: NodeVersionIncompatibility = {
    center_version: center.version,
    daemon_version: daemon.daemon_version,
    center_protocol_version: center.protocol_version,
    daemon_protocol_version: daemon.protocol_version,
    supported_daemon_versions: center.supported_daemon_versions,
    reason,
    guidance: '先升级中心，再将节点升级到中心支持的版本后重新运行 batond。',
  }
  throw new AppError(
    409,
    'node_version_incompatible',
    `中心 ${center.version}（协议 ${center.protocol_version}）与节点 ${daemon.daemon_version}（协议 ${daemon.protocol_version}）不兼容：${reason}。${detail.guidance}`,
    { version_incompatibility: detail },
  )
}

export interface GatewayHandlers {
  authenticate(
    token: string,
    incarnation: string,
    connectionId: string,
    version: Pick<NodeAuth, 'daemon_version' | 'protocol_version'>,
  ): Promise<NodeSource>
  validate(source: NodeSource): Promise<void>
  heartbeat(source: NodeSource): Promise<void>
  disconnected(source: NodeSource): Promise<void>
  handle(source: NodeSource, envelope: Envelope): Promise<Body | undefined>
  telemetry?(source: NodeSource, body: typeof TelemetryExport.Type): void
  browser(cookie: string): Promise<string>
  thread(employeeId: string, threadId: string): Promise<void>
  output(employeeId: string, threadId: string, cursor?: string): Promise<SessionResult>
}
interface NodeConnection {
  socket: WebSocket
  source: NodeSource
  synced: boolean
  pendingWrites: number
  pendingReads: number
  pendingBytes: number
  receivedBytes: number
  sentBytes: number
  lastContact: number
  rpcQueue: QueuedRPC[]
}
interface BrowserConnection {
  socket: WebSocket
  cookie: string
  employeeId: string
  threadId: string
  cursor?: string
  generation: number
  subscriptionPending: boolean
  reading: boolean
  checkingSession: boolean
  notifying: boolean
  notifications: Map<string, BrowserEvent>
}
type RPCClass = 'read' | 'management'
interface QueuedRPC {
  body: Body
  operationId: string
  responseType: string
  rpcClass: RPCClass
  timeoutMs: number
  resolve(body: Body): void
  reject(error: Error): void
  timer?: ReturnType<typeof setTimeout>
  onResponse?: (source: NodeSource) => void
}
interface PendingRPC {
  rpcClass: RPCClass
  source: NodeSource
  operationId: string
  responseType: string
  sessionId?: string
  executionId?: string
  resolve(body: Body): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}
export interface GatewayOptions {
  tracer?: Tracer.Tracer
  allowedOrigins: ReadonlyArray<string>
  heartbeatMs?: number
  offlineMs?: number
  pollMs?: number
  maxConnections?: number
  authenticationTimeoutMs?: number
  rpc?: {
    readonly readConcurrency?: number
    readonly managementConcurrency?: number
    readonly maxQueued?: number
    readonly queueMs?: number
    readonly timeouts?: Readonly<Record<string, number>>
  }
}

/** Connections own bounded queues; durable control work remains in the database on backpressure. */
export class Gateway {
  private readonly nodes = new Map<string, NodeConnection>()
  private readonly browsers = new Set<BrowserConnection>()
  private readonly rpc = new Map<string, PendingRPC>()
  private readonly sockets = new Set<WebSocket>()
  private readonly retiring = new Map<string, { source: NodeSource; due: number; attempts: number }>()
  private retiringActive = false
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false })
  private readonly maintenance: ReturnType<typeof setInterval>
  private handshakes = 0
  private closed = false
  private closing: Promise<void> | undefined
  private lastHeartbeat = Date.now()
  private readonly upgrade: (request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => void

  constructor(
    private readonly server: Server,
    private readonly handlers: GatewayHandlers,
    private readonly options: GatewayOptions,
  ) {
    this.upgrade = (request, socket, head) => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname
      if (
        this.closed ||
        this.sockets.size + this.retiring.size >= (options.maxConnections ?? 128) ||
        this.handshakes >= 32 ||
        (path !== '/v1/node' && path !== '/api/v1/events')
      ) {
        socket.destroy()
        return
      }
      if (path === '/api/v1/events' && !options.allowedOrigins.includes(request.headers.origin ?? '')) {
        socket.destroy()
        return
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.sockets.add(ws)
        ws.on('error', () => undefined)
        ws.once('close', () => this.sockets.delete(ws))
        if (path === '/v1/node') this.acceptNode(ws)
        else void this.acceptBrowser(ws, request.headers.cookie ?? '')
      })
    }
    server.on('upgrade', this.upgrade)
    this.maintenance = setInterval(
      () => {
        const now = Date.now()
        const heartbeatDue = now - this.lastHeartbeat >= (options.heartbeatMs ?? 10_000)
        if (heartbeatDue) this.lastHeartbeat = now
        for (const connection of this.nodes.values()) {
          if (now - connection.lastContact > (options.offlineMs ?? 30_000)) connection.socket.terminate()
          else if (heartbeatDue) this.sendFrame(connection, { kind: 'heartbeat' })
        }
        void this.retryDisconnects()
        for (const browser of this.browsers) {
          if (heartbeatDue) void this.checkBrowser(browser)
          void this.poll(browser)
        }
      },
      Math.max(
        10,
        Math.min(options.pollMs ?? 250, options.heartbeatMs ?? 10_000, Math.floor((options.offlineMs ?? 30_000) / 2)),
      ),
    )
    this.maintenance.unref()
  }

  private sendFrame(connection: NodeConnection, frame: unknown): boolean {
    const text = JSON.stringify(frame)
    const bytes = Buffer.byteLength(text)
    if (
      connection.socket.readyState !== WebSocket.OPEN ||
      connection.pendingWrites >= 32 ||
      connection.pendingBytes + bytes > 1024 * 1024 ||
      connection.socket.bufferedAmount + bytes > 1024 * 1024
    )
      return false
    connection.pendingWrites++
    connection.pendingBytes += bytes
    connection.sentBytes += bytes
    connection.socket.send(text, (error) => {
      connection.pendingWrites--
      connection.pendingBytes -= bytes
      if (error) connection.socket.terminate()
    })
    return true
  }

  send(nodeId: string, employeeId: string, messageId: string, body: unknown, correlationId?: string): boolean {
    const connection = this.nodes.get(nodeId)
    if (!connection || connection.source.employee_id !== employeeId || !connection.synced) return false
    const tracer = this.options.tracer
    if (!tracer || !Predicate.isObject(body) || body.type !== 'thread.command')
      return this.reply(connection, messageId, body, correlationId)
    return Effect.runSync(
      withTraceSpan(
        Effect.gen({ self: this }, function* () {
          const trace = yield* captureTrace
          const sent = this.reply(
            connection,
            messageId,
            { ...body, ...(trace ? { trace_context: trace } : {}) },
            correlationId,
          )
          yield* Effect.annotateCurrentSpan('baton.dispatch.accepted', sent)
          return sent
        }),
        'baton.gateway.send',
        body.trace_context,
        {
          kind: 'producer',
          attributes: { 'baton.command.id': messageId },
        },
      ).pipe(Effect.provideService(Tracer.Tracer, tracer)),
    )
  }

  async sendValidated(nodeId: string, employeeId: string, messageId: string, body: unknown): Promise<boolean> {
    const connection = this.nodes.get(nodeId)
    if (!connection || connection.source.employee_id !== employeeId || !connection.synced) return false
    try {
      await this.handlers.validate(connection.source)
    } catch (error) {
      if (error instanceof AppError && error.status === 401) return false
      throw error
    }
    if (this.nodes.get(nodeId) !== connection) return false
    return this.send(nodeId, employeeId, messageId, body)
  }

  async closeExpiredConnections(): Promise<void> {
    await Promise.all(
      [...this.nodes.values()].map(async (connection) => {
        try {
          await this.handlers.validate(connection.source)
        } catch (error) {
          if (
            error instanceof AppError &&
            error.code === 'node_idle_expired' &&
            this.nodes.get(connection.source.node_id) === connection
          ) {
            this.rejectQueuedRPC(connection, error)
            connection.socket.close(1008, 'node_idle_expired')
          }
        }
      }),
    )
  }

  private reply(connection: NodeConnection, messageId: string, body: unknown, correlationId?: string): boolean {
    return this.sendFrame(connection, {
      kind: 'envelope',
      envelope: {
        version: 1,
        message_id: messageId,
        route: { to: connection.source.node_id },
        priority: 'control',
        ...(correlationId ? { correlation_id: correlationId } : {}),
        body,
        source: { kind: 'control' },
      },
    })
  }

  private acceptNode(socket: WebSocket): void {
    this.handshakes++
    let authenticated = false
    let authenticating = false
    let connection: NodeConnection | undefined
    let queued = 0
    let chain = Promise.resolve()
    let rateStart = Date.now()
    let rate = 0
    const deadline = setTimeout(() => socket.terminate(), this.options.authenticationTimeoutMs ?? 15_000)
    const finishHandshake = () => {
      if (authenticated) return
      authenticated = true
      this.handshakes--
      clearTimeout(deadline)
    }
    socket.once('close', () => {
      finishHandshake()
      if (connection) {
        if (this.nodes.get(connection.source.node_id) === connection) this.nodes.delete(connection.source.node_id)
        this.rejectQueuedRPC(connection, new AppError(503, 'node_offline'))
        for (const [id, pending] of this.rpc) {
          if (pending.source.conn_id === connection.source.conn_id) {
            clearTimeout(pending.timer)
            this.rpc.delete(id)
            pending.reject(new AppError(503, 'node_offline'))
          }
        }
        this.retireConnection(connection.source)
        this.notify(connection.source.employee_id, { type: 'nodes.changed', node_id: connection.source.node_id })
      }
    })
    socket.on('message', (data, binary) => {
      if (binary) return socket.close(1008, 'invalid_frame')
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(webSocketText(data)) as Record<string, unknown>
      } catch {
        return socket.close(1008, 'invalid_frame')
      }
      if (!connection) {
        if (authenticating) return socket.close(1008, 'authentication_pending')
        authenticating = true
        void (async () => {
          try {
            const auth = Schema.decodeUnknownSync(AuthFrame)(frame)
            const source = await this.handlers.authenticate(auth.token, auth.incarnation, randomUUID(), auth)
            const current: NodeConnection = {
              socket,
              source,
              synced: false,
              pendingWrites: 0,
              pendingReads: 0,
              pendingBytes: 0,
              receivedBytes: 0,
              sentBytes: 0,
              lastContact: Date.now(),
              rpcQueue: [],
            }
            connection = current
            finishHandshake()
            if (socket.readyState !== WebSocket.OPEN) {
              this.retireConnection(source)
              return
            }
            const previous = this.nodes.get(source.node_id)
            this.nodes.set(source.node_id, current)
            previous?.socket.close(1000, 'connection_replaced')
            this.sendFrame(current, { kind: 'auth_result', ok: true })
          } catch (error) {
            finishHandshake()
            socket.send(
              JSON.stringify({
                kind: 'auth_result',
                ok: false,
                code: error instanceof AppError ? error.code : 'authentication_failed',
                ...(error instanceof AppError && error.code === 'node_version_incompatible'
                  ? { message: error.message, version_incompatibility: error.details?.version_incompatibility }
                  : {}),
              }),
              () => socket.close(1008),
            )
          }
        })()
        return
      }
      if (
        frame.kind === 'envelope' &&
        Predicate.isObject(frame.envelope) &&
        Predicate.isObject(frame.envelope.body) &&
        frame.envelope.body.type === 'telemetry.export'
      ) {
        const current = connection
        if (!current.synced || queued || this.nodes.get(current.source.node_id) !== current) return
        const envelope = Schema.decodeUnknownOption(Envelope)(frame.envelope)
        if (envelope._tag === 'None' || envelope.value.route.to !== 'control') return
        const body = Schema.decodeUnknownOption(TelemetryExport)(envelope.value.body)
        if (body._tag === 'Some') {
          try {
            this.handlers.telemetry?.(current.source, body.value)
          } catch {
            /* 丢弃格式错误的遥测。 */
          }
        }
        return
      }
      if (Date.now() - rateStart >= 1000) {
        rateStart = Date.now()
        rate = 0
      }
      if (++rate > 64 || queued >= 32) return socket.close(1013, 'control_limit')
      let message: { envelope: Envelope; body: typeof NodeToControlBody.Type } | undefined
      try {
        if (frame.kind !== 'heartbeat') {
          if (frame.kind !== 'envelope') throw new AppError(400, 'invalid_frame')
          const envelope = Schema.decodeUnknownSync(Envelope)(frame.envelope)
          if (envelope.route.to !== 'control') throw new AppError(403, 'route_forbidden')
          const body = Schema.decodeUnknownSync(NodeToControlBody)(envelope.body)
          if (
            ![
              'node.sync',
              'node.runtime_report',
              'node.upgrade_state',
              'thread.command_result',
              'thread.report',
              'execution.command_result',
              'execution.report',
              'execution.output_result',
              'session.result',
              'files.browse_result',
              'node.project_exec_result',
              'node.browse_roots_result',
              'node.browse_roots_get_result',
              'node.subscription_login_result',
              'node.model_connection_result',
              'node.subscription_logout_result',
              'project_runtime.request',
            ].includes(body.type)
          )
            throw new AppError(400, 'unsupported_message')
          message = { envelope, body }
        }
      } catch (error) {
        if (error instanceof AppError && error.status >= 400 && error.status < 500) socket.close(1008, error.code)
        else socket.close(1011, 'control_unavailable')
        return
      }
      queued++
      const current = connection
      current.lastContact = Date.now()
      current.receivedBytes += Buffer.byteLength(webSocketText(data))
      current.pendingReads = queued
      chain = chain
        .then(async () => {
          if (socket.readyState !== WebSocket.OPEN || this.nodes.get(current.source.node_id) !== current) return
          if (!message) {
            await this.handlers.heartbeat(current.source)
            return
          }
          const { envelope, body } = message
          // Source is always obtained from the authenticated connection.
          const authenticatedEnvelope = { ...envelope, source: { kind: 'node' as const, ...current.source } }
          if (
            body.type === 'session.result' ||
            body.type === 'execution.output_result' ||
            body.type === 'files.browse_result' ||
            body.type === 'node.project_exec_result' ||
            body.type === 'node.browse_roots_result' ||
            body.type === 'node.browse_roots_get_result' ||
            body.type === 'node.subscription_login_result' ||
            body.type === 'node.model_connection_result' ||
            body.type === 'node.subscription_logout_result'
          ) {
            await this.handlers.validate(current.source)
            const pending = this.rpc.get(envelope.correlation_id ?? '')
            if (
              !pending ||
              pending.source.conn_id !== current.source.conn_id ||
              pending.source.credential_id !== current.source.credential_id ||
              pending.source.incarnation !== current.source.incarnation ||
              pending.source.node_id !== current.source.node_id ||
              pending.source.employee_id !== current.source.employee_id ||
              pending.operationId !== body.operation_id ||
              pending.responseType !== body.type ||
              (body.type === 'session.result' && pending.sessionId !== body.session_id) ||
              (body.type === 'execution.output_result' && pending.executionId !== body.execution_id)
            )
              return
            const correlationId = envelope.correlation_id
            if (correlationId === undefined) return
            clearTimeout(pending.timer)
            this.rpc.delete(correlationId)
            pending.resolve(body)
          } else {
            let result: Body | undefined
            try {
              result = await this.handlers.handle(current.source, authenticatedEnvelope)
            } catch (error) {
              if (
                error instanceof AppError &&
                error.status === 503 &&
                [
                  'node.sync',
                  'node.runtime_report',
                  'node.upgrade_state',
                  'thread.command_result',
                  'thread.report',
                  'execution.command_result',
                  'execution.report',
                ].includes(body.type)
              ) {
                // The node retries durable work with its original identity until it receives an acknowledgement.
                return
              }
              throw error
            }
            if (body.type === 'node.sync' && result?.ok === true) current.synced = true
            if (result && !this.reply(current, randomUUID(), result, envelope.message_id)) socket.terminate()
          }
        })
        .catch((error: unknown) => {
          if (error instanceof AppError && error.status >= 400 && error.status < 500) socket.close(1008, error.code)
          else socket.close(1011, 'control_unavailable')
        })
        .finally(() => {
          queued--
          current.pendingReads = queued
        })
    })
  }

  request(
    nodeId: string,
    employeeId: string,
    body: Body,
    timeoutMs?: number,
    onResponse?: (source: NodeSource) => void,
  ): Promise<Body> {
    const connection = this.nodes.get(nodeId)
    if (
      this.closed ||
      !connection ||
      connection.source.employee_id !== employeeId ||
      connection.socket.readyState !== WebSocket.OPEN
    )
      return Promise.reject(new AppError(503, 'node_offline'))
    if (!connection.synced) return Promise.reject(new AppError(503, 'node_syncing'))
    const responseType = typeof body.type === 'string' ? rpcResponses.get(body.type) : undefined
    if (!responseType || typeof body.operation_id !== 'string')
      return Promise.reject(new AppError(400, 'invalid_request'))
    const operationId = body.operation_id
    const rpcClass: RPCClass =
      body.type === 'files.browse' || body.type === 'session.request' || body.type === 'execution.output_request'
        ? 'read'
        : 'management'
    return new Promise((resolve, reject) => {
      const pending: QueuedRPC = {
        body: { ...body },
        operationId,
        responseType,
        rpcClass,
        ...(onResponse ? { onResponse } : {}),
        resolve,
        reject,
        timeoutMs:
          this.options.rpc?.timeouts?.[String(body.type)] ??
          timeoutMs ??
          defaultRPCTimeouts[String(body.type)] ??
          12_000,
      }
      if (this.rpcAvailable(connection, rpcClass)) {
        this.startRPC(connection, pending)
        return
      }
      if (
        connection.rpcQueue.filter((entry) => entry.rpcClass === rpcClass).length >= (this.options.rpc?.maxQueued ?? 8)
      ) {
        reject(new AppError(503, 'node_busy'))
        return
      }
      pending.timer = setTimeout(() => {
        const index = connection.rpcQueue.indexOf(pending)
        if (index < 0) return
        connection.rpcQueue.splice(index, 1)
        reject(new AppError(503, 'node_busy'))
      }, this.options.rpc?.queueMs ?? 2000)
      connection.rpcQueue.push(pending)
    })
  }

  private rpcAvailable(connection: NodeConnection, rpcClass: RPCClass): boolean {
    const active = [...this.rpc.values()].filter(
      (pending) => pending.source.conn_id === connection.source.conn_id && pending.rpcClass === rpcClass,
    ).length
    return (
      active <
      (rpcClass === 'read' ? (this.options.rpc?.readConcurrency ?? 4) : (this.options.rpc?.managementConcurrency ?? 2))
    )
  }

  private startRPC(connection: NodeConnection, queued: QueuedRPC): void {
    clearTimeout(queued.timer)
    const messageId = randomUUID()
    const finish = () => {
      clearTimeout(timer)
      this.rpc.delete(messageId)
      this.drainRPC(connection)
    }
    const timer = setTimeout(() => {
      finish()
      queued.reject(new AppError(503, 'node_timeout'))
    }, queued.timeoutMs)
    this.rpc.set(messageId, {
      rpcClass: queued.rpcClass,
      source: connection.source,
      operationId: queued.operationId,
      responseType: queued.responseType,
      ...(typeof queued.body.session_id === 'string' ? { sessionId: queued.body.session_id } : {}),
      ...(typeof queued.body.execution_id === 'string' ? { executionId: queued.body.execution_id } : {}),
      resolve: (body) => {
        finish()
        queued.onResponse?.(connection.source)
        queued.resolve(body)
      },
      reject: (error) => {
        finish()
        queued.reject(error)
      },
      timer,
    })
    // Reserve the slot before validation so concurrent requests cannot exceed the limit.
    void (async () => {
      try {
        await this.handlers.validate(connection.source)
        if (!this.rpc.has(messageId)) return
        if (this.nodes.get(connection.source.node_id) !== connection || connection.socket.readyState !== WebSocket.OPEN)
          throw new AppError(503, 'node_offline')
        if (!this.send(connection.source.node_id, connection.source.employee_id, messageId, queued.body))
          throw new AppError(503, 'node_busy')
      } catch (error) {
        if (!this.rpc.has(messageId)) return
        finish()
        queued.reject(error instanceof AppError ? error : new AppError(503, 'node_unavailable'))
      }
    })()
  }

  private drainRPC(connection: NodeConnection): void {
    if (
      this.closed ||
      this.nodes.get(connection.source.node_id) !== connection ||
      connection.socket.readyState !== WebSocket.OPEN
    )
      return
    while (true) {
      const index = connection.rpcQueue.findIndex((queued) => this.rpcAvailable(connection, queued.rpcClass))
      if (index < 0) return
      const [queued] = connection.rpcQueue.splice(index, 1)
      if (queued) this.startRPC(connection, queued)
    }
  }

  private rejectQueuedRPC(connection: NodeConnection, error: AppError): void {
    for (const queued of connection.rpcQueue.splice(0)) {
      clearTimeout(queued.timer)
      queued.reject(error)
    }
  }

  private retireConnection(source: NodeSource): void {
    if (!this.retiring.has(source.conn_id)) this.retiring.set(source.conn_id, { source, due: Date.now(), attempts: 0 })
    void this.retryDisconnects()
  }

  private async retryDisconnects(): Promise<void> {
    if (this.retiringActive || this.closed) return
    const pending = [...this.retiring.values()].find((entry) => entry.due <= Date.now())
    if (!pending) return
    this.retiringActive = true
    pending.attempts++
    pending.due = Date.now() + Math.min(30_000, 1000 * 2 ** Math.min(5, pending.attempts - 1))
    try {
      await this.handlers.disconnected(pending.source)
      if (this.retiring.get(pending.source.conn_id) === pending) this.retiring.delete(pending.source.conn_id)
      this.notify(pending.source.employee_id, { type: 'nodes.changed', node_id: pending.source.node_id })
    } catch {
      // Retry the same connection identity; a newer connection is protected by its own ID.
    } finally {
      this.retiringActive = false
    }
  }

  async disconnect(nodeId: string): Promise<void> {
    const connection = this.nodes.get(nodeId)
    if (!connection) {
      for (const pending of this.retiring.values()) {
        if (pending.source.node_id !== nodeId) continue
        await this.handlers.disconnected(pending.source)
        if (this.retiring.get(pending.source.conn_id) === pending) this.retiring.delete(pending.source.conn_id)
      }
      return
    }
    this.nodes.delete(nodeId)
    connection.socket.terminate()
    this.retireConnection(connection.source)
    await this.handlers.disconnected(connection.source)
    this.retiring.delete(connection.source.conn_id)
  }

  disconnectBrowsers(employeeId: string, token?: string): void {
    for (const browser of this.browsers) {
      const matchesToken =
        token === undefined || browser.cookie.split(';').some((part) => part.trim() === `baton_session=${token}`)
      if (browser.employeeId === employeeId && matchesToken) browser.socket.close(1008, 'session_ended')
    }
  }

  private async checkBrowser(browser: BrowserConnection): Promise<boolean> {
    if (browser.checkingSession) return true
    browser.checkingSession = true
    try {
      if ((await this.handlers.browser(browser.cookie)) !== browser.employeeId) throw new AppError(401, 'unauthorized')
      return true
    } catch {
      browser.socket.close(1008, 'session_ended')
      return false
    } finally {
      browser.checkingSession = false
    }
  }

  notify(employeeId: string, event: BrowserEvent): void {
    const key = JSON.stringify([
      event.type,
      event.type === 'notification'
        ? event.event_id
        : 'thread_id' in event
          ? event.thread_id
          : 'execution_id' in event
            ? event.execution_id
            : 'project_id' in event
              ? event.project_id
              : 'node_id' in event
                ? event.node_id
                : '',
    ])
    for (const browser of this.browsers) {
      if (browser.employeeId !== employeeId || browser.socket.readyState !== WebSocket.OPEN) continue
      if (browser.notifications.size >= 32 && !browser.notifications.has(key)) {
        browser.socket.close(1013, 'slow_reader')
        continue
      }
      browser.notifications.set(key, event)
      void this.flushNotifications(browser)
    }
  }

  private async flushNotifications(browser: BrowserConnection): Promise<void> {
    if (browser.notifying) return
    browser.notifying = true
    try {
      while (browser.notifications.size && browser.socket.readyState === WebSocket.OPEN) {
        if ((await this.handlers.browser(browser.cookie)) !== browser.employeeId)
          throw new AppError(401, 'unauthorized')
        const events = [...browser.notifications.values()]
        browser.notifications.clear()
        for (const event of events) {
          const text = JSON.stringify(event)
          if (browser.socket.bufferedAmount + Buffer.byteLength(text) > 256 * 1024) {
            browser.socket.close(1013, 'slow_reader')
            return
          }
          browser.socket.send(text)
        }
      }
    } catch {
      browser.socket.close(1008, 'session_ended')
    } finally {
      browser.notifying = false
    }
  }

  private async acceptBrowser(socket: WebSocket, cookie: string): Promise<void> {
    try {
      const employeeId = await this.handlers.browser(cookie)
      if (socket.readyState !== WebSocket.OPEN) return
      const browser: BrowserConnection = {
        socket,
        cookie,
        employeeId,
        threadId: '',
        generation: 0,
        subscriptionPending: false,
        reading: false,
        checkingSession: false,
        notifying: false,
        notifications: new Map(),
      }
      this.browsers.add(browser)
      socket.once('close', () => this.browsers.delete(browser))
      socket.send(JSON.stringify({ type: 'ready' }))
      let desired: { value: PSubscription; generation: number } | undefined
      let updating = false
      const update = async () => {
        if (updating) return
        updating = true
        try {
          while (desired && socket.readyState === WebSocket.OPEN) {
            const next = desired
            desired = undefined
            if (next.value.thread_id) await this.handlers.thread(employeeId, next.value.thread_id)
            if (next.generation !== browser.generation) continue
            browser.threadId = next.value.thread_id
            if (next.value.cursor !== undefined) browser.cursor = next.value.cursor
            else delete browser.cursor
            browser.subscriptionPending = false
            void this.poll(browser)
          }
        } catch {
          socket.close(1008, 'subscription_rejected')
        } finally {
          updating = false
        }
      }
      let received = 0,
        windowStart = Date.now()
      socket.on('message', (data, binary) => {
        if (Date.now() - windowStart >= 1000) {
          received = 0
          windowStart = Date.now()
        }
        if (binary || ++received > 16) return socket.close(1008, 'invalid_subscription')
        try {
          const value = Schema.decodeUnknownSync(BrowserSubscription)(JSON.parse(webSocketText(data)))
          browser.subscriptionPending = true
          desired = { value, generation: ++browser.generation }
          void update()
        } catch {
          socket.close(1008, 'invalid_subscription')
        }
      })
    } catch {
      socket.close(1008, 'unauthorized')
    }
  }

  private async poll(browser: BrowserConnection): Promise<void> {
    if (
      !browser.threadId ||
      browser.subscriptionPending ||
      browser.reading ||
      browser.socket.readyState !== WebSocket.OPEN
    )
      return
    browser.reading = true
    const generation = browser.generation
    const threadId = browser.threadId
    const cursor = browser.cursor
    try {
      // Recheck the session and ownership for every read, including long lived sockets.
      if ((await this.handlers.browser(browser.cookie)) !== browser.employeeId) {
        browser.socket.close(1008, 'unauthorized')
        return
      }
      const result = await this.handlers.output(browser.employeeId, threadId, cursor)
      if (
        generation !== browser.generation ||
        threadId !== browser.threadId ||
        browser.subscriptionPending ||
        browser.socket.readyState !== WebSocket.OPEN
      )
        return
      const event = { ...result, type: 'thread.output', thread_id: threadId }
      const text = JSON.stringify(event)
      if (browser.socket.bufferedAmount + Buffer.byteLength(text) > 256 * 1024) {
        browser.socket.close(1013, 'slow_reader')
        return
      }
      browser.socket.send(text)
      if (result.cursor !== undefined) browser.cursor = result.cursor
    } catch (error) {
      if (error instanceof AppError && error.status === 401) browser.socket.close(1008, 'unauthorized')
      else if (
        generation === browser.generation &&
        threadId === browser.threadId &&
        !browser.subscriptionPending &&
        browser.socket.readyState === WebSocket.OPEN
      )
        browser.socket.send(
          JSON.stringify({
            type: 'thread.output',
            thread_id: threadId,
            operation_id: randomUUID(),
            session_id: threadId,
            ok: false,
            code: 'output_unavailable',
            gap: true,
          }),
        )
    } finally {
      browser.reading = false
    }
  }

  diagnostics(employeeId?: string) {
    const nodes = [...this.nodes.values()].filter(
      (node) => employeeId === undefined || node.source.employee_id === employeeId,
    )
    const browsers = [...this.browsers].filter(
      (browser) => employeeId === undefined || browser.employeeId === employeeId,
    )
    const rpc = [...this.rpc.values()].filter(
      (pending) => employeeId === undefined || pending.source.employee_id === employeeId,
    )
    return {
      nodes: nodes.length,
      browsers: browsers.length,
      pending_rpc: rpc.length,
      connections: employeeId === undefined ? this.sockets.size : nodes.length + browsers.length,
      pending_disconnects: [...this.retiring.values()].filter(
        (pending) => employeeId === undefined || pending.source.employee_id === employeeId,
      ).length,
      received_bytes: nodes.reduce((sum, node) => sum + node.receivedBytes, 0),
      sent_bytes: nodes.reduce((sum, node) => sum + node.sentBytes, 0),
      queued_control_messages: nodes.reduce((sum, node) => sum + node.pendingWrites + node.pendingReads, 0),
      queued_control_bytes: nodes.reduce((sum, node) => sum + node.pendingBytes, 0),
    }
  }

  close(): Promise<void> {
    this.closing ??= this.closeConnections()
    return this.closing
  }

  private async closeConnections(): Promise<void> {
    this.closed = true
    clearInterval(this.maintenance)
    this.server.off('upgrade', this.upgrade)
    for (const connection of this.nodes.values()) this.rejectQueuedRPC(connection, new AppError(503, 'server_stopping'))
    for (const pending of this.rpc.values()) {
      clearTimeout(pending.timer)
      pending.reject(new AppError(503, 'server_stopping'))
    }
    this.rpc.clear()
    for (const socket of this.sockets) socket.terminate()
    await new Promise<void>((resolve) => this.wss.close(() => resolve()))
  }
}
