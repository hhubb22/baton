import { createHash } from 'node:crypto'
import type { ThreadReport } from '@baton/protocol'
import type { JsonValue } from './agent.ts'
import { displayText } from './reports.ts'

export const itemDataBudget = 192 * 1024
const itemReportBudget = 224 * 1024
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))

export const itemId = (id: string) =>
  Buffer.byteLength(id) > 512 || displayText(id) !== id || id.startsWith('baton:item:sha256:')
    ? `baton:item:sha256:${createHash('sha256').update(JSON.stringify(id)).digest('hex')}`
    : id

/** JSON escaping and multibyte characters count toward the budget. */
export const shortenLongest = (value: JsonValue): JsonValue => {
  let longest = ''
  let longestBytes = 0
  let selected: readonly (string | number)[] = []
  const visit = (entry: JsonValue, path: readonly (string | number)[]): void => {
    if (typeof entry === 'string') {
      const size = bytes(entry)
      if (entry.length && size > longestBytes) {
        longest = entry
        longestBytes = size
        selected = path
      }
    } else if (Array.isArray(entry)) entry.forEach((child, index) => visit(child, [...path, index]))
    else if (entry !== null && typeof entry === 'object')
      Object.entries(entry).forEach(([key, child]) => visit(child, [...path, key]))
  }
  visit(value, [])
  // A large array or object can exceed the budget even with all string values removed.
  if (!longest.length) return null
  const keep = Math.floor(longest.length / 2)
  let head = Math.ceil(keep / 2)
  let tail = longest.length - Math.floor(keep / 2)
  if (head > 0 && /[\uD800-\uDBFF]/u.test(longest[head - 1]!)) head--
  if (tail < longest.length && /[\uDC00-\uDFFF]/u.test(longest[tail]!)) tail++
  const replacement = longest.slice(0, head) + longest.slice(tail)
  const replace = (entry: JsonValue, depth: number): JsonValue => {
    if (depth === selected.length) return replacement
    if (Array.isArray(entry))
      return entry.map((child, index) => (index === selected[depth] ? replace(child, depth + 1) : child))
    if (entry !== null && typeof entry === 'object')
      return Object.fromEntries(
        Object.entries(entry).map(([key, child]) => [key, key === selected[depth] ? replace(child, depth + 1) : child]),
      )
    return entry
  }
  return replace(value, 0)
}

/** Full JSON must be saved before publishing a changed item. */
export const boundItemReport = (report: ThreadReport): ThreadReport => {
  if (report.kind !== 'turn.item' || !report.item) return report
  const original = report.item
  const safeItem = {
    ...original,
    type: displayText(original.type),
    status: displayText(original.status),
    id: report.metadata?.item_text_sanitized ? original.id : itemId(original.id),
    ...(original.parent_id === undefined
      ? {}
      : { parent_id: report.metadata?.item_text_sanitized ? original.parent_id : itemId(original.parent_id) }),
    ...(original.title === undefined ? {} : { title: displayText(original.title) }),
  }
  const sanitized = JSON.stringify(safeItem) !== JSON.stringify(original)
  let bounded: ThreadReport = {
    ...report,
    item: safeItem,
    truncated: report.truncated ?? false,
    original_bytes: report.original_bytes ?? bytes(original.data),
    ...(sanitized ? { metadata: { ...report.metadata, item_text_sanitized: true } } : {}),
  }
  // The copied title and data share the item budget; the envelope has its own reserve.
  let reductions = 0
  while (bounded.item && (bytes(bounded.item) > itemDataBudget || bytes(bounded) > itemReportBudget)) {
    const item = bounded.item
    if (reductions++ >= 256) {
      bounded = {
        ...bounded,
        item: { ...item, data: null, ...(item.title === undefined ? {} : { title: '' }) },
        metadata: { ...bounded.metadata, item_structure_omitted: true },
      }
      if (bytes(bounded.item) > itemDataBudget || bytes(bounded) > itemReportBudget)
        throw new Error('Turn item identity or report envelope exceeds its budget')
    } else if (item.title && bytes(item.title) > bytes(item.data)) {
      const title = shortenLongest(item.title)
      bounded = { ...bounded, item: { ...item, title: typeof title === 'string' ? title : '' } }
    } else {
      const data = shortenLongest(item.data)
      bounded = {
        ...bounded,
        item: { ...item, data },
        ...(data === null ? { metadata: { ...bounded.metadata, item_structure_omitted: true } } : {}),
      }
    }
    bounded = { ...bounded, truncated: true }
  }
  return bounded
}
