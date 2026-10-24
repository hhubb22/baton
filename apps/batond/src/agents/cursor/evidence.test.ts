import { describe, expect, it } from 'vite-plus/test'
import { prepare, findSent } from './evidence.ts'
import type { NativeMapping, NativeMessage } from './protocol.ts'
import type { AgentMessage } from '../../worker/agent.ts'

const mapping: NativeMapping = {
  version: 1,
  threadId: 'thread',
  nativeSessionId: 'native',
  cwd: '/workspace',
  statePath: '/state/native.json',
  storePath: '/state/cursor-store',
}
const message: AgentMessage = { id: 'message', operationId: 'operation', epoch: 2, mode: 'queue', text: 'repeat' }
const history: NativeMessage[] = [
  { id: 'old-user', role: 'user', text: 'repeat' },
  { id: 'old-reply', role: 'assistant', text: 'previous answer' },
]

describe('Cursor durable input evidence', () => {
  it('matches the first user record after the complete unchanged prefix', () => {
    const baseline = prepare(message, mapping, history)
    expect(findSent(message, mapping, baseline, history)).toBeUndefined()
    expect(
      findSent(message, mapping, baseline, [...history, { id: 'accepted', role: 'user', text: 'repeat' }]),
    ).toEqual({ nativeSessionId: 'native', executionId: 'accepted' })
    expect(
      findSent(message, mapping, baseline, [
        ...history,
        { id: 'other', role: 'user', text: 'different' },
        { id: 'accepted', role: 'user', text: 'repeat' },
      ]),
    ).toBeUndefined()
    expect(
      findSent(message, mapping, baseline, [
        { ...history[0]!, text: 'changed' },
        history[1]!,
        { id: 'accepted', role: 'user', text: 'repeat' },
      ]),
    ).toBeUndefined()
    expect(findSent(message, mapping, baseline, [{ id: 'accepted', role: 'user', text: 'repeat' }])).toBeUndefined()
  })
  it('binds native identity, cwd, full input and control epoch', () => {
    const baseline = prepare(message, mapping, history)
    for (const other of [
      { ...mapping, cwd: '/other' },
      { ...mapping, nativeSessionId: 'another' },
      { ...mapping, storePath: '/other' },
    ]) {
      expect(() => findSent(message, other, baseline, history)).toThrow(/preparation/)
    }
    expect(() => findSent({ ...message, epoch: 3 }, mapping, baseline, history)).toThrow(/preparation/)
  })
})
