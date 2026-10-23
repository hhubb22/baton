import { expect, it } from 'vitest'
import { nativeMessagesFromSdk } from './history.ts'
import { findSent, prepare } from './evidence.ts'
import type { NativeMapping } from './protocol.ts'

it('splits the SDK ConversationTurn into stable user and assistant records', () => {
  const value = {
    userMessage: { text: 'hello' },
    steps: [
      { thinkingMessage: { text: 'private reasoning' } },
      { assistantMessage: { text: 'first answer' } },
      { toolCall: { command: 'ignored' } },
      { assistantMessage: { text: 'final answer' } },
    ],
  }
  const expected = [
    { id: 'turn-id:user', role: 'user', text: 'hello' },
    { id: 'turn-id:assistant:1', role: 'assistant', text: 'first answer' },
    { id: 'turn-id:assistant:3', role: 'assistant', text: 'final answer' },
  ]
  for (const body of [
    { agentConversationTurn: value },
    { turn: { case: 'agentConversationTurn', value } },
    { turn: { case: 'agentConversationTurn', value }, toJSON: () => ({ agentConversationTurn: value }) },
  ]) {
    const history = nativeMessagesFromSdk([{ uuid: 'turn-id', agent_id: 'native', type: 'user', message: body }])
    expect(history).toEqual(expected)
    const mapping: NativeMapping = {
      version: 1,
      threadId: 'thread',
      nativeSessionId: 'native',
      cwd: '/work',
      statePath: '/state/native.json',
      storePath: '/state/cursor-store',
    }
    const input = { id: 'input', text: 'hello', epoch: 1, operationId: 'op', mode: 'queue' as const }
    expect(findSent(input, mapping, prepare(input, mapping, []), history)).toEqual({
      nativeSessionId: 'native',
      executionId: 'turn-id:user',
    })
    expect(prepare({ ...input, id: 'next' }, mapping, history).userCount).toBe(1)
  }
})
