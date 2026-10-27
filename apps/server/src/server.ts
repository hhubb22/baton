import { createServer as createHTTPServer } from 'node:http'
import { createServer as createHTTPSServer, type ServerOptions as TLSOptions } from 'node:https'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { Cause, Effect, Exit, Semaphore, Schema, Tracer } from 'effect'
import type * as Scope from 'effect/Scope'
import * as SqlClient from 'effect/sql/SqlClient'
import { NodeHttpServer } from '@effect/platform-node'
import * as P from '@baton/protocol'
import * as Auth from './auth.ts'
import * as Nodes from './nodes.ts'
import * as Threads from './threads/index.ts'
import * as Projects from './project/projects.ts'
import { expireProjectNodeLeases } from './project/scheduling.ts'
import { AppError, type NodeSource } from './errors.ts'
import { Gateway, checkNodeVersion, type GatewayOptions } from './gateway.ts'
import {
  defaultControlBudgets,
  withControlBudget,
  type ControlBudgets,
  type ControlOperation,
} from './control-budget.ts'
import type { DownloadsOptions } from './downloads.ts'
import { createRevocationCompensator } from './control-maintenance.ts'
import { cookieToken, httpApplication } from './http/index.ts'

export interface ServerOptions {
  readonly host?: string
  readonly port?: number
  readonly allowedOrigins: ReadonlyArray<string>
  readonly signer: Nodes.CredentialSigner
  readonly sessionTTLSeconds?: number
  readonly enrollmentTTLSeconds?: number
  readonly tls?: TLSOptions
  readonly webDirectory?: string
  readonly downloads?: DownloadsOptions
  readonly dispatchMs?: number
  readonly projectDispatchMs?: number
  readonly heartbeatMs?: number
  readonly offlineMs?: number
  readonly controlBudgets?: Partial<ControlBudgets>
  readonly rpc?: GatewayOptions['rpc']
}
export interface RunningServer {
  readonly host: string
  readonly port: number
  readonly gateway: Gateway
}

