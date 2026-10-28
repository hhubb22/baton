import { open } from 'node:fs/promises'

export type DesktopDiagnostics = {
  clientVersion: string
  batondVersion: string
  platform: string
  processState: string
  lastExit: { at: string; reason: string } | null
  upgradePhase: string | null
  canRestart: boolean
}

const REDACTED = '[REDACTED]'
const LOG_LINES = 200
const READ_LIMIT = 256 * 1024
const READ_CHUNK = 16 * 1024
// 整行隐藏凭据和配置，避免只替换字段名后漏出嵌套值。
const privateLine =
  /setup|enroll|register|registration|reauth|credential|token|secret|password|passwd|authorization|cookie|api[-_ ]?key|access[-_ ]?key|private[-_ ]?key|deployment|config|coordinator_url|ca_pem|client[-_ ]?key|bearer\s|basic\s|\bsk-[\w-]+|\beyJ[\w-]+\.[\w-]+/i
const structuredLine = /[{}]|^\s*[[\]"']|^\s*[A-Za-z_][\w.-]*\s*[:=]/
const logRecord = /^(?:\d{4}-\d\d-\d\d[T ]|\[?(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b)/i

function redactUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    // 查询和片段可携带未知名称或百分号编码的凭据，全部省略。
    if (url.search) url.search = '?redacted'
    if (url.hash) url.hash = '#redacted'
    return url.toString()
  } catch {
    return REDACTED
  }
}

/** 配置、结构化内容及其续行按私有内容处理，直到下一条明确的日志记录。 */
export function redactDiagnostics(text: string): string {
  return redact(text, false)
}

function redact(text: string, continuation: boolean): string {
  let privateKey = false
  // oxlint-disable-next-line no-control-regex -- 终端颜色控制不能拆开凭据字段名。
  const plain = text.replace(/\r\n?/g, '\n').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
  return plain
    .split('\n')
    .map((raw) => {
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(raw)) privateKey = true
      if (privateKey) {
        if (/-----END [A-Z ]*PRIVATE KEY-----/.test(raw)) privateKey = false
        return REDACTED
      }
      const line = raw.replace(/[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi, redactUrl)
      // 缩进、孤立的编码串也可能是被截断的配置或私钥片段。
      const sensitive =
        privateLine.test(line) || structuredLine.test(line) || /^\s+\S/.test(line) || /^[\w+/=-]{32,}$/.test(line)
      if (sensitive) continuation = true
      else if (logRecord.test(line)) continuation = false
      if (sensitive || continuation) return REDACTED
      return line
    })
    .join('\n')
}

function lastLines(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.slice(-LOG_LINES).join('\n')
}

export function diagnosticSummary(info: DesktopDiagnostics, log: string): string {
  const safe = (value: string) => redactDiagnostics(value)
  return [
    `Client version: ${safe(info.clientVersion)}`,
    `batond version: ${safe(info.batondVersion)}`,
    `Platform: ${safe(info.platform)}`,
    `Device state: ${safe(info.processState)}`,
    `Recent exit: ${info.lastExit ? safe(info.lastExit.at) : 'none'}`,
    ...(info.lastExit ? [`Exit reason: ${safe(info.lastExit.reason)}`] : []),
    `Upgrade phase: ${info.upgradePhase === null ? 'none' : safe(info.upgradePhase)}`,
    `Can restart: ${info.canRestart ? 'yes' : 'no'}`,
    '',
    'Recent batond log (last 200 lines):',
    // 先脱敏再截行，保留多行私有内容的上下文。
    lastLines(redactDiagnostics(log)) || '(log unavailable)',
  ].join('\n')
}

/** 只读取当前日志尾部，最多 256 KiB；截断处到下一条明确日志之间的内容按私有内容隐藏。 */
export async function readLogTail(path: string): Promise<string> {
  let handle
  try {
    handle = await open(path, 'r')
    const info = await handle.stat()
    // Windows 允许以读方式打开目录，POSIX 会抛 EISDIR；显式拒绝，避免把目录当成空日志。
    if (info.isDirectory())
      throw Object.assign(new Error(`Cannot read a directory as a log: ${path}`), { code: 'EISDIR' })
    const size = info.size
    const chunks: Buffer[] = []
    let position = size
    let bytesRead = 0
    let newlines = 0
    while (position > 0 && bytesRead < READ_LIMIT && newlines <= LOG_LINES) {
      const length = Math.min(READ_CHUNK, position, READ_LIMIT - bytesRead)
      position -= length
      const buffer = Buffer.alloc(length)
      const result = await handle.read({ buffer, offset: 0, length, position })
      const chunk = buffer.subarray(0, result.bytesRead)
      chunks.unshift(chunk)
      bytesRead += length
      for (const byte of chunk) if (byte === 10) newlines++
    }
    let tail = Buffer.concat(chunks).toString('utf8')
    if (position > 0) {
      const firstNewline = tail.indexOf('\n')
      tail = firstNewline < 0 ? '' : tail.slice(firstNewline + 1)
    }
    return tail ? lastLines(redact(tail, position > 0)) : ''
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return ''
    throw error
  } finally {
    await handle?.close()
  }
}
