import { Schema } from 'effect'
import { TraceContext } from './trace.ts'
import { FullOutputPage } from './full-output.ts'
import { ThreadQuestion, ThreadAnswerInput, ThreadQuestionAnswer } from './thread-question.ts'
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

// 静态字段基线与历史来源见 ../fixtures/README.md。
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

export const InboxResolution = Schema.Struct({
  client_request_id: Text,
  employee_id: UUID,
  option_id: Schema.optionalKey(Text),
  option_label: Schema.optionalKey(Text),
  text: Schema.optionalKey(Text),
})
export type InboxResolution = typeof InboxResolution.Type

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

export const RuntimeRoot = Schema.Struct({
  root_id: RootID,
  path: nonemptyText(4096),
})
export type RuntimeRoot = typeof RuntimeRoot.Type

export const RuntimeRepo = Schema.Struct({
  path: nonemptyText(4096),
  origin: Schema.optionalKey(
    nonemptyText(4096).check(Schema.makeFilter((value) => /^[^@\\ :?#]+\/[^@\\?#]+$/.test(value))),
  ),
})
export type RuntimeRepo = typeof RuntimeRepo.Type

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

export const BrowserSubscription = Schema.Struct({
  thread_id: Schema.Union([Schema.Literal(''), UUID]),
  cursor: Schema.optionalKey(Cursor),
})
export type BrowserSubscription = typeof BrowserSubscription.Type

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

export const ChangePasswordInput = Schema.Struct({
  current_password: Text,
  new_password: Text,
})
export type ChangePasswordInput = typeof ChangePasswordInput.Type

export const PromptSnapshot = Schema.Struct({
  version: Text,
  title: Text,
  goal: Text,
})
export type PromptSnapshot = typeof PromptSnapshot.Type

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

export const DefaultDevice = Schema.Struct({
  node_id: Schema.Union([Schema.Literal(''), UUID]),
  invalid: Schema.Boolean,
  needs_reselection: Schema.Boolean,
  message: Schema.optionalKey(Text),
})
export type DefaultDevice = typeof DefaultDevice.Type

export const Employee = Schema.Struct({
  id: Text,
  username: Text,
  display_name: Text,
  auth_source: Text,
  must_change_password: Schema.Boolean,
})
export type Employee = typeof Employee.Type

export const EnrollmentResponse = Schema.Struct({
  enrollment_id: Text,
  enrollment_token: Text,
  expires_at: Schema.Json,
  expires_in_ms: Integer,
})
export type EnrollmentResponse = typeof EnrollmentResponse.Type

export const EnrollmentView = Schema.Struct({
  enrollment_id: Text,
  state: Text,
  device_id: Schema.NullOr(Text),
  expires_at: Timestamp,
  expires_in_ms: Integer,
})
export type EnrollmentView = typeof EnrollmentView.Type

export const Route = Schema.Struct({
  to: Text,
})
export type Route = typeof Route.Type

export const Source = Schema.Struct({
  kind: Schema.Literals(['node', 'control']),
  node_id: Schema.optionalKey(UUID),
  employee_id: Schema.optionalKey(UUID),
  credential_id: Schema.optionalKey(UUID),
  incarnation: Schema.optionalKey(Text),
  conn_id: Schema.optionalKey(Text),
})
export type Source = typeof Source.Type

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

export const ErrorDetails = Schema.Struct({
  fields: Schema.optionalKey(Schema.NullOr(Schema.Array(Text))),
})
export type ErrorDetails = typeof ErrorDetails.Type

export const ErrorResponse = Schema.Struct({
  code: Text,
  message: Text,
  request_id: UUID,
  details: Schema.optionalKey(Schema.NullOr(ErrorDetails)),
})
export type ErrorResponse = typeof ErrorResponse.Type

export const FileEntry = Schema.Struct({
  name: Text,
  kind: Text,
  size: Schema.optionalKey(Schema.NullOr(NonNegativeInteger)),
})
export type FileEntry = typeof FileEntry.Type

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

export const FileRoot = Schema.Struct({
  id: Text,
  path: Text,
})
export type FileRoot = typeof FileRoot.Type

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

export const HandleAttentionInput = Schema.Struct({
  expected_version: PositiveInteger,
  client_request_id: Text,
  option_id: Schema.optionalKey(Text),
  text: Schema.optionalKey(boundedText(4 * 1024)),
})
export type HandleAttentionInput = typeof HandleAttentionInput.Type

export const InboxAsk = Schema.Struct({
  title: Text.check(Schema.isBetweenCodePoints(1, 120)),
  content: boundedText(32 * 1024),
  options: InboxOptions,
  allow_text: Schema.Boolean,
  thread_id: Schema.optionalKey(UUID),
})
export type InboxAsk = typeof InboxAsk.Type

export const InboxConflictResponse = Schema.Struct({
  error: Text,
  current: AttentionRequest,
})
export type InboxConflictResponse = typeof InboxConflictResponse.Type

export const InboxPage = Schema.Struct({
  requests: Schema.NullOr(Schema.Array(AttentionRequest)),
  open_count: Integer,
  next_cursor: Schema.optionalKey(Text),
})
export type InboxPage = typeof InboxPage.Type

export const LoginInput = Schema.Struct({
  username: Text,
  password: Text,
})
export type LoginInput = typeof LoginInput.Type

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

export const MemoriesResponse = Schema.Struct({
  entries: Schema.NullOr(Schema.Array(ProjectMemory)),
  next_after_id: Schema.optionalKey(Text),
})
export type MemoriesResponse = typeof MemoriesResponse.Type

export const MemoryConflictResponse = Schema.Struct({
  code: Text,
  message: Text,
  request_id: UUID,
  current_revision: Integer,
  current: Schema.NullOr(ProjectMemory),
})
export type MemoryConflictResponse = typeof MemoryConflictResponse.Type

export const MemoryRevision = Schema.Struct({
  revision: Integer,
  content: Text,
  title: Schema.NullOr(Text),
  author: Text,
  created_at: Timestamp,
})
export type MemoryRevision = typeof MemoryRevision.Type

export const MemoryRevisionsResponse = Schema.Struct({
  revisions: Schema.NullOr(Schema.Array(MemoryRevision)),
  next_after_revision: Schema.optionalKey(NonNegativeInteger),
})
export type MemoryRevisionsResponse = typeof MemoryRevisionsResponse.Type

export const NodeCredential = Schema.Struct({
  id: Text,
  version: NonNegativeInteger,
  token: Text,
  expires_at: Timestamp,
})
export type NodeCredential = typeof NodeCredential.Type

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

export const RuntimeModel = Schema.Struct({
  id: nonemptyText(512),
  name: nonemptyText(512),
})
export type RuntimeModel = typeof RuntimeModel.Type

export const ThreadCapabilities = Schema.Struct({
  create: Schema.Boolean,
  queue: Schema.Boolean,
  steer: Schema.Boolean,
  stop: Schema.Boolean,
  resume: Schema.Boolean,
  switch_model: Schema.Boolean,
})
export type ThreadCapabilities = typeof ThreadCapabilities.Type

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

export const RuntimeExec = Schema.Struct({
  user: Schema.optionalKey(nonemptyText(256)),
  enabled: Schema.Boolean,
  shell: nonemptyText(4096),
})
export type RuntimeExec = typeof RuntimeExec.Type

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

export const NodeSyncRequest = Schema.Struct({
  type: Schema.Literal('node.sync'),
  display_name: summary(1024).check(Schema.isBetweenCodePoints(1, 80), Schema.isTrimmed()),
  system: Schema.Literals(['macos', 'linux', 'windows']),
  role: Schema.optionalKey(Text),
  capabilities: Schema.NullOr(Schema.Array(Text)),
})
export type NodeSyncRequest = typeof NodeSyncRequest.Type

export const NodeSyncResult = Schema.Struct({
  type: Schema.Literal('node.sync_result'),
  ok: Schema.Boolean,
  code: Schema.optionalKey(Text),
})
export type NodeSyncResult = typeof NodeSyncResult.Type

export const NodesResponse = Schema.Struct({
  nodes: Schema.NullOr(Schema.Array(NodeStatus)),
  default_device: DefaultDevice,
  default_pc: DefaultDevice,
  local_process_notice: Text,
})
export type NodesResponse = typeof NodesResponse.Type

export const OKResponse = Schema.Struct({
  ok: Schema.Boolean,
})
export type OKResponse = typeof OKResponse.Type

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

export const ProjectAgent = Schema.Struct({
  id: UUID,
  provider: summary(1024),
  model: summary(1024),
})
export type ProjectAgent = typeof ProjectAgent.Type

export const ProjectConversation = Schema.Struct({
  id: UUID,
  state: Text,
  last_seq: NonNegativeInteger,
})
export type ProjectConversation = typeof ProjectConversation.Type

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

export const ProjectClaim = Schema.Struct({
  event: Schema.optionalKey(Schema.NullOr(ProjectEvent)),
  payload_bytes: NonNegativeInteger,
  input_count: NonNegativeInteger,
})
export type ProjectClaim = typeof ProjectClaim.Type

export const ProjectEventPage = Schema.Struct({
  events: Schema.NullOr(Schema.Array(ProjectEvent)),
  last_seq: NonNegativeInteger,
  next_after_seq: Integer,
  has_more: Schema.Boolean,
})
export type ProjectEventPage = typeof ProjectEventPage.Type

export const ProjectExecRequest = Schema.Struct({
  type: Schema.Literal('node.project_exec_set'),
  operation_id: UUID,
  enabled: Schema.Boolean,
})
export type ProjectExecRequest = typeof ProjectExecRequest.Type

export const ProjectExecResult = Schema.Struct({
  type: Schema.Literal('node.project_exec_result'),
  operation_id: UUID,
  ok: Schema.Boolean,
  code: Schema.optionalKey(Text),
  exec: Schema.optionalKey(Schema.NullOr(RuntimeExec)),
})
export type ProjectExecResult = typeof ProjectExecResult.Type

export const ProjectMessage = Schema.Struct({
  id: Integer,
  client_message_id: Text,
  content: Text,
  created_at: Timestamp,
})
export type ProjectMessage = typeof ProjectMessage.Type

export const ProjectMessageInput = Schema.Struct({
  client_message_id: ProjectClientMessageID,
  content: MessageContent,
})
export type ProjectMessageInput = typeof ProjectMessageInput.Type

export const ProjectMessagePage = Schema.Struct({
  messages: Schema.NullOr(Schema.Array(ProjectMessage)),
  next_after_id: Schema.optionalKey(NonNegativeInteger),
})
export type ProjectMessagePage = typeof ProjectMessagePage.Type

export const ProjectPreview = Schema.Struct({
  after_seq: NonNegativeInteger,
  text: Text,
  truncated: Schema.Boolean,
  updated_at: Timestamp,
})
export type ProjectPreview = typeof ProjectPreview.Type

export const ProjectQueuedInput = Schema.Struct({
  id: Integer,
  source_type: Text,
  source_key: Text,
  payload: Schema.Json,
})
export type ProjectQueuedInput = typeof ProjectQueuedInput.Type

export const ProjectThreadUpdate = Schema.Struct({
  thread_id: UUID,
  version: NonNegativeInteger,
})
export type ProjectThreadUpdate = typeof ProjectThreadUpdate.Type

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

export const ProjectRuntimeResult = Schema.Struct({
  type: Schema.Literal('project_runtime.result'),
  ok: Schema.Boolean,
  code: Schema.optionalKey(Text),
  data: Schema.optionalKey(Schema.Json),
}).check(jsonLimit(192 * 1024))
export type ProjectRuntimeResult = typeof ProjectRuntimeResult.Type

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

export const ProjectsResponse = Schema.Struct({
  projects: Schema.NullOr(Schema.Array(Project)),
  next_after_id: Schema.optionalKey(Text),
})
export type ProjectsResponse = typeof ProjectsResponse.Type

export const RegisterNodeInput = Schema.Struct({
  enrollment_token: Text,
  display_name: summary(1024).check(Schema.isBetweenCodePoints(1, 80), Schema.isTrimmed()),
  system: Schema.Literals(['macos', 'linux', 'windows']),
  role: Schema.optionalKey(Text),
  capabilities: Schema.Array(RootID).check(Schema.isMaxLength(32), Schema.isUnique()),
})
export type RegisterNodeInput = typeof RegisterNodeInput.Type

export const Revocation = Schema.Struct({
  kind: Schema.Literals(['credential', 'node']),
  id: UUID,
  node_id: Schema.optionalKey(UUID),
  revoked_at: Timestamp,
})
export type Revocation = typeof Revocation.Type

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

export const RuntimeReportRequest = Schema.Struct({
  type: Schema.Literal('node.runtime_report'),
  report: RuntimeReport,
}).check(jsonLimit(64 * 1024))
export type RuntimeReportRequest = typeof RuntimeReportRequest.Type

export const RuntimeReportResult = Schema.Struct({
  type: Schema.Literal('node.runtime_report_result'),
  ok: Schema.Boolean,
  code: Schema.optionalKey(Text),
  report_version: Schema.optionalKey(NonNegativeInteger),
})
export type RuntimeReportResult = typeof RuntimeReportResult.Type

export const SavedDefaultDevice = Schema.Struct({
  default_device_node_id: Text,
  default_pc_node_id: Text,
  role: Text,
  display_name: Text,
  system: Schema.Literals(['macos', 'linux', 'windows']),
  registration_seq: Integer,
})
export type SavedDefaultDevice = typeof SavedDefaultDevice.Type

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

export const SessionResponse = Schema.Struct({
  employee: Employee,
  csrf_token: Text,
  expires_at: Timestamp,
})
export type SessionResponse = typeof SessionResponse.Type

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

export const SessionView = Schema.Struct({
  employee: Employee,
  expires_at: Schema.optionalKey(Timestamp),
})
export type SessionView = typeof SessionView.Type

export const SetDefaultDeviceInput = Schema.Struct({
  node_id: UUID,
})
export type SetDefaultDeviceInput = typeof SetDefaultDeviceInput.Type

export const SetProjectExecInput = Schema.Struct({
  enabled: Schema.Boolean,
})
export type SetProjectExecInput = typeof SetProjectExecInput.Type

export const SetThreadSettingsInput = Schema.Struct({
  execution_timeout_seconds: ExecutionTimeoutSeconds,
})
export type SetThreadSettingsInput = typeof SetThreadSettingsInput.Type

export const SetThreadModelInput = Schema.Struct({
  model: summary(512),
})
export type SetThreadModelInput = typeof SetThreadModelInput.Type

export const SubscriptionLoginInput = Schema.Struct({
  provider: Text,
})
export type SubscriptionLoginInput = typeof SubscriptionLoginInput.Type

export const SubscriptionLoginRequest = Schema.Struct({
  type: Schema.Literal('node.subscription_login'),
  operation_id: UUID,
  provider: Text,
})
export type SubscriptionLoginRequest = typeof SubscriptionLoginRequest.Type

export const SubscriptionLoginResponse = Schema.Struct({
  provider: Text,
  verification_uri: Text,
  user_code: Text,
  expires_in_seconds: Integer,
})
export type SubscriptionLoginResponse = typeof SubscriptionLoginResponse.Type

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

export const ThreadCommand = Schema.Struct({
  project_id: Schema.optionalKey(UUID),
  origin_conversation_id: Schema.optionalKey(UUID),
  origin_tool_call_id: Schema.optionalKey(ClientMessageID),
  trace_context: Schema.optionalKey(TraceContext),
  type: Schema.Literal('thread.command'),
  thread_id: UUID,
  action: Schema.Literals(['open', 'message', 'withdraw', 'stop', 'resume', 'settings', 'answer']),
  answer: Schema.optionalKey(ThreadAnswerInput),
  storage_generation: Schema.optionalKey(StorageGeneration),
  agent_type: Schema.optionalKey(AgentType),
  model: Schema.optionalKey(summary(512)),
  working_directory: Schema.optionalKey(boundedText(4096).check(Schema.isMinLength(1))),
  execution_timeout_seconds: Schema.optionalKey(ExecutionTimeoutSeconds),
  client_message_id: Schema.optionalKey(ClientMessageID),
  content: Schema.optionalKey(boundedText(64 * 1024)),
  mode: Schema.optionalKey(MessageMode),
}).check(Schema.makeFilter((value) => value.action !== 'answer' || value.answer !== undefined || '回答命令缺少答案'))
export type ThreadCommand = typeof ThreadCommand.Type

export const ThreadCommandResult = Schema.Struct({
  type: Schema.Literal('thread.command_result'),
  thread_id: UUID,
  ok: Schema.Boolean,
  code: Schema.optionalKey(Text),
  storage_generation: Schema.optionalKey(StorageGeneration),
})
export type ThreadCommandResult = typeof ThreadCommandResult.Type

export const ThreadError = Schema.Struct({
  code: Text,
  message: Text,
  current_status: Schema.optionalKey(Text),
})
export type ThreadError = typeof ThreadError.Type

export const ThreadErrorResponse = Schema.Struct({
  code: Text,
  message: Text,
  current_status: Schema.optionalKey(Text),
  request_id: UUID,
})
export type ThreadErrorResponse = typeof ThreadErrorResponse.Type

export const ThreadEvent = Schema.Struct({
  id: Integer,
  kind: Text,
  actor: Text,
  actor_id: Text,
  payload: Schema.Json,
  created_at: Timestamp,
})
export type ThreadEvent = typeof ThreadEvent.Type

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

export const ThreadPage = Schema.Struct({
  threads: Schema.NullOr(Schema.Array(ThreadSummary)),
  next_cursor: Schema.optionalKey(Text),
})
export type ThreadPage = typeof ThreadPage.Type

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
    'question.pending',
    'question.resolved',
  ]),
  question: Schema.optionalKey(ThreadQuestion),
  request_id: Schema.optionalKey(nonemptyText(512)),
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
      value.kind !== 'question.pending' ||
      (value.question !== undefined && value.worker_turn_seq !== undefined && value.worker_turn_seq > 0) ||
      '提问报告缺少问题或回合',
  ),
  Schema.makeFilter(
    (value) => value.kind !== 'question.resolved' || value.request_id !== undefined || '提问结束报告缺少请求标识',
  ),
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

export const ThreadTimeline = Schema.Struct({
  events: Schema.NullOr(Schema.Array(ThreadEvent)),
  next_cursor: Schema.optionalKey(Text),
})
export type ThreadTimeline = typeof ThreadTimeline.Type

export const ThreadTraceStep = Schema.Struct({
  kind: Text,
  command: Schema.optionalKey(Text),
  output: Schema.optionalKey(Text),
  truncated: Schema.optionalKey(Schema.Boolean),
})
export type ThreadTraceStep = typeof ThreadTraceStep.Type

export const ThreadTrace = Schema.Struct({
  ok: Schema.Boolean,
  code: Schema.optionalKey(Text),
  steps: Schema.NullOr(Schema.Array(ThreadTraceStep)),
})
export type ThreadTrace = typeof ThreadTrace.Type

export const ThreadView = Schema.Struct({
  question_answers: Schema.Array(ThreadQuestionAnswer),
  pending_questions: Schema.Array(Schema.Struct({ ...ThreadQuestion.fields, worker_turn_seq: PositiveInteger })),
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

export const UpdateBrowseRootsInput = Schema.Struct({
  path: Text,
})
export type UpdateBrowseRootsInput = typeof UpdateBrowseRootsInput.Type

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
