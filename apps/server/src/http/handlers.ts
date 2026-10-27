import { Effect, Layer } from 'effect'
import { HttpApiBuilder, HttpApiSchema } from 'effect/http-api'
import * as SqlClient from 'effect/sql/SqlClient'
import * as P from '@baton/protocol'
import {
  BatonHttpApi,
  CurrentBrowserSession,
  DefaultDeviceResponse,
  EnrollmentResponse,
} from '@baton/protocol/http-api'
import * as Auth from '../auth.ts'
import * as Nodes from '../nodes.ts'
import * as Threads from '../threads/index.ts'
import type { HTTPOptions } from './options.ts'
import { AppError } from '../errors.ts'
import { projectHttpHandlers } from './projects.ts'
import { readThreadOutput } from '../full-output.ts'
import * as DeviceManagement from '../device-management.ts'
import { cookieToken, httpBusiness, decodeResponse } from './security.ts'

export const httpHandlers = (options: HTTPOptions) => {
  const changed = (employeeId: string) => options.gateway().notify(employeeId, { type: 'thread.changed' })
  const defaultDevice = (nodeId: string) =>
    Effect.gen(function* () {
      const { employee } = yield* CurrentBrowserSession
      return yield* Nodes.setDefaultDevice(employee.id, nodeId).pipe(
        Effect.flatMap(decodeResponse(DefaultDeviceResponse)),
      )
    })
  const action = (operation: typeof Threads.stop | typeof Threads.resume, threadId: string) =>
    Effect.gen(function* () {
      const { employee } = yield* CurrentBrowserSession
      yield* operation(employee.id, threadId)
      changed(employee.id)
      return yield* Threads.view({ employeeId: employee.id }, threadId)
    })
  return Layer.mergeAll(
    projectHttpHandlers(),
    HttpApiBuilder.group(BatonHttpApi, 'public', (handlers) =>
      handlers
        .handle('login', ({ payload }) =>
          httpBusiness(
            Effect.gen(function* () {
              const result = yield* Auth.login(payload.username, payload.password, options.sessionTTLSeconds)
              return HttpApiSchema.withHeaders({
                body: { employee: result.employee, csrf_token: result.csrf_token, expires_at: result.expires_at },
                headers: { 'set-cookie': Auth.sessionCookie(result.token, result.expires_at) },
              })
            }),
          ),
        )
        .handle('reauthNode', ({ params, payload }) =>
          httpBusiness(
            Nodes.reauthenticateNode(params.nodeId, payload, options.signer).pipe(
              Effect.flatMap(decodeResponse(P.NodeIdentity)),
            ),
          ),
        )
        .handle('registerNode', ({ payload }) =>
          httpBusiness(
            Nodes.registerNode(payload, options.signer).pipe(Effect.flatMap(decodeResponse(P.NodeIdentity))),
          ),
        ),
    ),
    HttpApiBuilder.group(BatonHttpApi, 'account', (handlers) =>
      handlers
        .handle('me', () => CurrentBrowserSession)
        .handle('logout', ({ request }) =>
          httpBusiness(
            Effect.gen(function* () {
              const { employee } = yield* CurrentBrowserSession
              const token = cookieToken(request.headers.cookie ?? '')
              yield* Auth.logout(token)
              options.gateway().disconnectBrowsers(employee.id, token)
              return HttpApiSchema.withHeaders({
                body: undefined,
                headers: { 'set-cookie': Auth.clearSessionCookie() },
              })
            }),
          ),
        )
        .handle('changePassword', ({ payload }) =>
          httpBusiness(
            Effect.gen(function* () {
              const { employee } = yield* CurrentBrowserSession
              yield* Auth.changePassword(employee.id, payload.current_password, payload.new_password)
              options.gateway().disconnectBrowsers(employee.id)
              return HttpApiSchema.withHeaders({
                body: undefined,
                headers: { 'set-cookie': Auth.clearSessionCookie() },
              })
            }),
          ),
        ),
    ),
    HttpApiBuilder.group(BatonHttpApi, 'nodes', (handlers) =>
      handlers
        .handle('issueReauthEnrollment', ({ params }) =>
          httpBusiness(
            Effect.gen(function* () {
              const { employee } = yield* CurrentBrowserSession
              return yield* Nodes.issueReauthEnrollment(employee.id, params.nodeId).pipe(
                Effect.flatMap(decodeResponse(EnrollmentResponse)),
              )
            }),
          ),
        )
        .handle('issueEnrollment', () =>
          httpBusiness(
            Effect.gen(function* () {
              const { employee } = yield* CurrentBrowserSession
              const result = yield* Nodes.issueEnrollment(employee.id, options.enrollmentTTLSeconds)
              return yield* decodeResponse(EnrollmentResponse)(result)
            }),
          ),
        )
        .handle('getEnrollment', ({ params }) =>
          httpBusiness(
            Effect.gen(function* () {
              const { employee } = yield* CurrentBrowserSession
              return yield* Nodes.getEnrollment(employee.id, params.enrollmentId).pipe(
                Effect.flatMap(decodeResponse(P.EnrollmentView)),
              )
            }),
          ),
        )
        .handle('list', () =>
          httpBusiness(
            Effect.gen(function* () {
              const { employee } = yield* CurrentBrowserSession
              return yield* Nodes.listNodes(employee.id).pipe(Effect.flatMap(decodeResponse(P.NodesResponse)))
            }),
          ),
        )
        .handle('get', ({ params }) =>
          httpBusiness(
            Effect.gen(function* () {
              const { employee } = yield* CurrentBrowserSession
              return yield* Nodes.getNode(employee.id, params.nodeId).pipe(Effect.flatMap(decodeResponse(P.NodeStatus)))
            }),
          ),
        )
        .handle('setDefaultDevice', ({ payload }) => httpBusiness(defaultDevice(payload.node_id)))
        .handle('setDefaultPC', ({ payload }) => httpBusiness(defaultDevice(payload.node_id)))
        .handle('revoke', ({ params }) =>
          httpBusiness(
            Effect.gen(function* () {
              const { employee } = yield* CurrentBrowserSession
              yield* Nodes.revokeNode(employee.id, params.nodeId)
              yield* Effect.tryPromise({
                try: () => options.gateway().disconnect(params.nodeId),
                catch: () => new AppError(503, 'revocation_pending'),
              })
              yield* Nodes.markRevocationApplied(employee.id, params.nodeId)
              return yield* Nodes.getRevocation(employee.id, params.nodeId).pipe(
                Effect.flatMap(decodeResponse(P.RevokeNodeResponse)),
              )
            }),
          ),
        )
        .handle('getRoots', ({ params, query }) =>
          httpBusiness(
            Effect.gen(function* () {
              const { employee } = yield* CurrentBrowserSession
              return yield* DeviceManagement.getBrowseRoots(employee.id, params.nodeId, query, options.gateway())
            }),
          ),
        )
        .handle('addRoot', ({ params, payload }) =>
          httpBusiness(
            Effect.gen(function* () {
              const { employee } = yield* CurrentBrowserSession
              return yield* DeviceManagement.updateBrowseRoots(
                employee.id,
                params.nodeId,
                'add',
                payload.path,
                options.gateway(),
              )
            }),
          ),
        )
        .handle('removeRoot', ({ params, payload }) =>
          httpBusiness(
            Effect.gen(function* () {
              const { employee } = yield* CurrentBrowserSession
              return yield* DeviceManagement.updateBrowseRoots(
                employee.id,
                params.nodeId,
                'remove',
                payload.path,
                options.gateway(),
              )
            }),
          ),
        )
        .handle('setProjectExec', ({ params, payload }) =>
          httpBusiness(
            Effect.gen(function* () {
              const { employee } = yield* CurrentBrowserSession
              return yield* DeviceManagement.setProjectExec(
                employee.id,
                params.nodeId,
                payload.enabled,
                options.gateway(),
              )
            }),
          ),
        )
        .handle('subscriptionLogin', ({ params, payload }) =>
          httpBusiness(
            Effect.gen(function* () {
              const { employee } = yield* CurrentBrowserSession
              return yield* DeviceManagement.startSubscriptionLogin(
                employee.id,
                params.nodeId,
                payload.provider,
                options.gateway(),
              )
            }),
          ),
        )
        .handle('files', ({ params, query }) =>
          httpBusiness(
            Effect.gen(function* () {
              const { employee } = yield* CurrentBrowserSession
              const { offset, ...rest } = query
              return yield* DeviceManagement.browse(
                employee.id,
                params.nodeId,
                { ...rest, ...(offset == null ? {} : { offset: Number(offset) }) },
                options.gateway(),
              )
            }),
          ),
        ),
    ),
    HttpApiBuilder.group(BatonHttpApi, 'threads', (handlers) =>
      handlers
        .handle('list', ({ query }) =>
          httpBusiness(
            Effect.gen(function* () {
              const { employee } = yield* CurrentBrowserSession
              return yield* Threads.list(employee.id, query)
            }),
          ),
        )
        .handle('create', ({ payload }) =>
          httpBusiness(
            Effect.gen(function* () {
              const { employee } = yield* CurrentBrowserSession
              const result = yield* Threads.create(employee.id, payload)
              changed(employee.id)
              return result.created
                ? { status: 201 as const, thread: result.thread }
                : { status: 200 as const, thread: result.thread }
            }),
          ),
        )
        .handle('get', ({ params }) =>
          httpBusiness(
            Effect.gen(function* () {
              const { employee } = yield* CurrentBrowserSession
              return yield* Threads.view({ employeeId: employee.id }, params.threadId)
            }),
          ),
        )
        .handle('timeline', ({ params, query }) =>
          httpBusiness(
            Effect.gen(function* () {
              const { employee } = yield* CurrentBrowserSession
              return yield* Threads.timeline(employee.id, params.threadId, query)
            }),
          ),
        )
        .handle('addMessage', ({ params, payload }) =>
          httpBusiness(
            Effect.gen(function* () {
              const { employee } = yield* CurrentBrowserSession
              const message = yield* Threads.addMessage(employee.id, params.threadId, payload)
              changed(employee.id)
              return message
            }),
          ),
        )
        .handle('answer', ({ params, payload }) =>
          httpBusiness(
            Effect.gen(function* () {
              const { employee } = yield* CurrentBrowserSession
              yield* Threads.answer(employee.id, params.threadId, payload)
              changed(employee.id)
              return yield* Threads.view({ employeeId: employee.id }, params.threadId)
            }),
          ),
        )
        .handle('withdraw', ({ params }) =>
          httpBusiness(
            Effect.gen(function* () {
              const { employee } = yield* CurrentBrowserSession
              return yield* Threads.withdraw(employee.id, params.threadId, params.messageId)
            }),
          ),
        )
        .handle('stop', ({ params }) => httpBusiness(action(Threads.stop, params.threadId)))
        .handle('resume', ({ params }) => httpBusiness(action(Threads.resume, params.threadId)))
        .handle('archive', ({ params }) => httpBusiness(action(Threads.archive, params.threadId)))
        .handle('setModel', ({ params, payload }) =>
          httpBusiness(
            Effect.gen(function* () {
              const { employee } = yield* CurrentBrowserSession
              yield* Threads.setModel(employee.id, params.threadId, payload)
              return yield* Threads.view({ employeeId: employee.id }, params.threadId)
            }),
          ),
        )
        .handle('setSettings', ({ params, payload }) =>
          httpBusiness(
            Effect.gen(function* () {
              const { employee } = yield* CurrentBrowserSession
              yield* Threads.setSettings(employee.id, params.threadId, payload)
              const result = yield* Threads.view({ employeeId: employee.id }, params.threadId)
              changed(employee.id)
              return result
            }),
          ),
        )
        .handle('output', ({ params, query }) =>
          httpBusiness(
            Effect.gen(function* () {
              const { employee } = yield* CurrentBrowserSession
              return yield* readThreadOutput(options, employee.id, params.threadId, query)
            }),
          ),
        )
        .handle('trace', ({ params, query }) =>
          httpBusiness(
            Effect.gen(function* () {
              const { employee } = yield* CurrentBrowserSession
              return yield* Threads.trace({ employeeId: employee.id }, params.threadId, {
                worker_turn_seq: Number(query.worker_turn_seq),
                ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
              })
            }),
          ),
        ),
    ),
    HttpApiBuilder.group(BatonHttpApi, 'system', (handlers) =>
      handlers.handle('diagnostics', () =>
        httpBusiness(
          Effect.gen(function* () {
            const { employee } = yield* CurrentBrowserSession
            const sql = yield* SqlClient.SqlClient
            const statuses = yield* sql<{
              status: typeof P.ThreadStatus.Type
              count: number
            }>`SELECT status,count(*)::integer AS count
        FROM threads WHERE employee_id=${employee.id}::uuid GROUP BY status ORDER BY status`
            return { ...options.gateway().diagnostics(employee.id), thread_statuses: statuses }
          }),
        ),
      ),
    ),
  )
}
