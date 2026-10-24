import { Schema } from 'effect'
import { TraceContext } from './trace.ts'
import {
  AgentType,
  ClientMessageID,
  CommandOutcome,
  Integer,
  PositiveInteger,
  StorageGeneration,
  UUID,
  boundedText,
  jsonLimit,
  summary,
} from './common.ts'
import { SessionRequest, SessionResult, ThreadReport } from './dto.ts'

export const WorkerCommandAction = Schema.Literals(['open', 'message', 'withdraw', 'resume', 'stop'])
export const WorkerCommandState = Schema.Literals([
  'accepted',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'unknown',
])

// receipt 是持久接收事实，重复查询不改变它；state 和 command_outcome 单独返回。
export const WorkerCommandReceipt = Schema.Struct({
  command_id: UUID,
  thread_id: UUID,
  storage_generation: StorageGeneration,
  action: WorkerCommandAction,
})
export type WorkerCommandReceipt = typeof WorkerCommandReceipt.Type
export const WorkerCommandStatus = Schema.Struct({
  command_id: UUID,
  state: WorkerCommandState,
  command_outcome: Schema.optionalKey(CommandOutcome),
  reason: Schema.optionalKey(boundedText(4096)),
}).check(
  Schema.makeFilter((value) =>
    value.state === 'accepted' || value.state === 'running'
      ? value.command_outcome === undefined || '执行完成前不能返回终态结果'
      : value.command_outcome === value.state || '命令状态与终态结果不符',
  ),
)
export type WorkerCommandStatus = typeof WorkerCommandStatus.Type

export const WorkerAdapterConfig = Schema.Struct({
  home: Schema.optionalKey(boundedText(4096)),
  binary: Schema.optionalKey(boundedText(4096)),
  model: Schema.optionalKey(summary(512)),
  state_path: Schema.optionalKey(boundedText(4096)),
  session_dir: Schema.optionalKey(boundedText(4096)),
})
export const WorkerOpenConfig = Schema.Struct({
  project_id: Schema.optionalKey(UUID),
  origin_conversation_id: Schema.optionalKey(UUID),
  origin_tool_call_id: Schema.optionalKey(ClientMessageID),
  thread_id: UUID,
  node_id: UUID,
  storage_generation: StorageGeneration,
  agent_type: AgentType,
  model: Schema.optionalKey(summary(512)),
  working_directory: boundedText(4096).check(Schema.isMinLength(1)),
  execution_timeout_seconds: PositiveInteger,
  adapter_config: WorkerAdapterConfig,
})
export type WorkerOpenConfig = typeof WorkerOpenConfig.Type

// internal/session/wire.go · ipcMessage，加上适配器规格的异步命令契约。
export const WorkerIPCMessage = Schema.Struct({
  trace_context: Schema.optionalKey(TraceContext),
  client_message_id: Schema.optionalKey(ClientMessageID),
  mode: Schema.optionalKey(Schema.Literals(['queue', 'steer'])),
  model: Schema.optionalKey(summary(512)),
  after_worker_seq: Schema.optionalKey(Integer),
  worker_seq: Schema.optionalKey(Integer),
  thread_reports: Schema.optionalKey(Schema.NullOr(Schema.Array(ThreadReport))),
  session_request: Schema.optionalKey(Schema.NullOr(SessionRequest)),
  session_result: Schema.optionalKey(Schema.NullOr(SessionResult)),
  stop_reason: Schema.optionalKey(boundedText(4096)),
  type: Schema.Literals([
    'auth',
    'result',
    'status',
    'thread_open',
    'thread_message',
    'thread_withdraw',
    'thread_resume',
    'thread_stop',
    'thread_pending',
    'thread_ack',
    'session_request',
    'native_history',
    'thread_command_status',
  ]),
  token: Schema.optionalKey(Schema.String),
  ok: Schema.Boolean,
  code: Schema.optionalKey(summary(128)),
  message: Schema.optionalKey(boundedText(4096)),
  pid: Schema.optionalKey(Integer),
  session_id: Schema.optionalKey(UUID),
  payload: Schema.optionalKey(boundedText(64 * 1024)),
  event_id: Schema.optionalKey(UUID),
  command_id: Schema.optionalKey(UUID),
  thread_id: Schema.optionalKey(UUID),
  storage_generation: Schema.optionalKey(StorageGeneration),
  worker_ready: Schema.optionalKey(Schema.Boolean),
  agent_ready: Schema.optionalKey(Schema.Boolean),
  receipt: Schema.optionalKey(WorkerCommandReceipt),
  command_status: Schema.optionalKey(WorkerCommandStatus),
  open_config: Schema.optionalKey(WorkerOpenConfig),
}).check(
  jsonLimit(256 * 1024),
  Schema.makeFilter((value) => !value.agent_ready || value.worker_ready === true || 'Agent 就绪前 Worker 必须就绪'),
)
export type WorkerIPCMessage = typeof WorkerIPCMessage.Type

// 这里只追加或收窄字段；保留父结构的容量与就绪关系检查。
const preserveChecks = { unsafePreserveChecks: true } as const

