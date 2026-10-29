import { expect, it } from 'vite-plus/test'
import { filterForward } from '../src/forward.ts'

const attr = (key: string, value: unknown) => ({ key, value })
const employeeId = '11111111-1111-4111-8111-111111111111'
const nodeId = '22222222-2222-4222-8222-222222222222'

it('从认证连接重建 trace 并删除未知内容', () => {
  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            attr('service.name', { stringValue: 'baton-worker' }),
            attr('baton.node.id', { stringValue: '33333333-3333-4333-8333-333333333333' }),
            attr('secret', { stringValue: 'private' }),
          ],
        },
        scopeSpans: [
          {
            scope: { name: 'private' },
            spans: [
              {
                traceId: 'a'.repeat(32),
                spanId: 'b'.repeat(16),
                name: 'baton.turn',
                startTimeUnixNano: '1',
                endTimeUnixNano: '2',
                attributes: [
                  attr('baton.employee.id', { stringValue: '33333333-3333-4333-8333-333333333333' }),
                  attr('baton.usage.reported', { boolValue: false }),
                  attr('gen_ai.usage.input_tokens', { intValue: '0' }),
                  attr('gen_ai.request.model', { stringValue: 'custom model' }),
                  attr('private', { stringValue: 'private' }),
                ],
                status: { code: 2, message: 'private' },
                events: [{ name: 'private' }],
                unknown: 'private',
              },
            ],
          },
        ],
      },
    ],
  }
  const result = filterForward('traces', payload, { employeeId, nodeId })
  const encoded = JSON.stringify(result)
  expect(encoded).not.toContain('private')
  expect(encoded).not.toContain('33333333')
  expect(encoded).not.toContain('gen_ai.usage.input_tokens')
  expect(encoded).toContain(employeeId)
  expect(encoded).toContain(nodeId)
  expect(encoded).toContain('custom model')
  const malformed = {
    resourceSpans: [{ resource: { attributes: [attr('service.name', { stringValue: 'unknown' })] } }],
  }
  expect(filterForward('traces', malformed, { employeeId, nodeId })).toBeUndefined()
  const duplicate = structuredClone(payload)
  duplicate.resourceSpans[0]!.resource.attributes.push(attr('service.name', { stringValue: 'private' }))
  expect(filterForward('traces', duplicate, { employeeId, nodeId })).toBeUndefined()
})

it('只转发同批完整且经过共享规则遮挡的回放事件', () => {
  const metadata = (key: string, value: number) => attr(key, { doubleValue: value })
  const event = JSON.stringify({ type: 3, timestamp: 10, data: { text: '******' } })
  const part = (chunk: number, body: string, total = 2) => ({
    timeUnixNano: '10000000',
    body: { stringValue: body },
    attributes: [
      metadata('rr-web.event', 1),
      metadata('rr-web.chunk', chunk),
      metadata('rr-web.total-chunks', total),
      metadata('rr-web.offset', chunk),
    ],
  })
  const wrap = (logRecords: unknown[]) => ({
    resourceLogs: [
      {
        resource: {
          attributes: [
            attr('service.name', { stringValue: 'baton-web' }),
            attr('rum.sessionId', { stringValue: 'a'.repeat(32) }),
          ],
        },
        scopeLogs: [{ logRecords }],
      },
    ],
  })
  const complete = filterForward('logs', wrap([part(1, event.slice(0, 12)), part(2, event.slice(12))]), { employeeId })
  expect(JSON.stringify(complete)).toContain('rr-web.event')
  const missing = filterForward('logs', wrap([part(1, event.slice(0, 12))]), { employeeId })
  expect(JSON.stringify(missing)).not.toContain('rr-web.event')
  const unsafe = filterForward('logs', wrap([part(1, event.replace('******', 'secret'), 1)]), { employeeId })
  expect(JSON.stringify(unsafe)).not.toContain('secret')
  expect(JSON.stringify(unsafe)).not.toContain('rr-web.event')
  const missingSession = wrap([part(1, event, 1)])
  missingSession.resourceLogs[0]!.resource.attributes.pop()
  expect(filterForward('logs', missingSession, { employeeId })).toBeUndefined()
  const duplicateCounter = part(1, event, 1)
  duplicateCounter.attributes.push(metadata('rr-web.chunk', 1))
  expect(JSON.stringify(filterForward('logs', wrap([duplicateCounter]), { employeeId }))).not.toContain('rr-web.event')
})
