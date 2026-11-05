import { expect, it } from 'vite-plus/test'
import { createLogger, describeError } from './index.ts'

const collect = () => {
  const lines: string[] = []
  return {
    lines,
    logger: createLogger('test-service', {
      version: '1.2.3',
      commit: 'abcdef',
      pid: 42,
      now: () => new Date('2026-06-01T12:00:00.000Z'),
      write: (line) => lines.push(line),
    }),
  }
}

it('adds the fixed service envelope and serializes fields as JSON', () => {
  const { lines, logger } = collect()
  logger.info('server.started', { port: 8080, node_id: 'node-1', optional: undefined })
  expect(JSON.parse(lines[0]!)).toEqual({
    time: '2026-06-01T12:00:00.000Z',
    level: 'info',
    service: 'test-service',
    version: '1.2.3',
    commit: 'abcdef',
    pid: 42,
    event: 'server.started',
    port: 8080,
    node_id: 'node-1',
  })
})

it('drops secret fields, credential values and payload text but keeps identifiers', () => {
  const { lines, logger } = collect()
  logger.error('request.failed', {
    request_id: '6f961d3a-7a4d-4d02-b0f7-8b7ef5f1f9c5',
    message_id: 'message-1',
    error_code: 'unavailable',
    password: 'hunter2',
    token: 'abc',
    content: 'conversation body',
    prompt: 'system prompt',
    reason: 'Authorization: Bearer secret-value',
    nested: { body: 'private body', thread_id: 'thread-1', authorization: 'Basic abc' },
  })
  const line = lines[0]!
  expect(JSON.parse(line)).toMatchObject({
    request_id: '6f961d3a-7a4d-4d02-b0f7-8b7ef5f1f9c5',
    message_id: 'message-1',
    error_code: 'unavailable',
    reason: '[redacted]',
    nested: { thread_id: 'thread-1' },
  })
  expect(line).not.toContain('hunter2')
  expect(line).not.toContain('conversation body')
  expect(line).not.toContain('system prompt')
  expect(line).not.toContain('private body')
})

it('describes failures without copying their messages', () => {
  const error = Object.assign(new Error('prompt and transcript body'), { code: 'node_timeout' })
  expect(describeError(error)).toEqual({ error_type: 'Error', error_code: 'node_timeout' })
  expect(JSON.stringify(describeError(error))).not.toContain('prompt')
})

it('caps oversized values and circular structures', () => {
  const { lines, logger } = collect()
  const circular: Record<string, unknown> = {}
  circular.self = circular
  logger.warn('test.large', { value: 'x'.repeat(4096), circular, items: Array.from({ length: 100 }, () => 1) })
  const record = JSON.parse(lines[0]!)
  expect(record.value.length).toBeLessThan(2100)
  expect(record.items).toHaveLength(50)
  expect(record.circular.self).toBe('[truncated]')
})
