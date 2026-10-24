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
import * as Threads from './threads.ts'
import { AppError, type NodeSource } from './errors.ts'
import { Gateway } from './gateway.ts'
import { createRevocationCompensator } from './control-maintenance.ts'
import { cookieToken, httpApplication } from './http.ts'

export interface ServerOptions {
  readonly host?: string
  readonly port?: number
  readonly allowedOrigins: ReadonlyArray<string>
  readonly signer: Nodes.CredentialSigner
  readonly sessionTTLSeconds?: number
  readonly enrollmentTTLSeconds?: number
  readonly nodeCredentialTTLSeconds?: number
  readonly tls?: TLSOptions
  readonly webDirectory?: string
  readonly dispatchMs?: number
  readonly heartbeatMs?: number
  readonly offlineMs?: number
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
    const run = async <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>, budgetMs = 1000): Promise<A> => {
      const result = await Effect.runPromiseExitWith(services)(
        effect.pipe((self) => controlGate.withPermit(self), Effect.timeout(budgetMs)),
        { signal: controller.signal },
      )
      if (Exit.isSuccess(result)) return result.value
      const error = Cause.squash(result.cause)
      throw error instanceof AppError ? error : new AppError(503, 'unavailable')
    }
    const authorizeBrowser = async (cookie: string) => {
      const session = await run(Auth.lookupSession(cookieToken(cookie)))
      if (session.employee.must_change_password) throw new AppError(403, 'password_change_required')
      return session.employee.id
    }
    const output = async (employeeId: string, threadId: string, cursor?: string): Promise<P.SessionResult> => {
      const thread = await run(Threads.view(employeeId, threadId))
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
              authenticate: async (token, incarnation, connId): Promise<NodeSource> => {
                const claims = await run(Nodes.authenticateNode(token, options.signer))
                const source = {
                  employee_id: claims.employee_id,
                  node_id: claims.node_id,
                  credential_id: claims.credential_id,
                  incarnation,
                  conn_id: connId,
                }
                await run(Nodes.claimConnection(source))
                return source
              },
              validate: (source) => run(Nodes.revalidateNodeSource(source)),
              heartbeat: (source) => run(Nodes.touchNode(source)),
              disconnected: (source) => run(Nodes.disconnectNode(source)),
              handle: async (source, envelope) => {
                const body = Schema.decodeUnknownSync(P.NodeToControlBody)(envelope.body)
                switch (body.type) {
                  case 'node.sync':
                    await run(
                      Nodes.syncNode(source, {
                        display_name: body.display_name,
                        system: body.system,
                        capabilities: body.capabilities ?? [],
                      }),
                    )
                    gateway.notify(source.employee_id, { type: 'thread.changed' })
                    return { type: 'node.sync_result', ok: true }
                  case 'node.runtime_report': {
                    const version = await run(Nodes.saveRuntimeReport(source, body.report))
                    gateway.notify(source.employee_id, {
                      type: 'devices.changed',
                      node_id: source.node_id,
                      report_version: version,
                    })
                    return { type: 'node.runtime_report_result', ok: true, report_version: version }
                  }
                  case 'thread.command_result':
                    if (!envelope.correlation_id) throw new AppError(400, 'missing_correlation')
                    await run(Threads.processReceipt(source, envelope.correlation_id, body))
                    gateway.notify(source.employee_id, { type: 'thread.changed' })
                    return undefined
                  case 'thread.report': {
                    const ack = await run(Threads.processReport(source, body))
                    gateway.notify(source.employee_id, { type: 'thread.changed' })
                    return { ...ack }
                  }
                  default:
                    throw new AppError(400, 'unsupported_message')
                }
              },
              browser: authorizeBrowser,
              thread: async (employeeId, threadId) => {
                await run(Threads.view(employeeId, threadId))
              },
              output,
            },
            {
              allowedOrigins: options.allowedOrigins,
              tracer,
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
        const commands = await run(Threads.claimCommands())
        for (const command of commands)
          gateway.send(command.node_id, command.employee_id, command.message_id, command.body)
      } catch {
        // Persisted due times retain pending work while the database or transport is unavailable.
      } finally {
        dispatching = false
      }
    }
    const timer = setInterval(() => {
      void dispatch()
    }, options.dispatchMs ?? 200)
    const compensate = createRevocationCompensator(run, (nodeId) => gateway.disconnect(nodeId), { concurrency: 1 })
    const maintenanceTimer = setInterval(() => {
      void compensate().catch(() => undefined)
    }, 200)
    timer.unref()
    maintenanceTimer.unref()
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        clearInterval(timer)
        clearInterval(maintenanceTimer)
      }),
    )
    void compensate().catch(() => undefined)
    void dispatch()
    const address = http.address() as AddressInfo
    return { host: address.address, port: address.port, gateway }
  })
