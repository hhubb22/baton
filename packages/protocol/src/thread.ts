import { Schema } from 'effect'
import { TraceContext } from './trace.ts'
import { FullOutputPage } from './full-output.ts'
import { ThreadQuestion, ThreadAnswerInput, ThreadQuestionAnswer } from './thread-question.ts'
import {
  AgentType,
  CommandOutcome,
  MessageMode,
  ThreadStatus,
  Cursor,
  UUID,
  Timestamp,
  Integer,
  NonNegativeInteger,
  PositiveInteger,
  ExecutionTimeoutSeconds,
  ClientMessageID,
  StorageGeneration,
  Text,
  boundedText,
  summary,
  nonemptyText,
  jsonLimit,
} from './common.ts'

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

export const SetThreadSettingsInput = Schema.Struct({
  execution_timeout_seconds: ExecutionTimeoutSeconds,
})
export type SetThreadSettingsInput = typeof SetThreadSettingsInput.Type

export const SetThreadModelInput = Schema.Struct({
  model: summary(512),
})
export type SetThreadModelInput = typeof SetThreadModelInput.Type

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

export const ThreadSummary = Thread.mapFields(
  (fields) => ({
    ...fields,
    title: Text,
    stop_canceled: NonNegativeInteger,
    current_turn: Schema.NullOr(ThreadTurn),
  }),
  { unsafePreserveChecks: true },
)
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

export const ThreadView = Thread.mapFields(
  (fields) => ({
    ...fields,
    question_answers: Schema.Array(ThreadQuestionAnswer),
    pending_questions: Schema.Array(Schema.Struct({ ...ThreadQuestion.fields, worker_turn_seq: PositiveInteger })),
    resume_pending: Schema.Boolean,
    retry_open_allowed: Schema.optionalKey(Schema.Boolean),
    current_turn: Schema.NullOr(ThreadTurn),
    pending_messages: Schema.NullOr(Schema.Array(ThreadMessage)),
    failed_messages: Schema.NullOr(Schema.Array(ThreadMessage)),
  }),
  { unsafePreserveChecks: true },
)
export type ThreadView = typeof ThreadView.Type
