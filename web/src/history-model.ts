export type HistoryEntry = { id?: string; parent_id?: string; kind?: string; text: string; reference: string; bytes: number; truncated: boolean }
export type HistoryPage = { entries: HistoryEntry[]; cursor: string; has_more: boolean; gap: boolean; code?: string }
export type HistoryResult = { ok: boolean; code?: string; history?: HistoryPage }

export function historyError(code?: string): string {
  const messages: Record<string, string> = {
    node_offline: '节点离线，历史暂不可取回。',
    node_unavailable: '节点暂时不可达，请稍后重试。',
    history_missing: '节点本地历史缺失或与原 Session 不匹配。',
    history_changed: '已读取的历史被删除或改写，原游标无法继续。请从头读取；原缺口仍需核实。',
    history_incomplete: '节点末尾仍有未写完的记录，请稍后补取。',
    history_invalid: '节点历史包含损坏的记录，后续内容无法读取。',
    invalid_cursor: '历史游标无效，请从头读取。',
    revoked: '节点已吊销，不能读取历史。',
    unsupported: '此 Agent 尚不支持浏览器历史。',
    history_busy: '节点正在处理其他历史查询，请稍后重试。',
  }
  return messages[code ?? ''] ?? '历史暂不可用，已读取内容保留，请稍后重试。'
}

export function validHistoryPage(page: HistoryPage | undefined): page is HistoryPage {
  return !!page && Array.isArray(page.entries) && page.entries.length <= 16 && typeof page.cursor === 'string' && page.cursor.length > 0 && page.cursor.length <= 100 &&
    typeof page.has_more === 'boolean' && typeof page.gap === 'boolean' && new TextEncoder().encode(JSON.stringify(page)).length <= 16 * 1024 &&
    page.entries.every((e) => typeof e.text === 'string' && typeof e.reference === 'string' && typeof e.truncated === 'boolean')
}