/** HTTP, connection handlers and background dispatch share one scoped database service. */
export const startServer = (
  options: ServerOptions,
): Effect.Effect<RunningServer, unknown, SqlClient.SqlClient | Scope.Scope> =>
  Effect.gen(function* () {
    const services = yield* Effect.context<SqlClient.SqlClient>()
    const scope = yield* Effect.scope
    const tracer = yield* Tracer.Tracer
    const controller = new AbortController()
    const controlGate = yield* Semaphore.make(4)
    const httpGate = yield* Semaphore.make(16)
    const budgets = { ...defaultControlBudgets, ...options.controlBudgets }
    const run = async <A, E>(
      operation: ControlOperation,
      effect: Effect.Effect<A, E, SqlClient.SqlClient>,
    ): Promise<A> => {
      const result = await Effect.runPromiseExitWith(services)(
        withControlBudget(controlGate, budgets[operation], effect),
        { signal: controller.signal },
      )
      if (Exit.isSuccess(result)) return result.value
      const error = Cause.squash(result.cause)
      throw error instanceof AppError ? error : new AppError(503, 'unavailable')
    }
    const authorizeBrowser = async (cookie: string) => {
      const session = await run('browser', Auth.lookupSession(cookieToken(cookie)))
      if (session.employee.must_change_password) throw new AppError(403, 'password_change_required')
      return session.employee.id
    }
    const output = async (employeeId: string, threadId: string, cursor?: string): Promise<P.SessionResult> => {
      const thread = await run('read', Threads.view({ employeeId: employeeId }, threadId))
      const operationId = randomUUID()
      if (!thread.node_online || !thread.node_synced)
        return {
          type: 'session.result',
          operation_id: operationId,
          session_id: threadId,
          ok: false,
          code: thread.node_online ? 'node_syncing' : 'node_offline',
          gap: false,
        }
      return Schema.decodeUnknownSync(P.SessionResult)(
        await gateway.request(thread.node_id, employeeId, {
          type: 'session.request',
          operation_id: operationId,
          session_id: threadId,
          action: 'output',
          ...(cursor !== undefined ? { cursor } : {}),
        }),
      )
    }
    const httpOptions = { requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 16 * 1024 }
    const http = options.tls ? createHTTPSServer({ ...httpOptions, ...options.tls }) : createHTTPServer(httpOptions)
    const gateway = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new Gateway(
            http,
            {
              authenticate: async (token, incarnation, connId, version): Promise<NodeSource> => {
                const claims = await run('authenticate', Nodes.authenticateNode(token, options.signer))
                checkNodeVersion(version, P.releaseMetadata())
                const source = {
                  employee_id: claims.employee_id,
                  node_id: claims.node_id,
                  credential_id: claims.credential_id,
                  incarnation,
                  conn_id: connId,
                }
                await run('authenticate', Nodes.claimConnection(source))
                return source
              },
              validate: (source) => run('validate', Nodes.revalidateNodeSource(source, false)),
              heartbeat: (source) => run('heartbeat', Nodes.touchNode(source)),
              disconnected: (source) => run('disconnect', Nodes.disconnectNode(source)),
              handle: async (source, envelope) => {
                const body = Schema.decodeUnknownSync(P.NodeToControlBody)(envelope.body)
                switch (body.type) {
                  case 'node.sync':
                    await run(
                      'sync',
                      Nodes.syncNode(source, {
                        display_name: body.display_name,
                        system: body.system,
                        capabilities: body.capabilities ?? [],
                      }),
                    )
                    gateway.notify(source.employee_id, { type: 'thread.changed' })
                    return { type: 'node.sync_result', ok: true }
                  case 'node.upgrade_state': {
                    try {
                      return { ...(await run('runtime_report', Nodes.saveNodeUpgradeState(source, body))) }
                    } catch (error) {
                      if (!(error instanceof AppError) || error.code !== 'upgrade_conflict') throw error
                      return {
                        type: 'node.upgrade_state_result',
                        operation_id: body.operation_id,
                        phase: body.phase,
                        ok: false,
                        code: error.code,
                      }
                    }
                  }
                  case 'node.runtime_report': {
                    const version = await run('runtime_report', Nodes.saveRuntimeReport(source, body.report))
                    gateway.notify(source.employee_id, {
                      type: 'devices.changed',
                      node_id: source.node_id,
                      report_version: version,
                    })
                    return { type: 'node.runtime_report_result', ok: true, report_version: version }
                  }
                  case 'project_runtime.request': {
                    try {
                      const data = await run('project_request', Projects.runtimeRequest(source, body))
                      gateway.notify(source.employee_id, { type: 'thread.changed' })
                      return Schema.decodeUnknownSync(P.ProjectRuntimeResult)({
                        type: 'project_runtime.result',
                        ok: true,
                        ...(data === undefined ? {} : { data }),
                      })
                    } catch (error) {
                      return {
                        type: 'project_runtime.result',
                        ok: false,
                        code: error instanceof AppError ? error.code : 'unavailable',
                      }
                    }
                  }
                  case 'thread.command_result':
                    if (!envelope.correlation_id) throw new AppError(400, 'missing_correlation')
                    await run('receipt', Threads.processReceipt(source, envelope.correlation_id, body))
                    gateway.notify(source.employee_id, { type: 'thread.changed' })
                    return undefined
                  case 'thread.report': {
                    const ack = await run('report', Threads.processReport(source, body))
                    gateway.notify(source.employee_id, { type: 'thread.changed' })
                    return { ...ack }
                  }
                  default:
                    throw new AppError(400, 'unsupported_message')
                }
              },
              browser: authorizeBrowser,
              thread: async (employeeId, threadId) => {
                await run('read', Threads.view({ employeeId: employeeId }, threadId))
              },
              output,
            },
            {
              allowedOrigins: options.allowedOrigins,
              tracer,
              authenticationTimeoutMs: 2 * (budgets.authenticate.queueMs + budgets.authenticate.executionMs) + 1000,
              ...(options.rpc ? { rpc: options.rpc } : {}),
              ...(options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {}),
              ...(options.offlineMs !== undefined ? { offlineMs: options.offlineMs } : {}),
            },
          ),
      ),
      (owned) => Effect.promise(() => owned.close()),
    )
    const application = yield* httpApplication({ ...options, gateway: () => gateway })
    const handler = yield* NodeHttpServer.makeHandler(
      application.pipe((self) => httpGate.withPermit(self)),
      { scope },
    )
    http.on('request', handler)
    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          new Promise<void>((resolve, reject) => {
            http.once('error', reject)
            http.listen(options.port ?? 8081, options.host ?? '127.0.0.1', () => {
              http.off('error', reject)
              resolve()
            })
          }),
        catch: (error) => error,
      }),
      () =>
        Effect.promise(async () => {
          await gateway.close()
          await new Promise<void>((resolve) => http.close(() => resolve()))
          controller.abort()
        }),
    )
    let dispatching = false
    const dispatch = async () => {
      if (dispatching || controller.signal.aborted) return
      dispatching = true
      try {
        const commands = await run('dispatch', Threads.claimCommands())
        for (const command of commands)
          await gateway.sendValidated(command.node_id, command.employee_id, command.message_id, command.body)
      } catch {
        // Persisted due times retain pending work while the database or transport is unavailable.
      } finally {
        dispatching = false
      }
    }
    let placing = false
    let placementCursor = ''
    const placeProjects = async () => {
      if (placing || controller.signal.aborted) return
      placing = true
      try {
        const candidates = await run('schedule', Projects.listProjectRunCandidates(placementCursor, 32))
        for (const agentId of candidates) {
          if (controller.signal.aborted) break
          try {
            await run('schedule', Projects.scheduleProjectRun(agentId))
          } catch {
            // Each candidate has its own database budget; a busy Agent does not hold up later candidates.
          }
          placementCursor = agentId
        }
        if (candidates.length < 32) placementCursor = ''
        await run('schedule', Projects.scheduleMemoryJobs())
      } catch {
        // Committed leases and persistent due times are revisited after recovery.
      } finally {
        placing = false
      }
    }
    const projectKinds = [
      'project_run_start',
      'project_run_stop',
      'project_run_wake',
      'project_memory_start',
      'project_memory_stop',
    ] as const
    const sendingProjects = new Set<(typeof projectKinds)[number]>()
    const dispatchProjects = async (kind: (typeof projectKinds)[number]) => {
      if (sendingProjects.has(kind) || controller.signal.aborted) return
      sendingProjects.add(kind)
      try {
        const deliveries = await run('dispatch', Projects.claimProjectCommands(kind))
        for (const delivery of deliveries)
          await gateway.sendValidated(delivery.node_id, delivery.employee_id, delivery.command.run_id, delivery.command)
      } catch {
        // Each command class retains its own retry progress and sending quota.
      } finally {
        sendingProjects.delete(kind)
      }
    }
    const projectTimers = [
      setInterval(() => {
        void placeProjects()
      }, options.projectDispatchMs ?? 1000),
      ...projectKinds.map((kind) =>
        setInterval(() => {
          void dispatchProjects(kind)
        }, options.projectDispatchMs ?? 1000),
      ),
    ]
    const timer = setInterval(() => {
      void dispatch()
    }, options.dispatchMs ?? 200)
    const compensate = createRevocationCompensator(
      (effect) => run('maintenance', effect),
      (nodeId) => gateway.disconnect(nodeId),
      { concurrency: 1 },
    )
    let maintaining = false
    const maintain = async () => {
      if (maintaining || controller.signal.aborted) return
      maintaining = true
      try {
        await Promise.allSettled([
          compensate(),
          gateway.closeExpiredConnections(),
          run('maintenance', expireProjectNodeLeases()),
        ])
      } finally {
        maintaining = false
      }
    }
    const maintenanceTimer = setInterval(() => {
      void maintain()
    }, 200)
    timer.unref()
    maintenanceTimer.unref()
    for (const projectTimer of projectTimers) projectTimer.unref()
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        clearInterval(timer)
        clearInterval(maintenanceTimer)
        for (const projectTimer of projectTimers) clearInterval(projectTimer)
      }),
    )
    void maintain()
    void dispatch()
    void placeProjects()
    for (const kind of projectKinds) void dispatchProjects(kind)
    const address = http.address() as AddressInfo
    return { host: address.address, port: address.port, gateway }
  })
