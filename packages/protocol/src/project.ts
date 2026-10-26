import { Schema } from 'effect'
import {
  UUID,
  Timestamp,
  Integer,
  NonNegativeInteger,
  ProjectClientMessageID,
  Text,
  MessageContent,
  boundedText,
  summary,
  jsonLimit,
} from './common.ts'

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

export * from './project-memory.ts'

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
