import { Schema } from 'effect'
import {
  ClientMessageID,
  ExecutionTimeoutSeconds,
  Integer,
  NonNegativeInteger,
  PositiveInteger,
  StorageGeneration,
  Timestamp,
  UUID,
  boundedText,
  jsonLimit,
} from './common.ts'
import { FullOutputPage, FullOutputReference } from './full-output.ts'

export const ExecutionStatus = Schema.Literals([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'unknown',
])
export type ExecutionStatus = typeof ExecutionStatus.Type

const result = {
  exit_code: Schema.optionalKey(Integer),
  reason: Schema.optionalKey(boundedText(4096)),
  output: Schema.optionalKey(boundedText(64 * 1024)),
  encoding: Schema.optionalKey(Schema.Literal('base64')),
  total_bytes: Schema.optionalKey(NonNegativeInteger),
  truncated: Schema.optionalKey(Schema.Boolean),
  full_output: Schema.optionalKey(FullOutputReference),
  started_at: Schema.optionalKey(Timestamp),
  finished_at: Schema.optionalKey(Timestamp),
}

export const Execution = Schema.Struct({
  id: UUID,
  employee_id: UUID,
  project_id: UUID,
  node_id: UUID,
  origin_conversation_id: UUID,
  origin_tool_call_id: ClientMessageID,
  command: boundedText(64 * 1024),
  working_directory: boundedText(4096),
  timeout_seconds: ExecutionTimeoutSeconds,
  status: ExecutionStatus,
  storage_generation: StorageGeneration,
  last_report_seq: NonNegativeInteger,
  version: NonNegativeInteger,
  created_at: Timestamp,
  stop_requested_at: Schema.optionalKey(Timestamp),
  ...result,
}).check(jsonLimit(128 * 1024))
export type Execution = typeof Execution.Type
export const ExecutionPage = Schema.Struct({
  executions: Schema.Array(Execution),
  next_cursor: Schema.optionalKey(Schema.String),
})
export type ExecutionPage = typeof ExecutionPage.Type

export const ExecutionCommand = Schema.Struct({
  type: Schema.Literal('execution.command'),
  execution_id: UUID,
  action: Schema.Literals(['start', 'stop']),
  storage_generation: StorageGeneration,
  project_id: Schema.optionalKey(UUID),
  command: Schema.optionalKey(boundedText(64 * 1024)),
  working_directory: Schema.optionalKey(boundedText(4096)),
  timeout_seconds: Schema.optionalKey(ExecutionTimeoutSeconds),
})
export type ExecutionCommand = typeof ExecutionCommand.Type
export const ExecutionCommandResult = Schema.Struct({
  type: Schema.Literal('execution.command_result'),
  execution_id: UUID,
  storage_generation: StorageGeneration,
  ok: Schema.Boolean,
  code: Schema.optionalKey(boundedText(256)),
  reason: Schema.optionalKey(boundedText(4096)),
})
export type ExecutionCommandResult = typeof ExecutionCommandResult.Type
export const ExecutionReport = Schema.Struct({
  type: Schema.Literal('execution.report'),
  execution_id: UUID,
  event_id: UUID,
  seq: PositiveInteger,
  storage_generation: StorageGeneration,
  status: ExecutionStatus,
  ...result,
}).check(jsonLimit(128 * 1024))
export type ExecutionReport = typeof ExecutionReport.Type
export const ExecutionReportResult = Schema.Struct({
  type: Schema.Literal('execution.report_result'),
  execution_id: UUID,
  event_id: UUID,
  seq: PositiveInteger,
  ok: Schema.Boolean,
})
export type ExecutionReportResult = typeof ExecutionReportResult.Type
export const ExecutionOutputRequest = Schema.Struct({
  type: Schema.Literal('execution.output_request'),
  operation_id: UUID,
  execution_id: UUID,
  output_id: UUID,
  storage_generation: StorageGeneration,
  offset: Schema.optionalKey(NonNegativeInteger),
})
export type ExecutionOutputRequest = typeof ExecutionOutputRequest.Type
export const ExecutionOutputResult = Schema.Struct({
  type: Schema.Literal('execution.output_result'),
  operation_id: UUID,
  execution_id: UUID,
  ok: Schema.Boolean,
  code: Schema.optionalKey(boundedText(256)),
  reason: Schema.optionalKey(boundedText(4096)),
  full_output: Schema.optionalKey(FullOutputPage),
})
export type ExecutionOutputResult = typeof ExecutionOutputResult.Type
