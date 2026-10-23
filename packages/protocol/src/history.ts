import { Schema } from 'effect'
import { SessionHistoryPage, SessionResult } from './dto.ts'

export const HistoryCode = Schema.Literals([
  'history_loading',
  'history_changed',
  'history_missing',
  'history_unavailable',
  'invalid_cursor',
])
export type HistoryCode = typeof HistoryCode.Type
export const HistoryResult = SessionResult.check(
  Schema.makeFilter((value) =>
    value.ok
      ? (value.history !== undefined && value.history !== null && value.history.cursor.length > 0) ||
        '历史成功结果缺少有效页面'
      : (value.history === undefined && value.code !== undefined && value.code.length > 0) ||
        '历史失败结果必须有原因并省略页面',
  ),
)
export type HistoryResult = typeof HistoryResult.Type
export const validHistoryPage = Schema.is(SessionHistoryPage)

export function canCreateAgent(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const agent = value as { status?: unknown; capabilities?: { create?: unknown } }
  return agent.status === 'available' && agent.capabilities?.create === true
}
