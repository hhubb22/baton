import { beforeEach, expect, it } from 'vitest'
import { readPendingInput, savePendingInput } from './pending-input.ts'
beforeEach(() => sessionStorage.clear())
it('只保存操作标识，切换员工时分别恢复', () => {
 const input = { id: 'operation', session: 'session', text: '不保存的正文' }
 savePendingInput('alice', input)
 expect(readPendingInput('alice')).toEqual({ id: 'operation', session: 'session' })
 expect(JSON.stringify(sessionStorage)).not.toContain(input.text)
 expect(readPendingInput('bob')).toBeNull()
 savePendingInput('bob', { id: 'other', session: 'other-session' })
 savePendingInput('alice', null)
 expect(readPendingInput('alice')).toBeNull()
 expect(readPendingInput('bob')?.id).toBe('other')
})
