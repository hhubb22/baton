import { Schema } from 'effect'
import { TraceContext } from './trace.ts'
import { FullOutputPage } from './full-output.ts'
import {
  AgentType,
  AgentStatus,
  CommandOutcome,
  MessageMode,
  ThreadStatus,
  Cursor,
  Reason,
  UUID,
  Timestamp,
  Integer,
  NonNegativeInteger,
  PositiveInteger,
  ExecutionTimeoutSeconds,
  RuntimeName,
  RootID,
  ClientMessageID,
  ProjectClientMessageID,
  StorageGeneration,
  Text,
  MessageContent,
  boundedText,
  summary,
  nonemptyText,
  jsonLimit,
  uniqueBy,
} from './common.ts'

// internal/inbox/inbox.go · Option
export const InboxOption = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,31}$/)),
  label: Text.check(Schema.isBetweenCodePoints(1, 40)),
  description: Schema.optionalKey(Text),
  recommended: Schema.optionalKey(Schema.Boolean),
})
export type InboxOption = typeof InboxOption.Type
export const InboxOptions = Schema.NullOr(
  Schema.Array(InboxOption).check(Schema.isMaxLength(50), jsonLimit(16 * 1024)),
).check(uniqueBy((value) => value.id))

// internal/inbox/inbox.go · Resolution
export const InboxResolution = Schema.Struct({
  client_request_id: Text,
  employee_id: UUID,
  option_id: Schema.optionalKey(Text),
  option_label: Schema.optionalKey(Text),
  text: Schema.optionalKey(Text),
})
export type InboxResolution = typeof InboxResolution.Type

// internal/inbox/inbox.go · Request
export const AttentionRequest = Schema.Struct({
  id: UUID,
  project_id: UUID,
  project_title: Text,
  origin_tool_call_id: Schema.optionalKey(Text),
  conversation_id: UUID,
  source: Text,
  condition_type: Schema.optionalKey(Text),
  condition_object_id: Schema.optionalKey(Text),
  title: Text.check(Schema.isBetweenCodePoints(1, 120)),
  content: boundedText(32 * 1024),
  options: InboxOptions,
  allow_text: Schema.Boolean,
  thread_id: Schema.optionalKey(UUID),
  action_url: Schema.optionalKey(Text),
  state: Text,
  version: NonNegativeInteger,
  resolution: Schema.optionalKey(Schema.NullOr(InboxResolution)),
  resolved_at: Schema.optionalKey(Schema.NullOr(Timestamp)),
  withdraw_reason: Schema.optionalKey(Text),
  created_at: Timestamp,
  updated_at: Timestamp,
})
export type AttentionRequest = typeof AttentionRequest.Type

// internal/protocol/node_settings.go · BrowseRootsRequest
export const BrowseRootsRequest = Schema.Struct({
  type: Schema.Literal('node.browse_roots_set'),
  operation_id: UUID,
  action: Schema.Literals(['add', 'remove']),
  path: Text,
})
export type BrowseRootsRequest = typeof BrowseRootsRequest.Type

export const BrowseRootsCursor = boundedText(80).check(Schema.isPattern(/^[a-f0-9]{64}:[1-9][0-9]{0,3}$/))
export const BrowseRootsQuery = Schema.Struct({ cursor: Schema.optionalKey(BrowseRootsCursor) })
export const BrowseRootsGetRequest = Schema.Struct({
  type: Schema.Literal('node.browse_roots_get'),
  operation_id: UUID,
  cursor: Schema.optionalKey(BrowseRootsCursor),
})
export type BrowseRootsGetRequest = typeof BrowseRootsGetRequest.Type

// internal/protocol/runtime_report.go · RuntimeRoot
export const RuntimeRoot = Schema.Struct({
  root_id: RootID,
  path: nonemptyText(4096),
})
export type RuntimeRoot = typeof RuntimeRoot.Type

