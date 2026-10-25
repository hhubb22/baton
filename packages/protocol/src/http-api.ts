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

const errorBody = Schema.Struct({
  ...D.ErrorResponse.fields,
  current_revision: Schema.optionalKey(NonNegativeInteger),
  current: Schema.optionalKey(Schema.NullOr(Schema.Union([D.ProjectMemory, D.AttentionRequest]))),
  error: Schema.optionalKey(Schema.String),
})
const failure = <const Status extends number>(status: Status) =>
  errorBody.pipe(
    Schema.decodeTo(
      Schema.Struct({ ...errorBody.fields, status: Schema.Literal(status) }),
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
const projectParams = { projectId: UUID }
const memoryParams = { ...projectParams, memoryId: UUID }
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
    Endpoint.post('addRoot', '/api/v1/nodes/:nodeId/roots', {
      params: nodeParams,
      payload: D.UpdateBrowseRootsInput,
      success: D.NodeStatus,
    }),
    Endpoint.delete('removeRoot', '/api/v1/nodes/:nodeId/roots', {
      params: nodeParams,
      payload: D.UpdateBrowseRootsInput,
      success: D.NodeStatus,
    }),
    Endpoint.put('setProjectExec', '/api/v1/nodes/:nodeId/project-exec', {
      params: nodeParams,
      payload: D.SetProjectExecInput,
      success: D.NodeStatus,
    }),
    Endpoint.post('subscriptionLogin', '/api/v1/nodes/:nodeId/subscriptions/login', {
      params: nodeParams,
      payload: D.SubscriptionLoginInput,
      success: D.SubscriptionLoginResponse,
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
    Endpoint.get('trace', '/api/v1/threads/:threadId/trace', {
      params: threadParams,
      query: Q.ThreadTraceQuery,
      success: D.ThreadTrace,
    }),
  )
  .middleware(BrowserRequest)

const Projects = HttpApiGroup.make('projects')
  .add(
    Endpoint.get('list', '/api/v1/projects', { query: Q.ProjectListQuery, success: D.ProjectsResponse }),
    Endpoint.post('create', '/api/v1/projects', {
      payload: D.CreateProjectInput,
      success: D.Project.pipe(HttpApiSchema.status(201)),
    }),
    Endpoint.get('get', '/api/v1/projects/:projectId', { params: projectParams, success: D.Project }),
    Endpoint.patch('update', '/api/v1/projects/:projectId', {
      params: projectParams,
      payload: D.PatchProjectInput,
      success: D.Project,
    }),
    Endpoint.get('status', '/api/v1/projects/:projectId/status', { params: projectParams, success: D.ProjectStatus }),
    Endpoint.get('messages', '/api/v1/projects/:projectId/messages', {
      params: projectParams,
      query: Q.ProjectMessagesQuery,
      success: D.ProjectMessagePage,
    }),
    Endpoint.post('addMessage', '/api/v1/projects/:projectId/messages', {
      params: projectParams,
      payload: D.ProjectMessageInput,
      success: D.ProjectMessage.pipe(HttpApiSchema.status(202)),
    }),
    Endpoint.get('events', '/api/v1/projects/:projectId/events', {
      params: projectParams,
      query: Q.ProjectEventsQuery,
      success: D.ProjectEventPage,
    }),
    Endpoint.post('stop', '/api/v1/projects/:projectId/stop', {
      params: projectParams,
      payload: EmptyInput,
      success: D.OKResponse,
    }),
    Endpoint.post('retry', '/api/v1/projects/:projectId/retry', {
      params: projectParams,
      payload: EmptyInput,
      success: D.OKResponse,
    }),
    Endpoint.get('memory', '/api/v1/projects/:projectId/memory', {
      params: projectParams,
      query: Q.ProjectListQuery,
      success: D.MemoriesResponse,
    }),
    Endpoint.get('getMemory', '/api/v1/projects/:projectId/memory/:memoryId', {
      params: memoryParams,
      success: D.ProjectMemory,
    }),
    Endpoint.put('writeMemory', '/api/v1/projects/:projectId/memory/:memoryId', {
      params: memoryParams,
      payload: D.WriteMemoryInput,
      success: D.ProjectMemory,
    }),
    Endpoint.get('memoryRevisions', '/api/v1/projects/:projectId/memory/:memoryId/revisions', {
      params: memoryParams,
      query: Q.MemoryRevisionsQuery,
      success: D.MemoryRevisionsResponse,
    }),
  )
  .middleware(BrowserRequest)

const Inbox = HttpApiGroup.make('inbox')
  .add(
    Endpoint.get('list', '/api/v1/inbox', { query: Q.InboxQuery, success: D.InboxPage }),
    Endpoint.get('get', '/api/v1/attention-requests/:requestId', {
      params: { requestId: UUID },
      success: D.AttentionRequest,
    }),
    Endpoint.post('answer', '/api/v1/attention-requests/:requestId/answer', {
      params: { requestId: UUID },
      payload: D.HandleAttentionInput,
      success: D.AttentionRequest,
    }),
    Endpoint.post('close', '/api/v1/attention-requests/:requestId/close', {
      params: { requestId: UUID },
      payload: Schema.Struct({
        expected_version: D.HandleAttentionInput.fields.expected_version,
        client_request_id: D.HandleAttentionInput.fields.client_request_id,
      }),
      success: D.AttentionRequest,
    }),
  )
  .middleware(BrowserRequest)

const System = HttpApiGroup.make('system')
  .add(Endpoint.get('diagnostics', '/api/v1/diagnostics', { success: Diagnostics }))
  .middleware(BrowserRequest)

export const BatonHttpApi = HttpApi.make('baton')
  .add(Public, Account, Nodes, Threads, Projects, Inbox, System)
  .annotate(HttpApi.PayloadParseOptions, { onExcessProperty: 'error' })
  .annotate(HttpApi.QueryParseOptions, { onExcessProperty: 'error' })
  .annotateMerge(
    OpenApi.annotations({
      title: 'Baton HTTP API',
      version: '0.0.0',
      description:
        'TypeScript center HTTP endpoints for accounts, devices, Threads, Projects, memory and Inbox. Mutations require an allowed Origin and, for cookie sessions, X-CSRF-Token.',
    }),
  )

/** Generates the document without a running server or database. */
export const httpOpenApi = () => OpenApi.fromApi(BatonHttpApi)
