export type QuoteSource = { taskID?: string; attentionID?: string; field: string; nodeID?: string; path?: string; startLine?: number; endLine?: number }
export const byteLength = (text: string) => new TextEncoder().encode(text).length

export function projectQuote(text: string, source: QuoteSource): string {
  const originalLength = byteLength(text)
  let quote = '', bytes = 0
  for (const char of text) {
    bytes += byteLength(char)
    if (bytes > 8 * 1024) break
    quote += char
  }
  const origin = [source.taskID && `任务 ${source.taskID}`, source.attentionID && `事项 ${source.attentionID}`, `字段 ${source.field}`, source.nodeID && `节点 ${source.nodeID}`, source.path && `路径 ${source.path}`, source.startLine && `行 ${source.startLine}–${source.endLine ?? source.startLine}`].filter(Boolean).join('；')
  return `来源：${origin}${originalLength > 8 * 1024 ? `\n引用已截短至 8 KiB，原长度 ${originalLength} 字节。` : ''}${quote ? `\n\n> ${quote.replace(/\n/g, '\n> ')}` : ''}\n\n`
}

export function selectedQuote(element: HTMLElement): { text: string; startLine: number; endLine: number } {
  const selection = window.getSelection()
  if (!selection || !selection.rangeCount || selection.isCollapsed) return { text: '', startLine: 1, endLine: 1 }
  const range = selection.getRangeAt(0)
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return { text: '', startLine: 1, endLine: 1 }
  const before = range.cloneRange()
  before.selectNodeContents(element); before.setEnd(range.startContainer, range.startOffset)
  const startLine = before.toString().split('\n').length
  const text = range.toString()
  return { text, startLine, endLine: startLine + text.split('\n').length - 1 }
}
