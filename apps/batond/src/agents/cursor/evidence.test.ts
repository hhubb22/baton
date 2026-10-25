import { expect, it } from 'vite-plus/test'
import { findSent, validatePreparation, type SnapshotMessage } from '../../agent-host/evidence.ts'
import type { AgentMessage } from '../../worker/agent.ts'
import { preparationFor } from '../../agent-host/preparation.ts'
import type { WorkerOpenConfig } from '@baton/protocol'

const config = { thread_id: 'thread' } as WorkerOpenConfig
const message: AgentMessage = { id: 'message', operationId: 'operation', epoch: 2, mode: 'queue', text: 'repeat' }
const messages: SnapshotMessage[] = [
  { id: 'old-user', role: 'user', text: 'repeat' },
  { id: 'old-reply', role: 'assistant', text: 'previous answer' },
]

it('confirms only the next user record after the confirmed sends', () => {
  const baseline = preparationFor(config, 'native', message, 1)
  expect(findSent(message, baseline, messages)).toBeUndefined()
  expect(findSent(message, baseline, [...messages, { id: 'accepted', role: 'user', text: 'repeat' }])).toEqual({
    nativeSessionId: 'native',
    executionId: 'accepted',
  })
  expect(
    findSent(message, baseline, [
      ...messages,
      { id: 'other', role: 'user', text: 'different' },
      { id: 'accepted', role: 'user', text: 'repeat' },
    ]),
  ).toBeUndefined()
  // An already confirmed input is not evidence again.
  expect(findSent(message, baseline, messages)).toBeUndefined()
})

it('rejects preparations with an invalid confirmed count or size', () => {
  expect(() =>
    validatePreparation(message, { nativeSessionId: 'native', preparationId: 'prep', confirmedSends: -1 }),
  ).toThrow(/preparation/)
  expect(() =>
    validatePreparation(message, { ...preparationFor(config, 'native', message, 0), nativeSessionId: '' }),
  ).toThrow(/preparation/)
})
