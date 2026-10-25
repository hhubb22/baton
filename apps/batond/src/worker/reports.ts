import type { ThreadReport, WorkerIPCMessage } from '@baton/protocol'
import type { OutboxEntry } from './ledger.ts'

const reportBudget = 120 * 1024
const replyHalfBudget = 16 * 1024
const responseBudget = 240 * 1024
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
const prefix = (text: string, length: number) => {
  const end = length > 0 && /[\uD800-\uDBFF]/u.test(text[length - 1]!) ? length - 1 : length
  return text.slice(0, end)
}
const suffix = (text: string, length: number) => {
  const offset = text.length - length
  const start = offset < text.length && /[\uDC00-\uDFFF]/u.test(text[offset]!) ? offset + 1 : offset
  return text.slice(start)
}
const ends = (text: string, length: number) =>
  prefix(text, Math.ceil(length / 2)) + suffix(text, Math.floor(length / 2))
const fit = (text: string, withinBudget: (value: string) => boolean, select = prefix) => {
  if (withinBudget(text)) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (withinBudget(select(text, middle))) low = middle
    else high = middle - 1
  }
  return select(text, low)
}

export const displayText = (text: string) => text.toWellFormed().replaceAll('\0', '�')

export const boundReason = (reason: string) => fit(reason, (value) => Buffer.byteLength(value) <= 4096)

/** Report identity and sequence stay stable when text is shortened for IPC delivery. */
export const boundReport = (report: ThreadReport): ThreadReport => {
  const bounded = {
    ...report,
    ...(report.reason === undefined ? {} : { reason: boundReason(report.reason) }),
  }
  if (bounded.content === undefined) return bounded
  const original = bounded.content
  const contentBytes = Buffer.byteLength(original)
  const isReply = bounded.kind === 'reply'
  const shellBase64 =
    isReply && bounded.metadata?.encoding === 'base64' && typeof bounded.metadata.exit_code === 'number'
  const contentBudget = shellBase64 ? 4 * Math.ceil((2 * replyHalfBudget) / 3) : 2 * replyHalfBudget
  if (bytes(bounded) <= reportBudget && (!isReply || contentBytes <= contentBudget)) return bounded
  const originalBytes = bounded.original_bytes ?? contentBytes
  const base = { ...bounded, truncated: true, original_bytes: originalBytes }
  const content =
    isReply && contentBytes > 2 * replyHalfBudget
      ? fit(original, (value) => Buffer.byteLength(value) <= replyHalfBudget) +
        fit(original, (value) => Buffer.byteLength(value) <= replyHalfBudget, suffix)
      : original
  return {
    ...base,
    content: fit(content, (value) => bytes({ ...base, content: value }) <= reportBudget, isReply ? ends : prefix),
  }
}

export const pendingResult = (outbox: readonly OutboxEntry[], after: number): WorkerIPCMessage => {
  const reports: ThreadReport[] = []
  for (const entry of outbox) {
    if (entry.acked || entry.report.worker_seq <= after) continue
    const report = boundReport(entry.report)
    const candidate = { type: 'result', ok: true, thread_reports: [...reports, report] }
    if (reports.length >= 64 || bytes(candidate) > responseBudget) break
    reports.push(report)
  }
  return { type: 'result', ok: true, thread_reports: reports }
}
