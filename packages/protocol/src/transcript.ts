import { Schema } from 'effect'
import { NonNegativeInteger, Text, Timestamp, UUID, jsonLimit } from './common.ts'

const redacted = '[REDACTED]'
const sensitiveKey =
  /^(authorization|cookie|csrf|csrf_token|device_code|access|access_token|refresh|refresh_token|id_token|password|new_password|current_password|secret|api_key|token|private_key|node_signing_key|client_secret)$/i
const sensitiveFragment =
  /(api[_-]?key|private[_-]?key|secret|password|access[_-]?token|refresh[_-]?token|device[_-]?code)/i
const secretPatterns = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:sk|ak|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
]

/** 运行记录只保留业务内容；键名与实际密钥值同时过滤，避免任意深度的嵌套载荷泄露凭据。 */
export const redactTranscript = (value: unknown, secrets: ReadonlyArray<string> = [], depth = 0): unknown => {
  if (depth > 32) return redacted
  if (typeof value === 'string') {
    let result = value
    for (const secret of secrets)
      if (secret.length >= 8 && result.includes(secret)) result = result.split(secret).join(redacted)
    for (const pattern of secretPatterns) result = result.replace(pattern, redacted)
    return result
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map((entry) => redactTranscript(entry, secrets, depth + 1))
  if (typeof value === 'bigint' || typeof value === 'symbol') return value.toString()
  if (typeof value !== 'object') return null
  const output: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    output[key] =
      sensitiveKey.test(key) || sensitiveFragment.test(key) ? redacted : redactTranscript(entry, secrets, depth + 1)
  }
  return output
}

/** 一行完整的运行记录。写入端在每条事件发生时立即追加。 */
export const TranscriptLine = Schema.Struct({
  seq: NonNegativeInteger.check(Schema.isGreaterThan(0)),
  ts: Timestamp,
  version: Text,
  commit: Text,
  kind: Text,
  data: Schema.Json,
})
export type TranscriptLine = typeof TranscriptLine.Type

/** 按字节分页的 JSONL 读取结果；data 为原始字节的 base64 编码。 */
export const TranscriptPage = Schema.Struct({
  offset: NonNegativeInteger,
  next_offset: NonNegativeInteger,
  total_bytes: NonNegativeInteger,
  expires_at: Timestamp,
  encoding: Schema.Literal('base64'),
  data: Schema.String.check(Schema.isMaxLength(128 * 1024)),
  done: Schema.Boolean,
  incomplete_tail: Schema.Boolean,
}).check(jsonLimit(160 * 1024))
export type TranscriptPage = typeof TranscriptPage.Type

export const ProjectRunSummary = Schema.Struct({
  run_id: UUID,
  node_id: UUID,
  kind: Schema.Literals(['foreground', 'memory']),
  memory_job_id: Schema.NullOr(UUID),
  memory_kind: Schema.NullOr(Text),
  state: Text,
  provider: Text,
  model: Text,
  started_at: Timestamp,
  ended_at: Schema.NullOr(Timestamp),
  error_code: Schema.NullOr(Text),
})
export type ProjectRunSummary = typeof ProjectRunSummary.Type

export const ProjectRunsResponse = Schema.Struct({
  runs: Schema.Array(ProjectRunSummary),
})
export type ProjectRunsResponse = typeof ProjectRunsResponse.Type

const queryInteger = (minimum: number, maximum: number) =>
  Schema.String.check(
    Schema.isPattern(/^\d+$/),
    Schema.makeFilter(
      (value) => Number.isSafeInteger(Number(value)) && Number(value) >= minimum && Number(value) <= maximum,
    ),
  )

export const ProjectRunsQuery = Schema.Struct({
  limit: Schema.optionalKey(queryInteger(1, 100)),
})
export type ProjectRunsQuery = typeof ProjectRunsQuery.Type

export const ProjectRunTranscriptQuery = Schema.Struct({
  offset: Schema.optionalKey(queryInteger(0, Number.MAX_SAFE_INTEGER)),
})
export type ProjectRunTranscriptQuery = typeof ProjectRunTranscriptQuery.Type

/** 中心向设备请求一段 Project Run 记录。 */
export const ProjectRunTranscriptRequest = Schema.Struct({
  type: Schema.Literal('project_run_transcript'),
  operation_id: UUID,
  project_id: UUID,
  run_id: UUID,
  offset: Schema.optionalKey(NonNegativeInteger),
})
export type ProjectRunTranscriptRequest = typeof ProjectRunTranscriptRequest.Type

export const ProjectRunTranscriptResult = Schema.Struct({
  type: Schema.Literal('project_run_transcript_result'),
  operation_id: UUID,
  ok: Schema.Boolean,
  code: Schema.optionalKey(Text),
  transcript: Schema.optionalKey(TranscriptPage),
})
export type ProjectRunTranscriptResult = typeof ProjectRunTranscriptResult.Type
