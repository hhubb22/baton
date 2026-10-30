import { Schema } from 'effect'
import { ExecutionCommand, ExecutionCommandResult, ExecutionReport, ExecutionReportResult } from '@baton/protocol'

export const ExecutionRequest = Schema.Union([
  ExecutionCommand,
  ExecutionReportResult,
  Schema.Struct({ type: Schema.Literal('execution.poll') }),
  Schema.Struct({ type: Schema.Literal('execution.recover') }),
])
export type ExecutionRequest = typeof ExecutionRequest.Type
export const ExecutionResponse = Schema.Struct({
  type: Schema.Literal('execution.response'),
  result: Schema.optionalKey(ExecutionCommandResult),
  reports: Schema.optionalKey(Schema.Array(ExecutionReport)),
})
export type ExecutionResponse = typeof ExecutionResponse.Type
export const decodeRequest = Schema.decodeUnknownSync(ExecutionRequest)
export const decodeResponse = Schema.decodeUnknownSync(ExecutionResponse)
