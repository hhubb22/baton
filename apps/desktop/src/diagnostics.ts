export type DesktopDiagnostics = {
  clientVersion: string
  batondVersion: string
  platform: string
  processState: string
  deviceId?: string
  lastExit: { at: string; reason: string; code?: string } | null
  canRestart: boolean
}

const REDACTED = '[REDACTED]'
// 整行隐藏凭据和配置，避免只替换字段名后漏出嵌套值。
const privateLine =
  /setup|enroll|register|registration|credential|token|secret|password|passwd|authorization|cookie|api[-_ ]?key|access[-_ ]?key|private[-_ ]?key|deployment|config|coordinator_url|ca_pem|client[-_ ]?key|bearer\s|basic\s|\bsk-[\w-]+|\beyJ[\w-]+\.[\w-]+/i
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

/** 复制摘要只包含标识、版本和错误码，不复制日志或业务正文。 */
export function diagnosticSummary(info: DesktopDiagnostics): string {
  const safe = (value: string) => redactDiagnostics(value)
  return [
    `时间： ${new Date().toISOString()}`,
    `客户端版本： ${safe(info.clientVersion)}`,
    `服务端版本： ${safe(info.batondVersion)}`,
    ...(info.deviceId
      ? [
          `设备 ID： ${
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(info.deviceId)
              ? info.deviceId
              : safe(info.deviceId)
          }`,
        ]
      : []),
    ...(info.lastExit?.code ? [`错误码： ${safe(info.lastExit.code)}`] : []),
  ].join('\n')
}
