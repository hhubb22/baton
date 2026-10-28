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
import * as T from './thread.ts'
import * as P from './project.ts'
import * as D from './device.ts'
import * as A from './auth.ts'
import * as I from './inbox.ts'
import * as C from './common.ts'
import { SessionResponse } from './auth.ts'
import { EnrollmentResponse, DefaultDeviceResponse } from './device.ts'
import { Diagnostics } from './common.ts'
import * as Q from './http.ts'
import { ThreadAnswerInput } from './thread-question.ts'
import { ReleaseMetadata } from './release.ts'
import { UUID, NonNegativeInteger } from './common.ts'

export { SessionResponse } from './auth.ts'
export { EnrollmentResponse, DefaultDeviceResponse } from './device.ts'
export { Diagnostics } from './common.ts'
export const DownloadItem = Schema.Struct({
  kind: Schema.Literals(['cli', 'desktop']),
  platform: Schema.Literals(['darwin', 'linux', 'win32']),
  arch: Schema.Literals(['arm64', 'x64']),
  file: Schema.String,
  size: NonNegativeInteger,
  sha256: Schema.String,
})
export type DownloadItem = typeof DownloadItem.Type
export const DownloadsResponse = Schema.Struct({
  enabled: Schema.Boolean,
  version: Schema.String,
  connect_url: Schema.NullOr(Schema.String),
  ca_sha256: Schema.NullOr(Schema.String),
  items: Schema.Array(DownloadItem),
})
export type DownloadsResponse = typeof DownloadsResponse.Type

export class CurrentBrowserSession extends Context.Service<CurrentBrowserSession, typeof SessionResponse.Type>()(
  'baton/http/CurrentBrowserSession',
) {}

