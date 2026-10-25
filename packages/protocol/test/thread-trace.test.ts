import { expect, it } from 'vite-plus/test'
import { Schema } from 'effect'
import { ThreadReport, ThreadTrace, ThreadTraceQuery } from '../src/index.ts'

const report = {
  type: 'thread.report',
  thread_id: '11111111-1111-4111-8111-111111111111',
  event_id: '22222222-2222-4222-8222-222222222222',
  worker_seq: 3,
  kind: 'turn.item',
  worker_turn_seq: 1,
  truncated: false,
  original_bytes: 80,
  item: {
    id: 'command-1',
    type: 'command_execution',
    status: 'completed',
    ordinal: 0,
    data: { input: 'pwd', output: '/repo', exitCode: 0 },
  },
} as const

it('requires a turn and bounded process item with truncation facts', () => {
  expect(Schema.is(ThreadReport)(report)).toBe(true)
  for (const incomplete of [
    { ...report, item: undefined },
    { ...report, worker_turn_seq: 0 },
    { ...report, truncated: undefined },
    { ...report, original_bytes: undefined },
    { ...report, item: { ...report.item, ordinal: -1 } },
    { ...report, item: { ...report.item, data: { output: '\\'.repeat(192 * 1024) } } },
  ]) {
    expect(Schema.is(ThreadReport)(incomplete)).toBe(false)
  }
  expect(
    Schema.is(ThreadReport)({ ...report, kind: 'turn.ended', token_usage: { inputTokens: 9, outputTokens: 3 } }),
  ).toBe(true)
})

it('accepts trace pages and cursors without a device connection', () => {
  expect(Schema.is(ThreadTraceQuery)({ worker_turn_seq: '1', cursor: 'next-page' })).toBe(true)
  expect(Schema.is(ThreadTraceQuery)({ worker_turn_seq: '0' })).toBe(false)
  expect(
    Schema.is(ThreadTrace)({
      ok: true,
      steps: [
        {
          item_id: report.item.id,
          type: report.item.type,
          status: report.item.status,
          ordinal: report.item.ordinal,
          data: report.item.data,
          truncated: false,
          original_bytes: 80,
        },
      ],
      page_cursor: 'current-page',
      next_cursor: 'next-page',
    }),
  ).toBe(true)
})
