import { describe, expect, it } from 'vite-plus/test'
import type { WorkerOpenConfig } from '@baton/protocol'
import { findSent, validatePreparation } from './evidence.ts'
import type { NativeMapping, NativeMessage } from './protocol.ts'
import type { AgentMessage } from '../../worker/agent.ts'
import { preparationFor } from '../../agent-host/preparation.ts'

const config = { thread_id: 'thread' } as WorkerOpenConfig
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

describe('Cursor input evidence', () => {
  it('confirms only the next user record after the confirmed sends', () => {
    const baseline = preparationFor(config, mapping.nativeSessionId, message, 1)
    expect(findSent(config, message, mapping, baseline, history)).toBeUndefined()
    expect(
      findSent(config, message, mapping, baseline, [...history, { id: 'accepted', role: 'user', text: 'repeat' }]),
    ).toEqual({ nativeSessionId: 'native', executionId: 'accepted' })
    expect(
      findSent(config, message, mapping, baseline, [
        ...history,
        { id: 'other', role: 'user', text: 'different' },
        { id: 'accepted', role: 'user', text: 'repeat' },
      ]),
    ).toBeUndefined()
    // An already confirmed input is not evidence again.
    expect(findSent(config, message, mapping, baseline, [history[0]!, history[1]!])).toBeUndefined()
  })
  it('binds the native session, input document and control epoch', () => {
    const baseline = preparationFor(config, mapping.nativeSessionId, message, 0)
    for (const other of [{ ...mapping, nativeSessionId: 'another' }]) {
      expect(() => validatePreparation(config, message, other, baseline)).toThrow(/preparation/)
    }
    expect(() => validatePreparation(config, { ...message, epoch: 3 }, mapping, baseline)).toThrow(/preparation/)
    expect(() => validatePreparation(config, { ...message, text: 'other' }, mapping, baseline)).toThrow(/preparation/)
  })
})
