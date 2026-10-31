import { Schema } from 'effect'
import { RuntimeMode } from '@t3tools/contracts'
import {
  AgentStatus,
  Reason,
  UUID,
  Timestamp,
  Integer,
  NonNegativeInteger,
  PositiveInteger,
  RuntimeName,
  RootID,
  Text,
  boundedText,
  summary,
  nonemptyText,
  jsonLimit,
  uniqueBy,
} from './common.ts'

export const DefaultDeviceResponse = Schema.Struct({
  default_device_node_id: UUID,
  default_pc_node_id: UUID,
  role: Schema.Literal('pc'),
  display_name: Schema.String,
  system: Schema.Literals(['macos', 'linux', 'windows']),
  registration_seq: NonNegativeInteger,
})
export type DefaultDeviceResponse = typeof DefaultDeviceResponse.Type

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

export const DefaultDevice = Schema.Struct({
  node_id: Schema.Union([Schema.Literal(''), UUID]),
  invalid: Schema.Boolean,
  needs_reselection: Schema.Boolean,
  message: Schema.optionalKey(Text),
})
export type DefaultDevice = typeof DefaultDevice.Type

export const EnrollmentResponse = Schema.Struct({
  enrollment_id: Text,
  enrollment_token: Text,
  expires_at: Timestamp,
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

const ThinkingOptionId = Schema.Literals(['reasoningEffort', 'thinking', 'effortLevel', 'thought_level'])

export const ThinkingCapability = Schema.Struct({
  id: ThinkingOptionId,
  options: Schema.Array(
    Schema.Struct({
      id: nonemptyText(128),
      label: nonemptyText(256),
      is_default: Schema.optionalKey(Schema.Boolean),
    }),
  ).check(Schema.isMaxLength(32)),
  current_value: Schema.optionalKey(nonemptyText(128)),
})
export type ThinkingCapability = typeof ThinkingCapability.Type

export const ThinkingSelection = Schema.Struct({
  id: ThinkingOptionId,
  value: nonemptyText(128),
})
export type ThinkingSelection = typeof ThinkingSelection.Type

export const RuntimeModel = Schema.Struct({
  id: nonemptyText(512),
  name: nonemptyText(512),
  thinking: Schema.optionalKey(ThinkingCapability),
})
export type RuntimeModel = typeof RuntimeModel.Type

export const ModelConnection = Schema.Struct({
  id: UUID,
  name: nonemptyText(128).check(Schema.isTrimmed()),
  protocol: Schema.Literals(['openai-responses', 'openai-completions', 'anthropic-messages']),
  base_url: nonemptyText(2048),
  models: Schema.Array(nonemptyText(512).check(Schema.isTrimmed())).check(Schema.isMaxLength(64), Schema.isUnique()),
})
export type ModelConnection = typeof ModelConnection.Type

export const ModelConnectionInput = Schema.Struct({
  action: Schema.Literals(['save', 'delete', 'get']),
  connection: ModelConnection,
})
export const ModelConnectionRequest = Schema.Struct({
  type: Schema.Literal('node.model_connection'),
  operation_id: UUID,
  ...ModelConnectionInput.fields,
})
export type ModelConnectionRequest = typeof ModelConnectionRequest.Type
export const ModelConnectionResult = Schema.Struct({
  type: Schema.Literal('node.model_connection_result'),
  operation_id: UUID,
  ok: Schema.Boolean,
  code: Schema.optionalKey(Text),
  connection: Schema.optionalKey(ModelConnection),
})
export type ModelConnectionResult = typeof ModelConnectionResult.Type

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
  runtime_modes: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ id: RuntimeMode, available: Schema.Boolean, reason: Schema.optionalKey(Reason) }),
    ).check(uniqueBy((value) => value.id)),
  ),
  default_runtime_mode: Schema.optionalKey(RuntimeMode),
  capabilities: ThreadCapabilities,
  reason: Schema.optionalKey(Reason),
})
export type RuntimeAgent = typeof RuntimeAgent.Type

