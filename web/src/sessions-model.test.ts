import { describe, expect, it } from 'vitest'
import { appendOutput, sessionDepth } from './sessions-model.ts'
import type { WorkSession } from './ui/SessionsPage.tsx'
const session = (id: string, node: string, parent?: string): WorkSession => ({ session_id: id, node_id: node, parent_session_id: parent, agent_type: 'pi', status: 'idle', busy: false, task_ids: [], updated_at: '' })
describe('Session 关系和输出边界', () => {
 it('只缩进同一节点的父子关系，循环有界', () => {
  const a = session('a','n'), b = session('b','n','a'), c = session('c','m','b')
  expect(sessionDepth(b,[a,b,c])).toBe(1)
  expect(sessionDepth(c,[a,b,c])).toBe(0)
  a.parent_session_id = 'b'
  expect(sessionDepth(b,[a,b])).toBe(1)
 })
 it('中文输出也限制为 128 KiB', () => {
  const text = appendOutput('中文'.repeat(100000), '<script>alert(1)</script>')
  expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(128*1024+2)
  expect(text).toContain('<script>')
 })
})
