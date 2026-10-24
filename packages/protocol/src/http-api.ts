import { Context, Schema, SchemaTransformation } from 'effect'
import {
  HttpApi,
  HttpApiEndpoint as Endpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
  OpenApi,
} from 'effect/http-api'
import * as D from './dto.ts'
import * as Q from './http.ts'
import { UUID, Timestamp, NonNegativeInteger, ThreadStatus } from './common.ts'

export const SessionResponse = Schema.Struct({
  employee: D.Employee,
  csrf_token: Schema.String,
  expires_at: Timestamp,
})
export class CurrentBrowserSession extends Context.Service<CurrentBrowserSession, typeof SessionResponse.Type>()(
  'baton/http/CurrentBrowserSession',
) {}

const failure = <const Status extends number>(status: Status) =>
  D.ErrorResponse.pipe(
    Schema.decodeTo(
      Schema.Struct({ ...D.ErrorResponse.fields, status: Schema.Literal(status) }),
      SchemaTransformation.transform({
        decode: (body) => ({ ...body, status }),
        encode: ({ status: _status, ...body }) => body,
      }),
    ),
    HttpApiSchema.status(status),
  )
export const HttpErrorStatus = Schema.Literals([400, 401, 403, 404, 409, 413, 415, 422, 429, 500, 501, 503])
export const HttpErrors = HttpErrorStatus.literals.map(failure)
export type HttpFailure = (typeof HttpErrors)[number]['Type']

export class PublicRequest extends HttpApiMiddleware.Service<PublicRequest>()('baton/http/PublicRequest', {
  error: HttpErrors,
}) {}
export class BrowserRequest extends HttpApiMiddleware.Service<BrowserRequest, { provides: CurrentBrowserSession }>()(
  'baton/http/BrowserRequest',
  {
    error: HttpErrors,
    security: { session: HttpApiSecurity.apiKey({ key: 'baton_session', in: 'cookie' }) },
  },
) {}

const EmptyInput = Schema.Record(Schema.String, Schema.Never)
const cookie = { 'set-cookie': Schema.String }
const nodeParams = { nodeId: UUID }
const threadParams = { threadId: UUID }
export const EnrollmentResponse = Schema.Struct({ ...D.EnrollmentResponse.fields, expires_at: Timestamp })
const FileView = Schema.Struct({
  ...D.FileView.fields,
  code: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
})
export const DefaultDeviceResponse = Schema.Struct({
  default_device_node_id: UUID,
  default_pc_node_id: UUID,
  role: Schema.Literal('pc'),
  display_name: Schema.String,
  system: Schema.Literals(['macos', 'linux', 'windows']),
  registration_seq: NonNegativeInteger,
})
export const Diagnostics = Schema.Struct({
  nodes: NonNegativeInteger,
  browsers: NonNegativeInteger,
  pending_rpc: NonNegativeInteger,
  connections: NonNegativeInteger,
  pending_disconnects: NonNegativeInteger,
  received_bytes: NonNegativeInteger,
  sent_bytes: NonNegativeInteger,
  queued_control_messages: NonNegativeInteger,
  queued_control_bytes: NonNegativeInteger,
  thread_statuses: Schema.Array(Schema.Struct({ status: ThreadStatus, count: NonNegativeInteger })),
})
// Creation and replay share a body; the internal discriminator selects the HTTP status.
const threadCreation = <const Status extends number>(status: Status) =>
  D.Thread.pipe(
    Schema.decodeTo(
      Schema.Struct({ status: Schema.Literal(status), thread: D.Thread }),
      SchemaTransformation.transform({
        decode: (thread) => ({ status, thread }),
        encode: (value) => value.thread,
      }),
    ),
    HttpApiSchema.status(status),
  )

const Public = HttpApiGroup.make('public')
  .add(
    Endpoint.post('login', '/api/v1/login', {
      payload: D.LoginInput,
      success: HttpApiSchema.WithHeaders(SessionResponse, cookie),
    }),
    Endpoint.post('registerNode', '/api/v1/nodes/register', { payload: D.RegisterNodeInput, success: D.NodeIdentity }),
  )
  .middleware(PublicRequest)

const Account = HttpApiGroup.make('account')
  .add(
    Endpoint.get('me', '/api/v1/me', { success: SessionResponse }),
    Endpoint.post('logout', '/api/v1/logout', {
      payload: EmptyInput,
      success: HttpApiSchema.WithHeaders(HttpApiSchema.NoContent, cookie),
    }),
    Endpoint.post('changePassword', '/api/v1/me/password', {
      payload: D.ChangePasswordInput,
      success: HttpApiSchema.WithHeaders(HttpApiSchema.NoContent, cookie),
    }),
  )
  .middleware(BrowserRequest)

