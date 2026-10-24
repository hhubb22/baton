import { DateTime, Schema } from 'effect'
import { OrchestrationV2RuntimeRequest } from '@t3tools/contracts'
import { expect, it } from 'vite-plus/test'
import { runtimeRequestDecision } from './runtime-request.ts'

const createdAt = DateTime.makeUnsafe('2026-01-01T00:00:00.000Z')

const request = (kind: OrchestrationV2RuntimeRequest['kind'], status: 'pending' | 'resolved' = 'pending') =>
  Schema.decodeUnknownSync(OrchestrationV2RuntimeRequest)({
    id: `request-${kind}`,
    nodeId: 'node-1',
    providerTurnId: null,
    nativeRequestRef: null,
    kind,
    status,
    responseCapability: { type: 'message' },
    createdAt,
    resolvedAt: null,
  })

it('allows a permission once and cancels a question', () => {
  expect(runtimeRequestDecision(request('permission'), false)).toBe('accept')
  expect(runtimeRequestDecision(request('command'), false)).toBe('accept')
  expect(runtimeRequestDecision(request('file-read'), false)).toBe('accept')
  expect(runtimeRequestDecision(request('file-change'), false)).toBe('accept')
  expect(runtimeRequestDecision(request('user_input'), false)).toBe('cancel')
  expect(runtimeRequestDecision(request('mcp-elicitation'), false)).toBe('cancel')
})

it('cancels a permission that arrives after stop', () => {
  expect(runtimeRequestDecision(request('permission'), true)).toBe('cancel')
  expect(runtimeRequestDecision(request('mcp-elicitation'), true)).toBe('cancel')
  expect(runtimeRequestDecision(request('permission', 'resolved'), false)).toBeUndefined()
})