export const RuntimeProvider = Schema.Struct({
  models_truncated: Schema.optionalKey(Schema.Boolean),
  connection: Schema.optionalKey(
    Schema.Struct({
      id: UUID,
      name: nonemptyText(128),
      protocol: Schema.Literals(['openai-responses', 'openai-completions', 'anthropic-messages']),
      base_url: nonemptyText(2048),
    }),
  ),
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
  memory_protocol: Schema.optionalKey(Schema.Literal(1)),
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

export const NodeUpgradeState = Schema.Struct({
  operation_id: UUID,
  source_version: nonemptyText(256),
  target_version: nonemptyText(256),
  phase: Schema.Literals(['draining', 'ready', 'migrating', 'syncing', 'completed', 'cancelled', 'failed']),
})
export type NodeUpgradeState = typeof NodeUpgradeState.Type

export const NodeUpdatePhase = Schema.Literals([
  'requested',
  'downloading',
  'verifying',
  'draining',
  'ready',
  'migrating',
  'syncing',
  'completed',
  'cancelled',
  'failed',
])
export const NodeUpdateRequest = Schema.Struct({
  operation_id: UUID,
  attempt: PositiveInteger,
  phase: NodeUpdatePhase,
  reason: Schema.optionalKey(Reason),
  created_at: Timestamp,
  management_last_seen: Schema.optionalKey(Timestamp),
})
export type NodeUpdateRequest = typeof NodeUpdateRequest.Type
export const NodeUpdateAvailability = Schema.Struct({
  status: Schema.Literals(['current', 'available']),
  version: nonemptyText(128),
  checked_at: Timestamp,
})
export type NodeUpdateAvailability = typeof NodeUpdateAvailability.Type
export const NodeUpdatePending = Schema.Struct({
  operation_id: Schema.NullOr(UUID),
  attempt: Schema.NullOr(PositiveInteger),
})
export const NodeUpdateReport = Schema.Struct({
  operation_id: UUID,
  attempt: PositiveInteger,
  phase: NodeUpdatePhase,
  reason: Schema.optionalKey(Reason),
})

export const NodeUpgradeStateRequest = Schema.Struct({
  type: Schema.Literal('node.upgrade_state'),
  ...NodeUpgradeState.fields,
})
export type NodeUpgradeStateRequest = typeof NodeUpgradeStateRequest.Type

export const NodeUpgradeStateResult = Schema.Struct({
  type: Schema.Literal('node.upgrade_state_result'),
  operation_id: UUID,
  phase: NodeUpgradeState.fields.phase,
  ok: Schema.Boolean,
  code: Schema.optionalKey(Text),
})
export type NodeUpgradeStateResult = typeof NodeUpgradeStateResult.Type

export const RuntimeReport = Schema.Struct({
  upgrade_protocol: Schema.optionalKey(Schema.Literal(1)),
  update_protocol: Schema.optionalKey(Schema.Literal(1)),
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
  upgrade_state: Schema.optionalKey(Schema.NullOr(NodeUpgradeState)),
  update_request: Schema.optionalKey(Schema.NullOr(NodeUpdateRequest)),
  update_management_last_seen: Schema.optionalKey(Timestamp),
  update_availability: Schema.optionalKey(Schema.NullOr(NodeUpdateAvailability)),
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
  credential_state: Schema.optionalKey(Schema.Literals(['active', 'idle_expired', 'revoked'])),
  idle_expires_at: Schema.optionalKey(Timestamp),
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
  telemetry: Schema.optionalKey(Schema.Struct({ forward: Schema.Literal(true) })),
})
export type NodeSyncResult = typeof NodeSyncResult.Type

export const NodesResponse = Schema.Struct({
  nodes: Schema.NullOr(Schema.Array(NodeStatus)),
  default_device: DefaultDevice,
  default_pc: DefaultDevice,
  local_process_notice: Text,
})
export type NodesResponse = typeof NodesResponse.Type

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

export const RegisterNodeInput = Schema.Struct({
  enrollment_token: Text,
  display_name: summary(1024).check(Schema.isBetweenCodePoints(1, 80), Schema.isTrimmed()),
  system: Schema.Literals(['macos', 'linux', 'windows']),
  role: Schema.optionalKey(Text),
  capabilities: Schema.Array(RootID).check(Schema.isMaxLength(32), Schema.isUnique()),
})
export type RegisterNodeInput = typeof RegisterNodeInput.Type

export const ReauthNodeInput = Schema.Struct({
  operation_id: UUID,
  enrollment_token: boundedText(200).check(Schema.isPattern(/^[A-Za-z0-9_-]{20,200}$/)),
  previous_token: boundedText(4096),
})
export type ReauthNodeInput = typeof ReauthNodeInput.Type

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

export const SetDefaultDeviceInput = Schema.Struct({
  node_id: UUID,
})
export type SetDefaultDeviceInput = typeof SetDefaultDeviceInput.Type

export const SetProjectExecInput = Schema.Struct({
  enabled: Schema.Boolean,
})
export type SetProjectExecInput = typeof SetProjectExecInput.Type

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

export const SubscriptionLogoutRequest = Schema.Struct({
  type: Schema.Literal('node.subscription_logout'),
  operation_id: UUID,
  provider: Text,
})
export type SubscriptionLogoutRequest = typeof SubscriptionLogoutRequest.Type
export const SubscriptionLogoutResult = Schema.Struct({
  type: Schema.Literal('node.subscription_logout_result'),
  operation_id: UUID,
  ok: Schema.Boolean,
  code: Schema.optionalKey(Text),
})
export type SubscriptionLogoutResult = typeof SubscriptionLogoutResult.Type

export const UpdateBrowseRootsInput = Schema.Struct({
  path: Text,
})
export type UpdateBrowseRootsInput = typeof UpdateBrowseRootsInput.Type
