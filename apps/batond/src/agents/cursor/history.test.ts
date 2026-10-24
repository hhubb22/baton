import { expect, it } from 'vite-plus/test'
import type { WorkerOpenConfig } from '@baton/protocol'
import { nativeMessagesFromSdk } from './history.ts'
import { findSent } from './evidence.ts'
import { preparationFor } from '../../agent-host/preparation.ts'

const config = { thread_id: 'thread' } as WorkerOpenConfig
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
    expect(
      findSent(config, input, mapping, preparationFor(config, mapping.nativeSessionId, input, 0), history),
    ).toEqual({
      nativeSessionId: 'native',
      executionId: 'turn-id:user',
    })
    expect(preparationFor(config, mapping.nativeSessionId, { ...input, id: 'next' }, 1).confirmedSends).toBe(1)
  }
})