const errorBody = Schema.Struct({
  ...C.ErrorResponse.fields,
  current_revision: Schema.optionalKey(NonNegativeInteger),
  current: Schema.optionalKey(Schema.NullOr(Schema.Union([P.ProjectMemory, I.AttentionRequest]))),
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
const FileView = Schema.Struct({
  ...D.FileView.fields,
  code: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
})
// Creation and replay share a body; the internal discriminator selects the HTTP status.
const threadCreation = <const Status extends number>(status: Status) =>
  T.Thread.pipe(
    Schema.decodeTo(
      Schema.Struct({ status: Schema.Literal(status), thread: T.Thread }),
      SchemaTransformation.transform({
        decode: (thread) => ({ status, thread }),
        encode: (value) => value.thread,
      }),
    ),
    HttpApiSchema.status(status),
  )

const Public = HttpApiGroup.make('public')
  .add(
    Endpoint.get('release', '/api/v1/release', { success: ReleaseMetadata }),
    Endpoint.get('downloads', '/api/v1/downloads', { success: DownloadsResponse }),
    Endpoint.post('login', '/api/v1/login', {
      payload: A.LoginInput,
      success: HttpApiSchema.WithHeaders(SessionResponse, cookie),
    }),
    Endpoint.post('registerNode', '/api/v1/nodes/register', { payload: D.RegisterNodeInput, success: D.NodeIdentity }),
    Endpoint.post('reauthNode', '/api/v1/nodes/:nodeId/reauth', {
      params: nodeParams,
      payload: D.ReauthNodeInput,
      success: D.NodeIdentity,
    }),
  )
  .middleware(PublicRequest)

const Account = HttpApiGroup.make('account')
  .add(
    Endpoint.get('me', '/api/v1/me', { success: SessionResponse }),
    Endpoint.get('replayNotifications', '/api/v1/events/replay', {
      query: Q.NotificationReplayQuery,
      success: Q.NotificationReplay,
    }),
    Endpoint.get('activity', '/api/v1/activity', { success: Q.ActivitySnapshot }),
    Endpoint.post('logout', '/api/v1/logout', {
      payload: EmptyInput,
      success: HttpApiSchema.WithHeaders(HttpApiSchema.NoContent, cookie),
    }),
    Endpoint.post('changePassword', '/api/v1/me/password', {
      payload: A.ChangePasswordInput,
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
    Endpoint.post('issueReauthEnrollment', '/api/v1/nodes/:nodeId/reauth-enrollments', {
      params: nodeParams,
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
    Endpoint.get('getRoots', '/api/v1/nodes/:nodeId/roots', {
      params: nodeParams,
      query: D.BrowseRootsQuery,
      success: D.BrowseRootsPage,
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
    Endpoint.post('modelConnection', '/api/v1/nodes/:nodeId/model-connections', {
      params: nodeParams,
      payload: D.ModelConnectionInput,
      success: Schema.Struct({ connection: Schema.optionalKey(D.ModelConnection) }),
    }),
    Endpoint.post('subscriptionLogout', '/api/v1/nodes/:nodeId/subscriptions/logout', {
      params: nodeParams,
      payload: D.SubscriptionLoginInput,
      success: EmptyInput,
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
    Endpoint.get('list', '/api/v1/threads', { query: Q.ThreadListQuery, success: T.ThreadPage }),
    Endpoint.post('create', '/api/v1/threads', {
      payload: T.CreateBrowserThreadInput,
      success: [threadCreation(200), threadCreation(201)],
    }),
    Endpoint.get('get', '/api/v1/threads/:threadId', { params: threadParams, success: T.ThreadView }),
    Endpoint.get('timeline', '/api/v1/threads/:threadId/timeline', {
      params: threadParams,
      query: Q.ThreadTimelineQuery,
      success: T.ThreadTimeline,
    }),
    Endpoint.post('addMessage', '/api/v1/threads/:threadId/messages', {
      params: threadParams,
      payload: T.ThreadMessageInput,
      success: T.ThreadMessage.pipe(HttpApiSchema.status(202)),
    }),
    Endpoint.post('answer', '/api/v1/threads/:threadId/answer', {
      params: threadParams,
      payload: ThreadAnswerInput,
      success: T.ThreadView.pipe(HttpApiSchema.status(202)),
    }),
    Endpoint.post('withdraw', '/api/v1/threads/:threadId/messages/:messageId/withdraw', {
      params: { ...threadParams, messageId: Schema.String },
      payload: EmptyInput,
      success: T.Thread.pipe(HttpApiSchema.status(202)),
    }),
    Endpoint.post('stop', '/api/v1/threads/:threadId/stop', {
      params: threadParams,
      payload: EmptyInput,
      success: T.ThreadView.pipe(HttpApiSchema.status(202)),
    }),
    Endpoint.post('resume', '/api/v1/threads/:threadId/resume', {
      params: threadParams,
      payload: EmptyInput,
      success: T.ThreadView.pipe(HttpApiSchema.status(202)),
    }),
    Endpoint.post('archive', '/api/v1/threads/:threadId/archive', {
      params: threadParams,
      payload: EmptyInput,
      success: T.ThreadView.pipe(HttpApiSchema.status(202)),
    }),
    Endpoint.patch('setSettings', '/api/v1/threads/:threadId/settings', {
      params: threadParams,
      payload: T.SetThreadSettingsInput,
      success: T.ThreadView,
    }),
    Endpoint.post('setModel', '/api/v1/threads/:threadId/model', {
      params: threadParams,
      payload: T.SetThreadModelInput,
      success: T.ThreadView,
    }),
    Endpoint.get('output', '/api/v1/threads/:threadId/output', {
      params: threadParams,
      query: Q.ThreadOutputQuery,
      success: T.SessionResult,
    }),
    Endpoint.get('trace', '/api/v1/threads/:threadId/trace', {
      params: threadParams,
      query: Q.ThreadTraceQuery,
      success: T.ThreadTrace,
    }),
  )
  .middleware(BrowserRequest)

const Projects = HttpApiGroup.make('projects')
  .add(
    Endpoint.get('list', '/api/v1/projects', { query: Q.ProjectListQuery, success: P.ProjectsResponse }),
    Endpoint.post('create', '/api/v1/projects', {
      payload: P.CreateProjectInput,
      success: P.Project.pipe(HttpApiSchema.status(201)),
    }),
    Endpoint.get('get', '/api/v1/projects/:projectId', { params: projectParams, success: P.Project }),
    Endpoint.patch('update', '/api/v1/projects/:projectId', {
      params: projectParams,
      payload: P.PatchProjectInput,
      success: P.Project,
    }),
    Endpoint.get('status', '/api/v1/projects/:projectId/status', { params: projectParams, success: P.ProjectStatus }),
    Endpoint.get('messages', '/api/v1/projects/:projectId/messages', {
      params: projectParams,
      query: Q.ProjectMessagesQuery,
      success: P.ProjectMessagePage,
    }),
    Endpoint.post('addMessage', '/api/v1/projects/:projectId/messages', {
      params: projectParams,
      payload: P.ProjectMessageInput,
      success: P.ProjectMessage.pipe(HttpApiSchema.status(202)),
    }),
    Endpoint.get('events', '/api/v1/projects/:projectId/events', {
      params: projectParams,
      query: Q.ProjectEventsQuery,
      success: P.ProjectEventPage,
    }),
    Endpoint.post('stop', '/api/v1/projects/:projectId/stop', {
      params: projectParams,
      payload: EmptyInput,
      success: C.OKResponse,
    }),
    Endpoint.post('retry', '/api/v1/projects/:projectId/retry', {
      params: projectParams,
      payload: EmptyInput,
      success: C.OKResponse,
    }),
    Endpoint.get('memory', '/api/v1/projects/:projectId/memory', {
      params: projectParams,
      query: Q.MemoryListQuery,
      success: P.MemoriesResponse,
    }),
    Endpoint.get('memoryTopics', '/api/v1/projects/:projectId/memory/topics', {
      params: projectParams,
      success: P.MemoryTopicsResponse,
    }),
    Endpoint.get('memoryStatus', '/api/v1/projects/:projectId/memory/status', {
      params: projectParams,
      success: P.MemoryWorkStatus,
    }),
    Endpoint.post('recallMemory', '/api/v1/projects/:projectId/memory/recall', {
      params: projectParams,
      payload: P.MemoryRecallInput,
      success: P.MemoryRecallResult,
    }),
    Endpoint.get('memorySource', '/api/v1/projects/:projectId/memory/sources/:sourceId', {
      params: { ...projectParams, sourceId: UUID },
      query: Q.MemorySourceQuery,
      success: P.MemorySourcePage,
    }),
    Endpoint.post('changeMemory', '/api/v1/projects/:projectId/memory/:memoryId/changes', {
      params: memoryParams,
      payload: P.ChangeMemoryInput,
      success: P.ProjectMemory,
    }),
    Endpoint.get('getMemory', '/api/v1/projects/:projectId/memory/:memoryId', {
      params: memoryParams,
      success: P.ProjectMemory,
    }),
    Endpoint.put('writeMemory', '/api/v1/projects/:projectId/memory/:memoryId', {
      params: memoryParams,
      payload: P.WriteMemoryInput,
      success: P.ProjectMemory,
    }),
    Endpoint.get('memoryRevisions', '/api/v1/projects/:projectId/memory/:memoryId/revisions', {
      params: memoryParams,
      query: Q.MemoryRevisionsQuery,
      success: P.MemoryRevisionsResponse,
    }),
  )
  .middleware(BrowserRequest)

const Inbox = HttpApiGroup.make('inbox')
  .add(
    Endpoint.get('list', '/api/v1/inbox', { query: Q.InboxQuery, success: I.InboxPage }),
    Endpoint.get('get', '/api/v1/attention-requests/:requestId', {
      params: { requestId: UUID },
      success: I.AttentionRequest,
    }),
    Endpoint.post('answer', '/api/v1/attention-requests/:requestId/answer', {
      params: { requestId: UUID },
      payload: I.HandleAttentionInput,
      success: I.AttentionRequest,
    }),
    Endpoint.post('close', '/api/v1/attention-requests/:requestId/close', {
      params: { requestId: UUID },
      payload: Schema.Struct({
        expected_version: I.HandleAttentionInput.fields.expected_version,
        client_request_id: I.HandleAttentionInput.fields.client_request_id,
      }),
      success: I.AttentionRequest,
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
