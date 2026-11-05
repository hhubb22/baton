import { BUILD } from '@baton/protocol/release.mjs'

export type LogLevel = 'info' | 'warn' | 'error'
export type LogFields = Readonly<Record<string, unknown>>
export type LogWriter = (line: string) => void

export interface Logger {
  readonly info: (event: string, fields?: LogFields) => void
  readonly warn: (event: string, fields?: LogFields) => void
  readonly error: (event: string, fields?: LogFields) => void
}

export interface LoggerOptions {
  readonly version?: string
  readonly commit?: string
  readonly pid?: number
  readonly now?: () => Date
  readonly write?: LogWriter
}

const MAX_STRING = 2048
const MAX_ARRAY = 50
const MAX_DEPTH = 4
const REDACTED = '[redacted]'
// 这些键可能是整段提示词、响应正文、凭据或运行记录；结构日志只保留标识与计数。
const sensitiveKey =
  /(?:^|_)(?:password|passwd|secret|token|authorization|cookie|credential|api_key|private_key|device_code|content|prompt|message|messages|body|text|transcript)(?:_|$)/i
const credential =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+|\b(?:sk-(?:proj-)?|crsr_)[A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\b(?:api[_ -]?key|token|password|authorization)\s*[:=]\s*\S+)/i
const sensitive = (key: string) => !/_id$/i.test(key) && sensitiveKey.test(key)

const safeString = (value: string): string => {
  if (credential.test(value)) return REDACTED
  return value.length <= MAX_STRING ? value : `${value.slice(0, MAX_STRING)}…`
}

const errorFields = (error: Error): LogFields => {
  const code = (error as { code?: unknown }).code
  const tag = (error as { _tag?: unknown })._tag
  return {
    error_type: error.name,
    ...(typeof code === 'string' ? { error_code: code } : {}),
    ...(typeof tag === 'string' ? { error_tag: tag } : {}),
  }
}

function safeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'string') return safeString(value)
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (errorFieldsLike(value)) return errorFields(value as Error)
  if (depth >= MAX_DEPTH) return '[truncated]'
  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) return '[truncated]'
    seen.add(value)
    try {
      if (Array.isArray(value))
        return value.slice(0, MAX_ARRAY).map((item) => (item === undefined ? null : safeValue(item, depth + 1, seen)))
      const result: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (item === undefined || sensitive(key)) continue
        result[key] = safeValue(item, depth + 1, seen)
      }
      return result
    } finally {
      seen.delete(value)
    }
  }
  return undefined
}

const errorFieldsLike = (value: unknown): value is Error =>
  value instanceof Error ||
  (typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string' &&
    typeof (value as { message?: unknown }).message === 'string')

function safeFields(fields: LogFields | undefined): Record<string, unknown> {
  if (!fields) return {}
  const result: Record<string, unknown> = {}
  const seen = new WeakSet<object>()
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || sensitive(key)) continue
    const safe = safeValue(value, 0, seen)
    if (safe !== undefined) result[key] = safe
  }
  return result
}

export function createLogger(service: string, options: LoggerOptions = {}): Logger {
  const base = {
    service,
    version: options.version ?? BUILD.version,
    commit: options.commit ?? BUILD.commit,
    pid: options.pid ?? process.pid,
  }
  const now = options.now ?? (() => new Date())
  const write = options.write ?? ((line: string) => process.stderr.write(line + '\n'))
  const log = (level: LogLevel, event: string, fields?: LogFields) => {
    const line = JSON.stringify({
      ...safeFields(fields),
      time: now().toISOString(),
      level,
      ...base,
      event,
    })
    write(line)
  }
  return {
    info: (event, fields) => log('info', event, fields),
    warn: (event, fields) => log('warn', event, fields),
    error: (event, fields) => log('error', event, fields),
  }
}

export const describeError = (error: unknown): LogFields =>
  errorFieldsLike(error)
    ? errorFields(error)
    : { error_type: typeof error === 'string' ? 'Error' : typeof error, ...(error ? { error_tag: 'unknown' } : {}) }