// internal/protocol/runtime_report.go · RuntimeRepo
export const RuntimeRepo = Schema.Struct({
  path: nonemptyText(4096),
  origin: Schema.optionalKey(
    nonemptyText(4096).check(Schema.makeFilter((value) => /^[^@\\ :?#]+\/[^@\\?#]+$/.test(value))),
  ),
})
export type RuntimeRepo = typeof RuntimeRepo.Type

// internal/protocol/node_settings.go · BrowseRootsResult
export const BrowseRootsResult = Schema.Struct({
  type: Schema.Literal('node.browse_roots_result'),
  operation_id: UUID,
  ok: Schema.Boolean,
  code: Schema.optionalKey(Text),
  message: Schema.optionalKey(Text),
  roots: Schema.optionalKey(Schema.NullOr(Schema.Array(RuntimeRoot))),
  repos: Schema.optionalKey(Schema.NullOr(Schema.Array(RuntimeRepo))),
  truncated: Schema.optionalKey(Schema.Boolean),
})
export type BrowseRootsResult = typeof BrowseRootsResult.Type

export const BrowseRootsPage = Schema.Struct({
  roots: Schema.Array(RuntimeRoot).check(uniqueBy((value) => value.root_id)),
  next_cursor: Schema.optionalKey(BrowseRootsCursor),
}).check(jsonLimit(48 * 1024))
export type BrowseRootsPage = typeof BrowseRootsPage.Type
export const BrowseRootsGetResult = Schema.Struct({
  type: Schema.Literal('node.browse_roots_get_result'),
  operation_id: UUID,
  ok: Schema.Boolean,
  code: Schema.optionalKey(Text),
  message: Schema.optionalKey(Text),
  page: Schema.optionalKey(BrowseRootsPage),
}).check(jsonLimit(64 * 1024))
export type BrowseRootsGetResult = typeof BrowseRootsGetResult.Type

// internal/httpapi/events.go · browserSubscription
export const BrowserSubscription = Schema.Struct({
  thread_id: Schema.Union([Schema.Literal(''), UUID]),
  cursor: Schema.optionalKey(Cursor),
})
export type BrowserSubscription = typeof BrowserSubscription.Type

// internal/httpapi/events.go · events1
export const BrowserThreadOutput = Schema.Struct({
  type: Schema.Literal('thread.output'),
  thread_id: Schema.optionalKey(UUID),
  operation_id: UUID,
  session_id: UUID,
  ok: Schema.Boolean,
  code: Schema.optionalKey(Text),
  state: Schema.optionalKey(Text),
  text: Schema.optionalKey(boundedText(16 * 1024)),
  cursor: Schema.optionalKey(Cursor),
  gap: Schema.Boolean,
})
export type BrowserThreadOutput = typeof BrowserThreadOutput.Type

// internal/httpapi/server.go · changePassword1
export const ChangePasswordInput = Schema.Struct({
  current_password: Text,
  new_password: Text,
})
export type ChangePasswordInput = typeof ChangePasswordInput.Type

// internal/projectagent/compaction.go · PromptSnapshot
export const PromptSnapshot = Schema.Struct({
  version: Text,
  title: Text,
  goal: Text,
})
export type PromptSnapshot = typeof PromptSnapshot.Type

// internal/projectagent/compaction.go · Compaction
export const Compaction = Schema.Struct({
  through_seq: Integer,
  summary: Text,
  cleared_tool_result_seqs: Schema.NullOr(Schema.Array(Integer)),
  memory_index: Text,
  prompt: PromptSnapshot,
  tokens_before: Integer,
  tokens_after: Integer,
  provider: Text,
  model: Text,
  usage: Schema.optionalKey(Schema.Json),
})
export type Compaction = typeof Compaction.Type

// internal/httpapi/threads.go · routeThread1
export const CreateBrowserThreadInput = Schema.Struct({
  client_thread_id: ClientMessageID,
  node_id: Schema.optionalKey(UUID),
  agent_type: AgentType,
  model: Schema.optionalKey(summary(512)),
  working_directory: boundedText(4096).check(Schema.isMinLength(1)),
  execution_timeout_seconds: Schema.optionalKey(ExecutionTimeoutSeconds),
  message: Schema.Struct({
    client_message_id: ClientMessageID,
    content: boundedText(64 * 1024).check(Schema.isMinLength(1)),
  }),
})
export type CreateBrowserThreadInput = typeof CreateBrowserThreadInput.Type

// internal/projectagent/project.go · CreateInput
export const CreateProjectInput = Schema.Struct({
  client_project_id: Schema.optionalKey(Text),
  title: summary(1024).check(
    Schema.isMaxCodePoints(200),
    Schema.makeFilter((value) => value.trim().length > 0),
  ),
  goal: Schema.optionalKey(boundedText(64 * 1024)),
  provider: summary(1024),
  model: summary(1024),
})
export type CreateProjectInput = typeof CreateProjectInput.Type

// internal/store/thread_types.go · ThreadMessageInput
export const ThreadMessageInput = Schema.Struct({
  client_message_id: ClientMessageID,
  content: boundedText(64 * 1024).check(Schema.isMinLength(1)),
  mode: Schema.optionalKey(Schema.Literals(['queue', 'steer', ''])),
  model: Schema.optionalKey(summary(512)),
}).check(
  Schema.makeFilter(
    (value) => value.mode !== 'steer' || value.model === undefined || value.model === '' || '插入不能切换模型',
  ),
)
export type ThreadMessageInput = typeof ThreadMessageInput.Type

// internal/store/thread_types.go · CreateThreadInput
export const CreateThreadInput = Schema.Struct({
  client_thread_id: ClientMessageID,
  node_id: Schema.optionalKey(UUID),
  agent_type: AgentType,
  model: summary(512),
  working_directory: boundedText(4096).check(Schema.isMinLength(1)),
  project_id: Schema.optionalKey(UUID),
  execution_timeout_seconds: Schema.optionalKey(ExecutionTimeoutSeconds),
  message: ThreadMessageInput,
})
export type CreateThreadInput = typeof CreateThreadInput.Type

// internal/httpapi/nodes.go · defaultDeviceJSON
export const DefaultDevice = Schema.Struct({
  node_id: Schema.Union([Schema.Literal(''), UUID]),
  invalid: Schema.Boolean,
  needs_reselection: Schema.Boolean,
  message: Schema.optionalKey(Text),
})
export type DefaultDevice = typeof DefaultDevice.Type

// internal/httpapi/server.go · employeeBody
export const Employee = Schema.Struct({
  id: Text,
  username: Text,
  display_name: Text,
  auth_source: Text,
  must_change_password: Schema.Boolean,
})
export type Employee = typeof Employee.Type

// internal/httpapi/nodes.go · issueEnrollment1
export const EnrollmentResponse = Schema.Struct({
  enrollment_id: Text,
  enrollment_token: Text,
  expires_at: Schema.Json,
  expires_in_ms: Integer,
})
export type EnrollmentResponse = typeof EnrollmentResponse.Type

// internal/store/web_views.go · EnrollmentView
export const EnrollmentView = Schema.Struct({
  enrollment_id: Text,
  state: Text,
  device_id: Schema.NullOr(Text),
  expires_at: Timestamp,
  expires_in_ms: Integer,
})
export type EnrollmentView = typeof EnrollmentView.Type

// internal/protocol/protocol.go · Route
export const Route = Schema.Struct({
  to: Text,
})
export type Route = typeof Route.Type

// internal/protocol/protocol.go · Source
export const Source = Schema.Struct({
  kind: Schema.Literals(['node', 'control']),
  node_id: Schema.optionalKey(UUID),
  employee_id: Schema.optionalKey(UUID),
  credential_id: Schema.optionalKey(UUID),
  incarnation: Schema.optionalKey(Text),
  conn_id: Schema.optionalKey(Text),
})
export type Source = typeof Source.Type

// internal/protocol/protocol.go · Envelope
export const Envelope = Schema.Struct({
  version: Schema.Literal(1),
  message_id: UUID,
  route: Route,
  priority: Schema.Literals(['control', 'output', '']),
  correlation_id: Schema.optionalKey(summary(128)),
  body: Schema.optionalKey(Schema.Json),
  source: Schema.optionalKey(Schema.NullOr(Source)),
}).check(jsonLimit(256 * 1024))
export type Envelope = typeof Envelope.Type

// internal/httpapi/server.go · errorDetails
export const ErrorDetails = Schema.Struct({
  fields: Schema.optionalKey(Schema.NullOr(Schema.Array(Text))),
})
export type ErrorDetails = typeof ErrorDetails.Type

// internal/httpapi/server.go · errorBody
export const ErrorResponse = Schema.Struct({
  code: Text,
  message: Text,
  request_id: UUID,
  details: Schema.optionalKey(Schema.NullOr(ErrorDetails)),
})
export type ErrorResponse = typeof ErrorResponse.Type

// internal/protocol/files.go · FileEntry
export const FileEntry = Schema.Struct({
  name: Text,
  kind: Text,
  size: Schema.optionalKey(Schema.NullOr(NonNegativeInteger)),
})
export type FileEntry = typeof FileEntry.Type

// internal/protocol/files.go · FileRemainder
export const FileRemainder = Schema.Struct({
  root_id: Text,
  path: Text,
  kind: Text,
  offset: Schema.optionalKey(NonNegativeInteger),
  size: Schema.optionalKey(NonNegativeInteger),
  listed: Schema.optionalKey(NonNegativeInteger),
  scan_limited: Schema.optionalKey(Schema.Boolean),
})
export type FileRemainder = typeof FileRemainder.Type

// internal/protocol/files.go · FileRequest
export const FileRequest = Schema.Struct({
  type: Schema.Literal('files.browse'),
  operation_id: UUID,
  root_id: Schema.optionalKey(Text),
  path: Schema.optionalKey(Text),
  cursor: Schema.optionalKey(Text),
  offset: Schema.optionalKey(NonNegativeInteger),
  version: Schema.optionalKey(Text),
})
export type FileRequest = typeof FileRequest.Type

// internal/protocol/files.go · FileRoot
export const FileRoot = Schema.Struct({
  id: Text,
  path: Text,
})
export type FileRoot = typeof FileRoot.Type

// internal/protocol/files.go · FileResult
export const FileResult = Schema.Struct({
  type: Schema.Literal('files.browse_result'),
  operation_id: UUID,
  ok: Schema.Boolean,
  code: Schema.optionalKey(Text),
  message: Schema.optionalKey(Text),
  kind: Schema.optionalKey(Text),
  root_id: Schema.optionalKey(Text),
  path: Schema.optionalKey(Text),
  roots: Schema.optionalKey(Schema.NullOr(Schema.Array(FileRoot))),
  entries: Schema.optionalKey(Schema.NullOr(Schema.Array(FileEntry).check(Schema.isMaxLength(200)))),
  content: Schema.optionalKey(Schema.NullOr(boundedText(64 * 1024))),
  size: Schema.optionalKey(Schema.NullOr(NonNegativeInteger)),
  truncated: Schema.optionalKey(Schema.Boolean),
  remainder: Schema.optionalKey(Schema.NullOr(FileRemainder)),
  next_cursor: Schema.optionalKey(Text),
  offset: Schema.optionalKey(NonNegativeInteger),
  next_offset: Schema.optionalKey(NonNegativeInteger),
  version: Schema.optionalKey(Text),
})
export type FileResult = typeof FileResult.Type

// internal/httpapi/files.go · fileView
export const FileView = Schema.Struct({
  operation_id: UUID,
  node_id: UUID,
  kind: Text,
  root_id: Schema.optionalKey(Text),
  path: Schema.optionalKey(Text),
  roots: Schema.optionalKey(Schema.NullOr(Schema.Array(FileRoot))),
  entries: Schema.optionalKey(Schema.NullOr(Schema.Array(FileEntry).check(Schema.isMaxLength(200)))),
  content: Schema.optionalKey(Schema.NullOr(boundedText(64 * 1024))),
  size: Schema.optionalKey(Schema.NullOr(NonNegativeInteger)),
  truncated: Schema.Boolean,
  remainder: Schema.optionalKey(Schema.NullOr(FileRemainder)),
  next_cursor: Schema.optionalKey(Text),
  offset: Schema.optionalKey(NonNegativeInteger),
  next_offset: Schema.optionalKey(NonNegativeInteger),
  version: Schema.optionalKey(Text),
})
export type FileView = typeof FileView.Type

// internal/protocol/protocol.go · Frame
export const Frame = Schema.Struct({
  kind: Schema.Literals(['auth', 'auth_result', 'heartbeat', 'envelope', 'error']),
  ok: Schema.optionalKey(Schema.Boolean),
  code: Schema.optionalKey(Text),
  message: Schema.optionalKey(Text),
  token: Schema.optionalKey(Text),
  incarnation: Schema.optionalKey(Text),
  correlation_id: Schema.optionalKey(Text),
  envelope: Schema.optionalKey(Schema.Json),
}).check(jsonLimit(256 * 1024))
export type Frame = typeof Frame.Type

// internal/inbox/inbox.go · Handle
export const HandleAttentionInput = Schema.Struct({
  expected_version: PositiveInteger,
  client_request_id: Text,
  option_id: Schema.optionalKey(Text),
  text: Schema.optionalKey(boundedText(4 * 1024)),
})
export type HandleAttentionInput = typeof HandleAttentionInput.Type

// internal/inbox/inbox.go · Ask
export const InboxAsk = Schema.Struct({
  title: Text.check(Schema.isBetweenCodePoints(1, 120)),
  content: boundedText(32 * 1024),
  options: InboxOptions,
  allow_text: Schema.Boolean,
  thread_id: Schema.optionalKey(UUID),
})
export type InboxAsk = typeof InboxAsk.Type

// internal/httpapi/inbox.go · writeInboxError1
export const InboxConflictResponse = Schema.Struct({
  error: Text,
  current: AttentionRequest,
})
export type InboxConflictResponse = typeof InboxConflictResponse.Type

// internal/inbox/requests.go · Page
export const InboxPage = Schema.Struct({
  requests: Schema.NullOr(Schema.Array(AttentionRequest)),
  open_count: Integer,
  next_cursor: Schema.optionalKey(Text),
})
export type InboxPage = typeof InboxPage.Type

// internal/httpapi/server.go · login1
export const LoginInput = Schema.Struct({
  username: Text,
  password: Text,
})
export type LoginInput = typeof LoginInput.Type

// internal/projectagent/project.go · Memory
export const ProjectMemory = Schema.Struct({
  id: Text,
  title: summary(1024).check(
    Schema.isMaxCodePoints(200),
    Schema.makeFilter((value) => value.trim().length > 0),
  ),
  content: boundedText(64 * 1024),
  revision: Integer,
  author: Text,
  source_seq: Schema.NullOr(Integer),
  updated_at: Timestamp,
})
export type ProjectMemory = typeof ProjectMemory.Type

// internal/httpapi/projects.go · routeProject4
export const MemoriesResponse = Schema.Struct({
  entries: Schema.NullOr(Schema.Array(ProjectMemory)),
  next_after_id: Schema.optionalKey(Text),
})
export type MemoriesResponse = typeof MemoriesResponse.Type

// internal/httpapi/projects.go · writeProjectError1
export const MemoryConflictResponse = Schema.Struct({
  code: Text,
  message: Text,
  request_id: UUID,
  current_revision: Integer,
  current: Schema.NullOr(ProjectMemory),
})
export type MemoryConflictResponse = typeof MemoryConflictResponse.Type

// internal/store/web_views.go · MemoryRevision
export const MemoryRevision = Schema.Struct({
  revision: Integer,
  content: Text,
  title: Schema.NullOr(Text),
  author: Text,
  created_at: Timestamp,
})
export type MemoryRevision = typeof MemoryRevision.Type

// internal/httpapi/projects.go · routeProject3
export const MemoryRevisionsResponse = Schema.Struct({
  revisions: Schema.NullOr(Schema.Array(MemoryRevision)),
  next_after_revision: Schema.optionalKey(NonNegativeInteger),
})
export type MemoryRevisionsResponse = typeof MemoryRevisionsResponse.Type

// internal/node/identity.go · Credential
export const NodeCredential = Schema.Struct({
  id: Text,
  version: NonNegativeInteger,
  token: Text,
  expires_at: Timestamp,
})
export type NodeCredential = typeof NodeCredential.Type

// internal/node/identity.go · Identity
export const NodeIdentity = Schema.Struct({
  coordinator_url: Schema.optionalKey(Text),
  node_id: UUID,
  employee_id: UUID,
  display_name: Text,
  system: Schema.Literals(['macos', 'linux', 'windows']),
  role: Text,
  capabilities: Schema.NullOr(Schema.Array(Text)),
  registration_seq: Integer,
  registered_at: Timestamp,
  credential: NodeCredential,
  signing_public_key: Schema.optionalKey(Text),
})
export type NodeIdentity = typeof NodeIdentity.Type

// internal/httpapi/nodes.go · revocationJSON
export const NodeRevocation = Schema.Struct({
  status: Text,
  operator_id: UUID,
  credential_ids: Schema.NullOr(Schema.Array(Text)),
  requested_at: Timestamp,
  applied_at: Schema.NullOr(Timestamp),
  message: Text,
  local_process_notice: Text,
})
export type NodeRevocation = typeof NodeRevocation.Type

// internal/protocol/runtime_report.go · RuntimeModel
export const RuntimeModel = Schema.Struct({
  id: nonemptyText(512),
  name: nonemptyText(512),
})
export type RuntimeModel = typeof RuntimeModel.Type

// internal/protocol/runtime_report.go · ThreadCapabilities
export const ThreadCapabilities = Schema.Struct({
  create: Schema.Boolean,
  queue: Schema.Boolean,
  steer: Schema.Boolean,
  stop: Schema.Boolean,
  resume: Schema.Boolean,
  switch_model: Schema.Boolean,
})
export type ThreadCapabilities = typeof ThreadCapabilities.Type

// internal/protocol/runtime_report.go · RuntimeAgent
export const RuntimeAgent = Schema.Struct({
  agent_type: RuntimeName,
  version: RuntimeName,
  status: AgentStatus,
  models: Schema.NullOr(Schema.Array(RuntimeModel)).check(uniqueBy((value) => value.id)),
  default_model: summary(512),
  capabilities: ThreadCapabilities,
  reason: Schema.optionalKey(Reason),
})
export type RuntimeAgent = typeof RuntimeAgent.Type

// internal/protocol/runtime_report.go · RuntimeProvider
export const RuntimeProvider = Schema.Struct({
  models: Schema.optionalKey(
    Schema.NullOr(Schema.Array(RuntimeModel).check(Schema.isMaxLength(64))).check(uniqueBy((value) => value.id)),
  ),
  provider: RuntimeName,
  login_methods: Schema.optionalKey(
    Schema.Array(Schema.Literals(['oauth', 'api_key', 'device_code'])).check(
      Schema.isMaxLength(3),
      uniqueBy((value) => value),
    ),
  ),
  status: Schema.Literals(['available', 'login_required', 'unknown']),
  reason: Schema.optionalKey(Reason),
})
export type RuntimeProvider = typeof RuntimeProvider.Type

// internal/protocol/runtime_report.go · ProjectRuntime
export const ProjectRuntime = Schema.Struct({
  version: RuntimeName,
  max_concurrent_projects: Schema.optionalKey(PositiveInteger),
  probed_at: Schema.optionalKey(Timestamp),
  stale: Schema.optionalKey(Schema.Boolean),
  probe_error: Schema.optionalKey(Reason),
  providers: Schema.NullOr(Schema.Array(RuntimeProvider).check(Schema.isMaxLength(32))).check(
    uniqueBy((value) => value.provider),
  ),
})
export type ProjectRuntime = typeof ProjectRuntime.Type

// internal/protocol/runtime_report.go · RuntimeExec
export const RuntimeExec = Schema.Struct({
  user: Schema.optionalKey(nonemptyText(256)),
  enabled: Schema.Boolean,
  shell: nonemptyText(4096),
})
export type RuntimeExec = typeof RuntimeExec.Type

// internal/protocol/runtime_report.go · RuntimeReport
export const RuntimeReport = Schema.Struct({
  batond_version: Schema.optionalKey(nonemptyText(256)),
  user: Schema.optionalKey(nonemptyText(256)),
  agents: Schema.optionalKey(
    Schema.NullOr(Schema.Array(RuntimeAgent).check(Schema.isMaxLength(32))).check(
      uniqueBy((value) => value.agent_type),
    ),
  ),
  project_runtime: Schema.optionalKey(Schema.NullOr(ProjectRuntime)),
  exec: RuntimeExec,
  roots: Schema.NullOr(Schema.Array(RuntimeRoot).check(Schema.isMaxLength(4096))).check(
    uniqueBy((value) => value.root_id),
  ),
  repos: Schema.NullOr(Schema.Array(RuntimeRepo).check(Schema.isMaxLength(128))),
  truncated: Schema.optionalKey(Schema.Boolean),
}).check(jsonLimit(64 * 1024, 1, true))
export type RuntimeReport = typeof RuntimeReport.Type

// internal/httpapi/nodes.go · nodeStatusJSON
export const NodeStatus = Schema.Struct({
  registered_at: Timestamp,
  runtime_report: Schema.NullOr(RuntimeReport),
  runtime_report_version: NonNegativeInteger,
  runtime_reported_at: Schema.NullOr(Timestamp),
  batond_version: Schema.optionalKey(Text),
  user: Text,
  id: UUID,
  display_name: Text,
  system: Schema.Literals(['macos', 'linux', 'windows']),
  capabilities: Schema.NullOr(Schema.Array(Text)),
  registration_seq: Integer,
  online: Schema.Boolean,
  last_contact_at: Schema.NullOr(Timestamp),
  status_updated_at: Schema.NullOr(Timestamp),
  synced: Schema.Boolean,
  executable: Schema.Boolean,
  revocation_status: Text,
  revocation: Schema.optionalKey(Schema.NullOr(NodeRevocation)),
})
export type NodeStatus = typeof NodeStatus.Type

// internal/control/server.go · onEnvelope2
export const NodeSyncRequest = Schema.Struct({
  type: Schema.Literal('node.sync'),
  display_name: summary(1024).check(Schema.isBetweenCodePoints(1, 80), Schema.isTrimmed()),
  system: Schema.Literals(['macos', 'linux', 'windows']),
  role: Schema.optionalKey(Text),
  capabilities: Schema.NullOr(Schema.Array(Text)),
})
export type NodeSyncRequest = typeof NodeSyncRequest.Type

// internal/control/server.go · reply1
export const NodeSyncResult = Schema.Struct({
  type: Schema.Literal('node.sync_result'),
  ok: Schema.Boolean,
  code: Schema.optionalKey(Text),
})
export type NodeSyncResult = typeof NodeSyncResult.Type

// internal/httpapi/nodes.go · listNodes1
export const NodesResponse = Schema.Struct({
  nodes: Schema.NullOr(Schema.Array(NodeStatus)),
  default_device: DefaultDevice,
  default_pc: DefaultDevice,
  local_process_notice: Text,
})
export type NodesResponse = typeof NodesResponse.Type

// internal/httpapi/projects.go · routeProject2
export const OKResponse = Schema.Struct({
  ok: Schema.Boolean,
})
export type OKResponse = typeof OKResponse.Type

// internal/projectagent/project.go · Patch
export const PatchProjectInput = Schema.Struct({
  title: Schema.optionalKey(
    Schema.NullOr(
      summary(1024).check(
        Schema.isMaxCodePoints(200),
        Schema.makeFilter((value) => value.trim().length > 0),
      ),
    ),
  ),
  goal: Schema.optionalKey(Schema.NullOr(boundedText(64 * 1024))),
  status: Schema.optionalKey(Schema.NullOr(Schema.Literals(['active', 'paused', 'archived']))),
  provider: Schema.optionalKey(Schema.NullOr(summary(1024))),
  model: Schema.optionalKey(Schema.NullOr(summary(1024))),
}).check(
  Schema.makeFilter(
    (value) => Object.values(value).some((field) => field !== null && field !== undefined) || '至少修改一个字段',
  ),
)
export type PatchProjectInput = typeof PatchProjectInput.Type

// internal/protocol/protocol.go · Presence
export const Presence = Schema.Struct({
  node_id: UUID,
  employee_id: UUID,
  credential_id: UUID,
  incarnation: Text,
  conn_id: Text,
  online: Schema.Boolean,
  last_contact_at: Timestamp,
})
export type Presence = typeof Presence.Type

// internal/projectagent/project.go · Agent
export const ProjectAgent = Schema.Struct({
  id: UUID,
  provider: summary(1024),
  model: summary(1024),
})
export type ProjectAgent = typeof ProjectAgent.Type

// internal/projectagent/project.go · Conversation
export const ProjectConversation = Schema.Struct({
  id: UUID,
  state: Text,
  last_seq: NonNegativeInteger,
})
export type ProjectConversation = typeof ProjectConversation.Type

// internal/projectagent/project.go · Project
export const Project = Schema.Struct({
  id: UUID,
  title: summary(1024).check(
    Schema.isMaxCodePoints(200),
    Schema.makeFilter((value) => value.trim().length > 0),
  ),
  goal: boundedText(64 * 1024),
  status: Schema.Literals(['active', 'paused', 'archived']),
  version: NonNegativeInteger,
  created_at: Timestamp,
  updated_at: Timestamp,
  agent: ProjectAgent,
  conversation: ProjectConversation,
})
export type Project = typeof Project.Type

// internal/projectagent/project.go · Event
export const ProjectEvent = Schema.Struct({
  conversation_id: UUID,
  seq: NonNegativeInteger,
  kind: Text,
  client_event_id: Schema.optionalKey(Schema.NullOr(Text)),
  tool_call_id: Schema.optionalKey(Schema.NullOr(Text)),
  run_id: Schema.optionalKey(Schema.NullOr(UUID)),
  lease_epoch: Schema.optionalKey(Schema.NullOr(NonNegativeInteger)),
  payload: Schema.Json,
  created_at: Timestamp,
})
export type ProjectEvent = typeof ProjectEvent.Type

// internal/projectagent/runtime.go · Bootstrap
export const ProjectBootstrap = Schema.Struct({
  project: Project,
  prompt_version: Text,
  memory_index: Schema.optionalKey(Text),
  compaction: Schema.optionalKey(Schema.NullOr(ProjectEvent)),
  compaction_seq: Schema.optionalKey(Integer),
  goal_utf8_base64: Schema.optionalKey(Text),
  after_seq: NonNegativeInteger,
  last_seq: NonNegativeInteger,
})
export type ProjectBootstrap = typeof ProjectBootstrap.Type

// internal/projectagent/runtime.go · Claim
export const ProjectClaim = Schema.Struct({
  event: Schema.optionalKey(Schema.NullOr(ProjectEvent)),
  payload_bytes: NonNegativeInteger,
  input_count: NonNegativeInteger,
})
export type ProjectClaim = typeof ProjectClaim.Type

// internal/projectagent/project.go · EventPage
export const ProjectEventPage = Schema.Struct({
  events: Schema.NullOr(Schema.Array(ProjectEvent)),
  last_seq: NonNegativeInteger,
  next_after_seq: Integer,
  has_more: Schema.Boolean,
})
export type ProjectEventPage = typeof ProjectEventPage.Type

// internal/protocol/node_settings.go · ProjectExecRequest
export const ProjectExecRequest = Schema.Struct({
  type: Schema.Literal('node.project_exec_set'),
  operation_id: UUID,
  enabled: Schema.Boolean,
})
export type ProjectExecRequest = typeof ProjectExecRequest.Type

// internal/protocol/node_settings.go · ProjectExecResult
export const ProjectExecResult = Schema.Struct({
  type: Schema.Literal('node.project_exec_result'),
  operation_id: UUID,
  ok: Schema.Boolean,
  code: Schema.optionalKey(Text),
  exec: Schema.optionalKey(Schema.NullOr(RuntimeExec)),
})
export type ProjectExecResult = typeof ProjectExecResult.Type

// internal/projectagent/project.go · Message
export const ProjectMessage = Schema.Struct({
  id: Integer,
  client_message_id: Text,
  content: Text,
  created_at: Timestamp,
})
export type ProjectMessage = typeof ProjectMessage.Type

// internal/projectagent/project.go · MessageInput
export const ProjectMessageInput = Schema.Struct({
  client_message_id: ProjectClientMessageID,
  content: MessageContent,
})
export type ProjectMessageInput = typeof ProjectMessageInput.Type

// internal/store/project_view.go · ProjectMessagePage
export const ProjectMessagePage = Schema.Struct({
  messages: Schema.NullOr(Schema.Array(ProjectMessage)),
  next_after_id: Schema.optionalKey(NonNegativeInteger),
})
export type ProjectMessagePage = typeof ProjectMessagePage.Type

// internal/projectagent/preview.go · Preview
export const ProjectPreview = Schema.Struct({
  after_seq: NonNegativeInteger,
  text: Text,
  truncated: Schema.Boolean,
  updated_at: Timestamp,
})
export type ProjectPreview = typeof ProjectPreview.Type

// internal/projectagent/runtime.go · QueuedInput
export const ProjectQueuedInput = Schema.Struct({
  id: Integer,
  source_type: Text,
  source_key: Text,
  payload: Schema.Json,
})
export type ProjectQueuedInput = typeof ProjectQueuedInput.Type

// internal/protocol/project_runtime.go · ProjectThreadUpdate
export const ProjectThreadUpdate = Schema.Struct({
  thread_id: UUID,
  version: NonNegativeInteger,
})
export type ProjectThreadUpdate = typeof ProjectThreadUpdate.Type

// internal/protocol/project_runtime.go · ProjectRunCommand
export const ProjectRunCommand = Schema.Struct({
  type: Schema.Literals(['project_run_start', 'project_run_stop', 'project_run_wake']),
  run_id: UUID,
  lease_epoch: NonNegativeInteger,
  provider: Schema.optionalKey(Text),
  model: Schema.optionalKey(Text),
  project_id: Schema.optionalKey(UUID),
  conversation_id: Schema.optionalKey(UUID),
  thread_updates: Schema.optionalKey(Schema.NullOr(Schema.Array(ProjectThreadUpdate))),
  input_ids: Schema.optionalKey(Schema.NullOr(Schema.Array(Integer))),
})
export type ProjectRunCommand = typeof ProjectRunCommand.Type

// internal/store/project_view.go · ProjectRunView
export const ProjectRunView = Schema.Struct({
  id: UUID,
  node_id: UUID,
  node_name: Text,
  state: Text,
  effective: Schema.Boolean,
  placement_reason: Text,
  end_reason: Schema.optionalKey(Schema.NullOr(Text)),
  stop_acked_at: Schema.optionalKey(Schema.NullOr(Timestamp)),
})
export type ProjectRunView = typeof ProjectRunView.Type

// internal/protocol/project_runtime.go · ProjectRuntimeRequest
export const ProjectRuntimeRequest = Schema.Struct({
  type: Schema.Literal('project_runtime.request'),
  run_id: UUID,
  lease_epoch: NonNegativeInteger,
  operation: Schema.Literals([
    'bootstrap',
    'read_events',
    'renew',
    'started',
    'stopped',
    'wake_received',
    'claim_inputs',
    'wait_tool',
    'call_tool',
    'append_event',
    'commit_compaction',
    'finish',
    'exited',
    'start_failed',
    'report_failure',
    'preview',
  ]),
  after_seq: Schema.optionalKey(NonNegativeInteger),
  max_bytes: Schema.optionalKey(Integer),
  client_event_id: Schema.optionalKey(Text),
  last_seq: Schema.optionalKey(NonNegativeInteger),
  payload: Schema.optionalKey(Schema.Json),
  tool_call_id: Schema.optionalKey(Text),
  tool_name: Schema.optionalKey(Text),
  arguments: Schema.optionalKey(Schema.Json),
  reason: Schema.optionalKey(Text),
}).check(jsonLimit(192 * 1024))
export type ProjectRuntimeRequest = typeof ProjectRuntimeRequest.Type

// internal/protocol/project_runtime.go · ProjectRuntimeResult
export const ProjectRuntimeResult = Schema.Struct({
  type: Schema.Literal('project_runtime.result'),
  ok: Schema.Boolean,
  code: Schema.optionalKey(Text),
  data: Schema.optionalKey(Schema.Json),
}).check(jsonLimit(192 * 1024))
export type ProjectRuntimeResult = typeof ProjectRuntimeResult.Type

// internal/store/project_view.go · ProjectStatus
export const ProjectStatus = Schema.Struct({
  state: Text,
  waiting_reason: Schema.optionalKey(Text),
  pending_inputs: NonNegativeInteger,
  last_error: Schema.optionalKey(Schema.NullOr(Text)),
  next_attempt_at: Schema.optionalKey(Schema.NullOr(Timestamp)),
  last_seq: NonNegativeInteger,
  run: Schema.optionalKey(Schema.NullOr(ProjectRunView)),
  preview: Schema.optionalKey(Schema.NullOr(ProjectPreview)),
})
export type ProjectStatus = typeof ProjectStatus.Type

// internal/httpapi/projects.go · routeProject1
export const ProjectsResponse = Schema.Struct({
  projects: Schema.NullOr(Schema.Array(Project)),
  next_after_id: Schema.optionalKey(Text),
})
export type ProjectsResponse = typeof ProjectsResponse.Type

// internal/httpapi/nodes.go · registerNode1
export const RegisterNodeInput = Schema.Struct({
  enrollment_token: Text,
  display_name: summary(1024).check(Schema.isBetweenCodePoints(1, 80), Schema.isTrimmed()),
  system: Schema.Literals(['macos', 'linux', 'windows']),
  role: Schema.optionalKey(Text),
  capabilities: Schema.Array(RootID).check(Schema.isMaxLength(32), Schema.isUnique()),
})
export type RegisterNodeInput = typeof RegisterNodeInput.Type

// internal/protocol/protocol.go · Revocation
export const Revocation = Schema.Struct({
  kind: Schema.Literals(['credential', 'node']),
  id: UUID,
  node_id: Schema.optionalKey(UUID),
  revoked_at: Timestamp,
})
export type Revocation = typeof Revocation.Type

// internal/httpapi/nodes.go · revokeNode1
export const RevokeNodeResponse = Schema.Struct({
  node_id: UUID,
  status: Text,
  operator_id: UUID,
  credential_ids: Schema.NullOr(Schema.Array(Text)),
  requested_at: Timestamp,
  applied_at: Schema.NullOr(Timestamp),
  message: Text,
  local_process_notice: Text,
  default_device: DefaultDevice,
  default_pc: DefaultDevice,
})
export type RevokeNodeResponse = typeof RevokeNodeResponse.Type

// internal/protocol/runtime_report.go · RuntimeReportRequest
export const RuntimeReportRequest = Schema.Struct({
  type: Schema.Literal('node.runtime_report'),
  report: RuntimeReport,
}).check(jsonLimit(64 * 1024))
export type RuntimeReportRequest = typeof RuntimeReportRequest.Type

// internal/protocol/runtime_report.go · RuntimeReportResult
export const RuntimeReportResult = Schema.Struct({
  type: Schema.Literal('node.runtime_report_result'),
  ok: Schema.Boolean,
  code: Schema.optionalKey(Text),
  report_version: Schema.optionalKey(NonNegativeInteger),
})
export type RuntimeReportResult = typeof RuntimeReportResult.Type

// internal/node/identity.go · SavedDefault
export const SavedDefaultDevice = Schema.Struct({
  default_device_node_id: Text,
  default_pc_node_id: Text,
  role: Text,
  display_name: Text,
  system: Schema.Literals(['macos', 'linux', 'windows']),
  registration_seq: Integer,
})
export type SavedDefaultDevice = typeof SavedDefaultDevice.Type

// internal/protocol/session.go · SessionRequest
export const SessionRequest = Schema.Struct({
  type: Schema.Literal('session.request'),
  operation_id: UUID,
  session_id: UUID,
  action: Schema.Literals(['output', 'full_output']),
  output_id: Schema.optionalKey(UUID),
  storage_generation: Schema.optionalKey(StorageGeneration),
  cursor: Schema.optionalKey(Cursor),
  limit: Schema.optionalKey(Integer.check(Schema.isBetween({ minimum: 0, maximum: 16 }))),
})
export type SessionRequest = typeof SessionRequest.Type

// internal/httpapi/server.go · sessionResponse
export const SessionResponse = Schema.Struct({
  employee: Employee,
  csrf_token: Text,
  expires_at: Timestamp,
})
export type SessionResponse = typeof SessionResponse.Type

// internal/protocol/session.go · SessionResult
export const SessionResult = Schema.Struct({
  type: Schema.Literal('session.result'),
  operation_id: UUID,
  session_id: UUID,
  ok: Schema.Boolean,
  code: Schema.optionalKey(Text),
  state: Schema.optionalKey(Text),
  text: Schema.optionalKey(boundedText(16 * 1024)),
  cursor: Schema.optionalKey(Cursor),
  full_output: Schema.optionalKey(FullOutputPage),
  gap: Schema.Boolean,
})
export type SessionResult = typeof SessionResult.Type

// internal/httpapi/server.go · sessionView
export const SessionView = Schema.Struct({
  employee: Employee,
  expires_at: Schema.optionalKey(Timestamp),
})
export type SessionView = typeof SessionView.Type

// internal/httpapi/nodes.go · putDefaultDevice1
export const SetDefaultDeviceInput = Schema.Struct({
  node_id: UUID,
})
export type SetDefaultDeviceInput = typeof SetDefaultDeviceInput.Type

// internal/httpapi/node_settings.go · setProjectExec1
export const SetProjectExecInput = Schema.Struct({
  enabled: Schema.Boolean,
})
export type SetProjectExecInput = typeof SetProjectExecInput.Type

// internal/httpapi/threads.go · routeThread2
export const SetThreadSettingsInput = Schema.Struct({
  execution_timeout_seconds: ExecutionTimeoutSeconds,
})
export type SetThreadSettingsInput = typeof SetThreadSettingsInput.Type

export const SetThreadModelInput = Schema.Struct({
  model: summary(512),
})
export type SetThreadModelInput = typeof SetThreadModelInput.Type

// internal/httpapi/node_settings_web.go · startSubscriptionLogin1
export const SubscriptionLoginInput = Schema.Struct({
  provider: Text,
})
export type SubscriptionLoginInput = typeof SubscriptionLoginInput.Type

// internal/protocol/node_settings.go · SubscriptionLoginRequest
export const SubscriptionLoginRequest = Schema.Struct({
  type: Schema.Literal('node.subscription_login'),
  operation_id: UUID,
  provider: Text,
})
export type SubscriptionLoginRequest = typeof SubscriptionLoginRequest.Type

// internal/httpapi/node_settings_web.go · startSubscriptionLogin2
export const SubscriptionLoginResponse = Schema.Struct({
  provider: Text,
  verification_uri: Text,
  user_code: Text,
  expires_in_seconds: Integer,
})
export type SubscriptionLoginResponse = typeof SubscriptionLoginResponse.Type

// internal/protocol/node_settings.go · SubscriptionLoginResult
export const SubscriptionLoginResult = Schema.Struct({
  type: Schema.Literal('node.subscription_login_result'),
  operation_id: UUID,
  ok: Schema.Boolean,
  code: Schema.optionalKey(Text),
  message: Schema.optionalKey(Text),
  provider: Schema.optionalKey(Text),
  verification_uri: Schema.optionalKey(Text),
  user_code: Schema.optionalKey(Text),
  expires_in_seconds: Schema.optionalKey(Integer),
})
export type SubscriptionLoginResult = typeof SubscriptionLoginResult.Type

// internal/store/thread_types.go · Thread
export const Thread = Schema.Struct({
  next_model: Schema.optionalKey(summary(512)),
  id: UUID,
  employee_id: UUID,
  client_thread_id: ClientMessageID,
  project_id: Schema.optionalKey(UUID),
  origin_conversation_id: Schema.optionalKey(Text),
  origin_tool_call_id: Schema.optionalKey(ClientMessageID),
  node_id: UUID,
  agent_type: AgentType,
  model: summary(512),
  working_directory: boundedText(4096).check(Schema.isMinLength(1)),
  execution_timeout_seconds: Integer,
  status: ThreadStatus,
  status_reason: Text,
  created_by: Text,
  storage_generation: Schema.optionalKey(StorageGeneration),
  native_session_id: Schema.optionalKey(Text),
  opened_at: Schema.optionalKey(Schema.NullOr(Timestamp)),
  archived_at: Schema.optionalKey(Schema.NullOr(Timestamp)),
  archive_requested_at: Schema.optionalKey(Schema.NullOr(Timestamp)),
  stop_requested_at: Schema.optionalKey(Schema.NullOr(Timestamp)),
  stop_confirmed_at: Schema.optionalKey(Schema.NullOr(Timestamp)),
  last_reported_at: Schema.optionalKey(Schema.NullOr(Timestamp)),
  last_worker_seq: NonNegativeInteger,
  version: NonNegativeInteger,
  created_at: Timestamp,
  last_activity_at: Timestamp,
  node_online: Schema.Boolean,
  node_synced: Schema.Boolean,
  node_last_contact_at: Schema.optionalKey(Schema.NullOr(Timestamp)),
})
export type Thread = typeof Thread.Type

// internal/protocol/thread.go · ThreadCommand
export const ThreadCommand = Schema.Struct({
  project_id: Schema.optionalKey(UUID),
  origin_conversation_id: Schema.optionalKey(UUID),
  origin_tool_call_id: Schema.optionalKey(ClientMessageID),
  trace_context: Schema.optionalKey(TraceContext),
  type: Schema.Literal('thread.command'),
  thread_id: UUID,
  action: Schema.Literals(['open', 'message', 'withdraw', 'stop', 'resume', 'settings']),
  storage_generation: Schema.optionalKey(StorageGeneration),
  agent_type: Schema.optionalKey(AgentType),
  model: Schema.optionalKey(summary(512)),
  working_directory: Schema.optionalKey(boundedText(4096).check(Schema.isMinLength(1))),
  execution_timeout_seconds: Schema.optionalKey(ExecutionTimeoutSeconds),
  client_message_id: Schema.optionalKey(ClientMessageID),
  content: Schema.optionalKey(boundedText(64 * 1024)),
  mode: Schema.optionalKey(MessageMode),
})
export type ThreadCommand = typeof ThreadCommand.Type

// internal/protocol/thread.go · ThreadCommandResult
export const ThreadCommandResult = Schema.Struct({
  type: Schema.Literal('thread.command_result'),
  thread_id: UUID,
  ok: Schema.Boolean,
  code: Schema.optionalKey(Text),
  storage_generation: Schema.optionalKey(StorageGeneration),
})
export type ThreadCommandResult = typeof ThreadCommandResult.Type

// internal/store/thread_types.go · ThreadError
export const ThreadError = Schema.Struct({
  code: Text,
  message: Text,
  current_status: Schema.optionalKey(Text),
})
export type ThreadError = typeof ThreadError.Type

// internal/httpapi/threads.go · writeThreadError1
export const ThreadErrorResponse = Schema.Struct({
  code: Text,
  message: Text,
  current_status: Schema.optionalKey(Text),
  request_id: UUID,
})
export type ThreadErrorResponse = typeof ThreadErrorResponse.Type

// internal/store/thread_types.go · ThreadEvent
export const ThreadEvent = Schema.Struct({
  id: Integer,
  kind: Text,
  actor: Text,
  actor_id: Text,
  payload: Schema.Json,
  created_at: Timestamp,
})
export type ThreadEvent = typeof ThreadEvent.Type

// internal/store/thread_types.go · ThreadMessage
export const ThreadMessage = Schema.Struct({
  requested_model: Schema.optionalKey(Text),
  id: Text,
  thread_id: UUID,
  client_message_id: ClientMessageID,
  sender: Text,
  origin_tool_call_id: Schema.optionalKey(ClientMessageID),
  content: Text,
  mode: MessageMode,
  model: summary(512),
  status: Schema.Literals(['accepted', 'queued', 'sent', 'withdrawn', 'unknown']),
  status_reason: Text,
  turn_id: Schema.optionalKey(Text),
  worker_turn_seq: Schema.optionalKey(Schema.NullOr(NonNegativeInteger)),
  created_at: Timestamp,
})
export type ThreadMessage = typeof ThreadMessage.Type

// internal/store/thread_types.go · ThreadTurn
export const ThreadTurn = Schema.Struct({
  id: Text,
  thread_id: UUID,
  worker_turn_seq: NonNegativeInteger,
  initiator: Text,
  model: summary(512),
  origin_tool_call_id: Schema.optionalKey(Text),
  started_at: Timestamp,
  ended_at: Schema.optionalKey(Schema.NullOr(Timestamp)),
  end_reason: Schema.optionalKey(Text),
})
export type ThreadTurn = typeof ThreadTurn.Type

// internal/store/thread_types.go · ThreadSummary
export const ThreadSummary = Schema.Struct({
  next_model: Schema.optionalKey(summary(512)),
  id: UUID,
  employee_id: UUID,
  client_thread_id: ClientMessageID,
  project_id: Schema.optionalKey(UUID),
  origin_conversation_id: Schema.optionalKey(Text),
  origin_tool_call_id: Schema.optionalKey(ClientMessageID),
  node_id: UUID,
  agent_type: AgentType,
  model: summary(512),
  working_directory: boundedText(4096).check(Schema.isMinLength(1)),
  execution_timeout_seconds: Integer,
  status: ThreadStatus,
  status_reason: Text,
  created_by: Text,
  storage_generation: Schema.optionalKey(StorageGeneration),
  native_session_id: Schema.optionalKey(Text),
  opened_at: Schema.optionalKey(Schema.NullOr(Timestamp)),
  archived_at: Schema.optionalKey(Schema.NullOr(Timestamp)),
  archive_requested_at: Schema.optionalKey(Schema.NullOr(Timestamp)),
  stop_requested_at: Schema.optionalKey(Schema.NullOr(Timestamp)),
  stop_confirmed_at: Schema.optionalKey(Schema.NullOr(Timestamp)),
  last_reported_at: Schema.optionalKey(Schema.NullOr(Timestamp)),
  last_worker_seq: NonNegativeInteger,
  version: NonNegativeInteger,
  created_at: Timestamp,
  last_activity_at: Timestamp,
  node_online: Schema.Boolean,
  node_synced: Schema.Boolean,
  node_last_contact_at: Schema.optionalKey(Schema.NullOr(Timestamp)),
  title: Text,
  stop_canceled: NonNegativeInteger,
  current_turn: Schema.NullOr(ThreadTurn),
})
export type ThreadSummary = typeof ThreadSummary.Type

// internal/store/thread_types.go · ThreadPage
export const ThreadPage = Schema.Struct({
  threads: Schema.NullOr(Schema.Array(ThreadSummary)),
  next_cursor: Schema.optionalKey(Text),
})
export type ThreadPage = typeof ThreadPage.Type

// internal/protocol/thread.go · ThreadReport
export const ThreadReport = Schema.Struct({
  type: Schema.Literal('thread.report'),
  thread_id: UUID,
  event_id: UUID,
  worker_seq: PositiveInteger,
  kind: Schema.Literals([
    'thread.opened',
    'thread.open_failed',
    'message.queued',
    'message.sent',
    'message.withdrawn',
    'message.unknown',
    'turn.started',
    'reply',
    'turn.ended',
    'thread.resumed',
    'thread.stopped',
    'thread.unknown',
    'command.completed',
  ]),
  worker_turn_seq: Schema.optionalKey(NonNegativeInteger),
  client_message_id: Schema.optionalKey(ClientMessageID),
  storage_generation: Schema.optionalKey(StorageGeneration),
  native_session_id: Schema.optionalKey(boundedText(4096)),
  model: Schema.optionalKey(summary(512)),
  content: Schema.optionalKey(boundedText(1024 * 1024)),
  truncated: Schema.optionalKey(Schema.Boolean),
  original_bytes: Schema.optionalKey(NonNegativeInteger),
  attachments: Schema.optionalKey(Schema.Array(Schema.Json).check(jsonLimit(4 * 1024))),
  metadata: Schema.optionalKey(Schema.JsonObject.check(jsonLimit(4 * 1024))),
  reason: Schema.optionalKey(boundedText(4096)),
  queue_empty: Schema.optionalKey(Schema.Boolean),
  history_unavailable: Schema.optionalKey(Schema.Boolean),
  command_id: Schema.optionalKey(UUID),
  command_outcome: Schema.optionalKey(CommandOutcome),
}).check(
  Schema.makeFilter(
    (value) =>
      value.kind !== 'command.completed' ||
      (value.command_id !== undefined &&
        value.command_outcome !== undefined &&
        value.storage_generation !== undefined &&
        value.reason !== undefined) ||
      '完成报告缺少命令身份或结果',
  ),
)
export type ThreadReport = typeof ThreadReport.Type

// internal/protocol/thread.go · ThreadReportResult
export const ThreadReportResult = Schema.Struct({
  type: Schema.Literal('thread.report_result'),
  thread_id: UUID,
  event_id: UUID,
  worker_seq: PositiveInteger,
  ok: Schema.Boolean,
  code: Schema.optionalKey(Text),
  expected_worker_seq: Schema.optionalKey(NonNegativeInteger),
})
export type ThreadReportResult = typeof ThreadReportResult.Type

// internal/store/thread_types.go · ThreadTimeline
export const ThreadTimeline = Schema.Struct({
  events: Schema.NullOr(Schema.Array(ThreadEvent)),
  next_cursor: Schema.optionalKey(Text),
})
export type ThreadTimeline = typeof ThreadTimeline.Type

// internal/store/thread_trace.go · ThreadTraceStep
export const ThreadTraceStep = Schema.Struct({
  kind: Text,
  command: Schema.optionalKey(Text),
  output: Schema.optionalKey(Text),
  truncated: Schema.optionalKey(Schema.Boolean),
})
export type ThreadTraceStep = typeof ThreadTraceStep.Type

// internal/store/thread_trace.go · ThreadTrace
export const ThreadTrace = Schema.Struct({
  ok: Schema.Boolean,
  code: Schema.optionalKey(Text),
  steps: Schema.NullOr(Schema.Array(ThreadTraceStep)),
})
export type ThreadTrace = typeof ThreadTrace.Type

// internal/store/thread_types.go · ThreadView
export const ThreadView = Schema.Struct({
  resume_pending: Schema.Boolean,
  retry_open_allowed: Schema.optionalKey(Schema.Boolean),
  next_model: Schema.optionalKey(summary(512)),
  id: UUID,
  employee_id: UUID,
  client_thread_id: ClientMessageID,
  project_id: Schema.optionalKey(UUID),
  origin_conversation_id: Schema.optionalKey(Text),
  origin_tool_call_id: Schema.optionalKey(ClientMessageID),
  node_id: UUID,
  agent_type: AgentType,
  model: summary(512),
  working_directory: boundedText(4096).check(Schema.isMinLength(1)),
  execution_timeout_seconds: Integer,
  status: ThreadStatus,
  status_reason: Text,
  created_by: Text,
  storage_generation: Schema.optionalKey(StorageGeneration),
  native_session_id: Schema.optionalKey(Text),
  opened_at: Schema.optionalKey(Schema.NullOr(Timestamp)),
  archived_at: Schema.optionalKey(Schema.NullOr(Timestamp)),
  archive_requested_at: Schema.optionalKey(Schema.NullOr(Timestamp)),
  stop_requested_at: Schema.optionalKey(Schema.NullOr(Timestamp)),
  stop_confirmed_at: Schema.optionalKey(Schema.NullOr(Timestamp)),
  last_reported_at: Schema.optionalKey(Schema.NullOr(Timestamp)),
  last_worker_seq: NonNegativeInteger,
  version: NonNegativeInteger,
  created_at: Timestamp,
  last_activity_at: Timestamp,
  node_online: Schema.Boolean,
  node_synced: Schema.Boolean,
  node_last_contact_at: Schema.optionalKey(Schema.NullOr(Timestamp)),
  current_turn: Schema.NullOr(ThreadTurn),
  pending_messages: Schema.NullOr(Schema.Array(ThreadMessage)),
  failed_messages: Schema.NullOr(Schema.Array(ThreadMessage)),
})
export type ThreadView = typeof ThreadView.Type

// internal/httpapi/node_settings_web.go · updateBrowseRoots1
export const UpdateBrowseRootsInput = Schema.Struct({
  path: Text,
})
export type UpdateBrowseRootsInput = typeof UpdateBrowseRootsInput.Type

// internal/httpapi/projects.go · routeProject5
export const WriteMemoryInput = Schema.Struct({
  title: summary(1024).check(
    Schema.isMaxCodePoints(200),
    Schema.makeFilter((value) => value.trim().length > 0),
  ),
  content: boundedText(64 * 1024),
  expected_revision: NonNegativeInteger,
})
export type WriteMemoryInput = typeof WriteMemoryInput.Type

export const dtoSchemas = {
  AttentionRequest,
  BrowseRootsRequest,
  BrowseRootsResult,
  BrowseRootsGetRequest,
  BrowseRootsGetResult,
  BrowseRootsQuery,
  BrowseRootsPage,
  BrowserSubscription,
  BrowserThreadOutput,
  ChangePasswordInput,
  Compaction,
  CreateBrowserThreadInput,
  CreateProjectInput,
  CreateThreadInput,
  DefaultDevice,
  Employee,
  EnrollmentResponse,
  EnrollmentView,
  Envelope,
  ErrorDetails,
  ErrorResponse,
  FileEntry,
  FileRemainder,
  FileRequest,
  FileResult,
  FileRoot,
  FileView,
  Frame,
  HandleAttentionInput,
  InboxAsk,
  InboxConflictResponse,
  InboxOption,
  InboxPage,
  InboxResolution,
  LoginInput,
  MemoriesResponse,
  MemoryConflictResponse,
  MemoryRevision,
  MemoryRevisionsResponse,
  NodeCredential,
  NodeIdentity,
  NodeRevocation,
  NodeStatus,
  NodeSyncRequest,
  NodeSyncResult,
  NodesResponse,
  OKResponse,
  PatchProjectInput,
  Presence,
  Project,
  ProjectAgent,
  ProjectBootstrap,
  ProjectClaim,
  ProjectConversation,
  ProjectEvent,
  ProjectEventPage,
  ProjectExecRequest,
  ProjectExecResult,
  ProjectMemory,
  ProjectMessage,
  ProjectMessageInput,
  ProjectMessagePage,
  ProjectPreview,
  ProjectQueuedInput,
  ProjectRunCommand,
  ProjectRunView,
  ProjectRuntime,
  ProjectRuntimeRequest,
  ProjectRuntimeResult,
  ProjectStatus,
  ProjectThreadUpdate,
  ProjectsResponse,
  PromptSnapshot,
  RegisterNodeInput,
  Revocation,
  RevokeNodeResponse,
  Route,
  RuntimeAgent,
  RuntimeExec,
  RuntimeModel,
  RuntimeProvider,
  RuntimeRepo,
  RuntimeReport,
  RuntimeReportRequest,
  RuntimeReportResult,
  RuntimeRoot,
  SavedDefaultDevice,
  SessionRequest,
  SessionResponse,
  SessionResult,
  SessionView,
  SetDefaultDeviceInput,
  SetProjectExecInput,
  SetThreadSettingsInput,
  SetThreadModelInput,
  Source,
  SubscriptionLoginInput,
  SubscriptionLoginRequest,
  SubscriptionLoginResponse,
  SubscriptionLoginResult,
  Thread,
  ThreadCapabilities,
  ThreadCommand,
  ThreadCommandResult,
  ThreadError,
  ThreadErrorResponse,
  ThreadEvent,
  ThreadMessage,
  ThreadMessageInput,
  ThreadPage,
  ThreadReport,
  ThreadReportResult,
  ThreadSummary,
  ThreadTimeline,
  ThreadTrace,
  ThreadTraceStep,
  ThreadTurn,
  ThreadView,
  UpdateBrowseRootsInput,
  WriteMemoryInput,
} as const