export const WorkerAuth = WorkerIPCMessage.mapFields(
  (fields) => ({
    ...fields,
    type: Schema.Literal('auth'),
    token: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  }),
  preserveChecks,
)
export const WorkerResult = WorkerIPCMessage.mapFields(
  (fields) => ({ ...fields, type: Schema.Literal('result') }),
  preserveChecks,
)
export type WorkerResult = typeof WorkerResult.Type
export const WorkerStatusResult = WorkerResult.mapFields(
  (fields) => ({ ...fields, worker_ready: Schema.Boolean, agent_ready: Schema.Boolean }),
  preserveChecks,
)
export type WorkerStatusResult = typeof WorkerStatusResult.Type
export const WorkerCommandResult = WorkerResult.mapFields(
  (fields) => ({
    ...fields,
    ok: Schema.Literal(true),
    receipt: WorkerCommandReceipt,
    command_status: WorkerCommandStatus,
  }),
  preserveChecks,
).check(
  Schema.makeFilter(
    (value) =>
      (value.receipt.command_id === value.command_status.command_id &&
        (value.session_id === undefined || value.session_id === value.receipt.thread_id) &&
        (value.storage_generation === undefined || value.storage_generation === value.receipt.storage_generation)) ||
      '命令回执身份不符',
  ),
)
export type WorkerCommandResult = typeof WorkerCommandResult.Type

const executionIdentity = { command_id: UUID, thread_id: UUID, storage_generation: StorageGeneration }
export const WorkerStatus = WorkerIPCMessage.mapFields(
  (fields) => ({ ...fields, type: Schema.Literal('status') }),
  preserveChecks,
)
export const WorkerOpen = WorkerIPCMessage.mapFields(
  (fields) => ({ ...fields, ...executionIdentity, type: Schema.Literal('thread_open'), open_config: WorkerOpenConfig }),
  preserveChecks,
).check(
  Schema.makeFilter(
    (value) =>
      (value.open_config.thread_id === value.thread_id &&
        value.open_config.storage_generation === value.storage_generation) ||
      'open 配置身份不符',
  ),
)
export const WorkerMessage = WorkerIPCMessage.mapFields(
  (fields) => ({
    ...fields,
    ...executionIdentity,
    type: Schema.Literal('thread_message'),
    client_message_id: ClientMessageID,
    payload: boundedText(64 * 1024).check(Schema.isMinLength(1)),
  }),
  preserveChecks,
)
export const WorkerWithdraw = WorkerIPCMessage.mapFields(
  (fields) => ({
    ...fields,
    ...executionIdentity,
    type: Schema.Literal('thread_withdraw'),
    client_message_id: ClientMessageID,
  }),
  preserveChecks,
)
export const WorkerResume = WorkerIPCMessage.mapFields(
  (fields) => ({ ...fields, ...executionIdentity, type: Schema.Literal('thread_resume') }),
  preserveChecks,
)
export const WorkerStop = WorkerIPCMessage.mapFields(
  (fields) => ({ ...fields, ...executionIdentity, type: Schema.Literal('thread_stop') }),
  preserveChecks,
)
export const WorkerCommandStatusQuery = WorkerIPCMessage.mapFields(
  (fields) => ({ ...fields, ...executionIdentity, type: Schema.Literal('thread_command_status') }),
  preserveChecks,
)
export const WorkerPending = WorkerIPCMessage.mapFields(
  (fields) => ({ ...fields, type: Schema.Literal('thread_pending') }),
  preserveChecks,
)
export const WorkerAck = WorkerIPCMessage.mapFields(
  (fields) => ({ ...fields, type: Schema.Literal('thread_ack'), event_id: UUID, worker_seq: PositiveInteger }),
  preserveChecks,
)
export const WorkerSessionRequest = WorkerIPCMessage.mapFields(
  (fields) => ({ ...fields, type: Schema.Literal('session_request'), session_request: SessionRequest }),
  preserveChecks,
)
export const WorkerNativeHistory = WorkerIPCMessage.mapFields(
  (fields) => ({ ...fields, type: Schema.Literal('native_history') }),
  preserveChecks,
)
export const WorkerRequest = Schema.Union([
  WorkerAuth,
  WorkerStatus,
  WorkerOpen,
  WorkerMessage,
  WorkerWithdraw,
  WorkerResume,
  WorkerStop,
  WorkerCommandStatusQuery,
  WorkerPending,
  WorkerAck,
  WorkerSessionRequest,
  WorkerNativeHistory,
]).check(jsonLimit(256 * 1024))
export type WorkerRequest = typeof WorkerRequest.Type
export type WorkerCommandAction = typeof WorkerCommandAction.Type
export type WorkerCommandState = typeof WorkerCommandState.Type
export type WorkerAdapterConfig = typeof WorkerAdapterConfig.Type
export type WorkerAuth = typeof WorkerAuth.Type
export type WorkerStatus = typeof WorkerStatus.Type
export type WorkerOpen = typeof WorkerOpen.Type
export type WorkerMessage = typeof WorkerMessage.Type
export type WorkerWithdraw = typeof WorkerWithdraw.Type
export type WorkerResume = typeof WorkerResume.Type
export type WorkerStop = typeof WorkerStop.Type
export type WorkerCommandStatusQuery = typeof WorkerCommandStatusQuery.Type
export type WorkerPending = typeof WorkerPending.Type
export type WorkerAck = typeof WorkerAck.Type
export type WorkerSessionRequest = typeof WorkerSessionRequest.Type
export type WorkerNativeHistory = typeof WorkerNativeHistory.Type