const Nodes = HttpApiGroup.make('nodes')
  .add(
    Endpoint.post('issueEnrollment', '/api/v1/node-enrollments', {
      payload: EmptyInput,
      success: EnrollmentResponse.pipe(HttpApiSchema.status(201)),
    }),
    Endpoint.get('getEnrollment', '/api/v1/node-enrollments/:enrollmentId', {
      params: { enrollmentId: UUID },
      success: D.EnrollmentView,
    }),
    Endpoint.get('list', '/api/v1/nodes', { success: D.NodesResponse }),
    Endpoint.get('get', '/api/v1/nodes/:nodeId', { params: nodeParams, success: D.NodeStatus }),
    Endpoint.put('setDefaultDevice', '/api/v1/me/default-device', {
      payload: D.SetDefaultDeviceInput,
      success: DefaultDeviceResponse,
    }),
    Endpoint.put('setDefaultPC', '/api/v1/me/default-pc', {
      payload: D.SetDefaultDeviceInput,
      success: DefaultDeviceResponse,
    }),
    Endpoint.post('revoke', '/api/v1/nodes/:nodeId/revoke', {
      params: nodeParams,
      payload: EmptyInput,
      success: D.RevokeNodeResponse,
    }),
    Endpoint.get('files', '/api/v1/nodes/:nodeId/files', {
      params: nodeParams,
      query: Q.FilesQuery,
      success: FileView,
    }),
  )
  .middleware(BrowserRequest)

const Threads = HttpApiGroup.make('threads')
  .add(
    Endpoint.get('list', '/api/v1/threads', { query: Q.ThreadListQuery, success: D.ThreadPage }),
    Endpoint.post('create', '/api/v1/threads', {
      payload: D.CreateBrowserThreadInput,
      success: [threadCreation(200), threadCreation(201)],
    }),
    Endpoint.get('get', '/api/v1/threads/:threadId', { params: threadParams, success: D.ThreadView }),
    Endpoint.get('timeline', '/api/v1/threads/:threadId/timeline', {
      params: threadParams,
      query: Q.ThreadTimelineQuery,
      success: D.ThreadTimeline,
    }),
    Endpoint.post('addMessage', '/api/v1/threads/:threadId/messages', {
      params: threadParams,
      payload: D.ThreadMessageInput,
      success: D.ThreadMessage.pipe(HttpApiSchema.status(202)),
    }),
    Endpoint.post('withdraw', '/api/v1/threads/:threadId/messages/:messageId/withdraw', {
      params: { ...threadParams, messageId: Schema.String },
      payload: EmptyInput,
      success: D.Thread.pipe(HttpApiSchema.status(202)),
    }),
    Endpoint.post('stop', '/api/v1/threads/:threadId/stop', {
      params: threadParams,
      payload: EmptyInput,
      success: D.ThreadView.pipe(HttpApiSchema.status(202)),
    }),
    Endpoint.post('resume', '/api/v1/threads/:threadId/resume', {
      params: threadParams,
      payload: EmptyInput,
      success: D.ThreadView.pipe(HttpApiSchema.status(202)),
    }),
    Endpoint.post('archive', '/api/v1/threads/:threadId/archive', {
      params: threadParams,
      payload: EmptyInput,
      success: D.ThreadView.pipe(HttpApiSchema.status(202)),
    }),
    Endpoint.post('setModel', '/api/v1/threads/:threadId/model', {
      params: threadParams,
      payload: D.SetThreadModelInput,
      success: D.ThreadView,
    }),
    Endpoint.get('output', '/api/v1/threads/:threadId/output', {
      params: threadParams,
      query: Q.ThreadOutputQuery,
      success: D.SessionResult,
    }),
    Endpoint.get('history', '/api/v1/threads/:threadId/history', {
      params: threadParams,
      query: Q.ThreadHistoryQuery,
      success: D.SessionResult,
    }),
    Endpoint.get('trace', '/api/v1/threads/:threadId/trace', {
      params: threadParams,
      query: Q.ThreadTraceQuery,
      success: D.ThreadTrace,
    }),
  )
  .middleware(BrowserRequest)

const System = HttpApiGroup.make('system')
  .add(Endpoint.get('diagnostics', '/api/v1/diagnostics', { success: Diagnostics }))
  .middleware(BrowserRequest)

export const BatonHttpApi = HttpApi.make('baton')
  .add(Public, Account, Nodes, Threads, System)
  .annotate(HttpApi.PayloadParseOptions, { onExcessProperty: 'error' })
  .annotate(HttpApi.QueryParseOptions, { onExcessProperty: 'error' })
  .annotateMerge(
    OpenApi.annotations({
      title: 'Baton HTTP API',
      version: '0.0.0',
      description:
        'TypeScript center HTTP endpoints. Mutations require an allowed Origin and, for cookie sessions, X-CSRF-Token. Project and other unavailable features return feature_unavailable.',
    }),
  )

/** Generates the document without a running server or database. */
export const httpOpenApi = () => OpenApi.fromApi(BatonHttpApi)
