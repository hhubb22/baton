import { Schema } from 'effect'

const encoder = new TextEncoder()

export const utf8Bytes = (value: string): number => encoder.encode(value).length

export const byteLimit = (maximum: number) =>
  Schema.makeFilter<string>((value) => utf8Bytes(value) <= maximum || `UTF-8 正文超过 ${maximum} 字节`)

export const jsonBytes = (value: unknown, indent?: number, escapeHTML = false): number => {
  let encoded = JSON.stringify(value, null, indent)
  if (escapeHTML) {
    encoded = encoded.replace(
      /[<>&\u2028\u2029]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    )
  }
  return utf8Bytes(encoded)
}

export const jsonLimit = (maximum: number, indent?: number, escapeHTML = false) =>
  Schema.makeFilter<unknown>((value) => jsonBytes(value, indent, escapeHTML) <= maximum || `JSON 超过 ${maximum} 字节`)

export const Text = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      !value.includes('\0') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value),
  ),
)

export const boundedText = (maximum: number) => Text.check(byteLimit(maximum))
export const summary = (maximum: number) =>
  boundedText(maximum).check(Schema.makeFilter((value) => !/\p{Cc}/u.test(value)))
export const nonemptyText = (maximum: number) => summary(maximum).check(Schema.isMinLength(1))

export const UUID = Schema.String.check(Schema.isGUID())
// 时间保留 RFC 3339 原文，避免 Date 丢失纳秒精度。
export const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/),
  Schema.makeFilter((value) => Number.isFinite(Date.parse(value))),
)
export const Integer = Schema.Int.check(Schema.makeFilter((value) => Number.isSafeInteger(value)))
export const NonNegativeInteger = Integer.check(Schema.isGreaterThanOrEqualTo(0))
export const PositiveInteger = Integer.check(Schema.isGreaterThan(0))
export const ExecutionTimeoutSeconds = PositiveInteger.check(Schema.isLessThanOrEqualTo(2147483647))
export const RuntimeName = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/))
export const RootID = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9._-]{0,63}$/))
export const ClientMessageID = nonemptyText(256)
export const ProjectClientMessageID = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,128}$/))
export const StorageGeneration = nonemptyText(256)
export const AgentType = Schema.Literals(['pi', 'codex', 'kiro', 'cursor', 'grok', 'antigravity', 'shell'])
export const AgentStatus = Schema.Literals(['available', 'unverified', 'unavailable'])
export const CommandOutcome = Schema.Literals(['succeeded', 'failed', 'cancelled', 'unknown'])
export const MessageMode = Schema.Literals(['queue', 'steer'])
export const ThreadStatus = Schema.Literals(['waiting_device', 'running', 'idle', 'stopped', 'unknown', 'archived'])
export const Cursor = boundedText(100)
export const Reason = summary(1024).check(
  Schema.makeFilter(
    (value) =>
      !/(?:\bBearer\s+\S+|\b(?:sk-(?:proj-)?|crsr_)[A-Za-z0-9_-]{12,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\b(?:api[_ -]?key|token|password|authorization)\s*[:=]\s*\S+)/i.test(
        value,
      ) || '原因摘要包含凭据格式',
  ),
)
export const MessageContent = boundedText(64 * 1024).check(Schema.makeFilter((value) => value.trim().length > 0))
export const uniqueBy = <T>(key: (value: T) => string) =>
  Schema.makeFilter<ReadonlyArray<T> | null>(
    (items) => items === null || new Set(items.map(key)).size === items.length || '标识重复',
  )

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

export const OKResponse = Schema.Struct({
  ok: Schema.Boolean,
})
export type OKResponse = typeof OKResponse.Type

export const Diagnostics = Schema.Struct({
  nodes: NonNegativeInteger,
  browsers: NonNegativeInteger,
  pending_rpc: NonNegativeInteger,
  connections: NonNegativeInteger,
  pending_disconnects: NonNegativeInteger,
  received_bytes: NonNegativeInteger,
  sent_bytes: NonNegativeInteger,
  queued_control_messages: NonNegativeInteger,
  queued_control_bytes: NonNegativeInteger,
  thread_statuses: Schema.Array(Schema.Struct({ status: ThreadStatus, count: NonNegativeInteger })),
})
export type Diagnostics = typeof Diagnostics.Type

export type AgentType = typeof AgentType.Type
export type AgentStatus = typeof AgentStatus.Type
export type CommandOutcome = typeof CommandOutcome.Type
