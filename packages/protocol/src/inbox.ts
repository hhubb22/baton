import { Schema } from 'effect'
import {
  UUID,
  Timestamp,
  Integer,
  NonNegativeInteger,
  PositiveInteger,
  Text,
  boundedText,
  jsonLimit,
  uniqueBy,
} from './common.ts'

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
