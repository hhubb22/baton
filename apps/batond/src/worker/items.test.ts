import { randomUUID } from 'node:crypto'
import { Schema } from 'effect'
import { ThreadReport, WorkerIPCMessage } from '@baton/protocol'
import type { JsonValue } from './agent.ts'
import { expect, it } from 'vite-plus/test'
import { boundReport, pendingResult } from './reports.ts'
import { itemDataBudget } from './items.ts'

const report = (data: JsonValue, title?: string): ThreadReport => ({
  type: 'thread.report',
  thread_id: randomUUID(),
  storage_generation: randomUUID(),
  event_id: randomUUID(),
  worker_seq: 1,
  worker_turn_seq: 1,
  kind: 'turn.item',
  truncated: false,
  original_bytes: Buffer.byteLength(JSON.stringify(data)),
  item: {
    id: 'command',
    type: 'command_execution',
    status: 'completed',
    ordinal: 0,
    data,
    ...(title === undefined ? {} : { title }),
  },
})

it('clips multiple nested strings with JSON escaping and UTF-8 boundaries, preserving both ends', () => {
  const data = {
    input: 'BEGIN' + '中🙂'.repeat(25000) + 'END',
    nested: [{ output: '\u0001'.repeat(60000) }],
    other: 'a'.repeat(150000),
  }
  const original = report(data)
  const bounded = boundReport(original)
  expect(Buffer.byteLength(JSON.stringify(bounded.item))).toBeLessThanOrEqual(itemDataBudget)
  expect(bounded.original_bytes).toBe(Buffer.byteLength(JSON.stringify(data)))
  expect(bounded.truncated).toBe(true)
  expect(bounded.item?.data).toMatchObject({ input: expect.stringMatching(/^BEGIN.*END$/u) })
  expect(original.item?.data).toEqual(data)
  expect(Schema.is(ThreadReport)(bounded)).toBe(true)
  expect(boundReport(bounded)).toEqual(bounded)
})

it.each([{ data: Array.from({ length: 100000 }, (_, i) => i) }, { data: Array(100000).fill('') }])(
  'uses a bounded full-output-only fallback when the JSON structure cannot fit',
  ({ data }) => {
    const bounded = boundReport(report(data))
    expect(bounded.item?.data).toBeNull()
    expect(bounded.truncated).toBe(true)
    expect(bounded.metadata?.item_structure_omitted).toBe(true)
    expect(Schema.is(ThreadReport)(bounded)).toBe(true)
  },
)

it('counts the duplicated title in the whole item and delivers a large item in a bounded pending response', () => {
  const data = { title: '🙂'.repeat(40000), output: 'x'.repeat(140000) }
  const bounded = boundReport(report(data, data.title))
  expect(Buffer.byteLength(JSON.stringify(bounded.item))).toBeLessThanOrEqual(itemDataBudget)
  const result = pendingResult([{ report: bounded, acked: false }], 0)
  expect(result.thread_reports).toHaveLength(1)
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(240 * 1024)
  expect(Schema.is(WorkerIPCMessage)(result)).toBe(true)
})

it('keeps nested NUL and lone surrogates intact and maps only indexed display fields', () => {
  const data = { 'key\0': '\0\ud800', nested: ['\udfff'] }
  const original = report(data, 'title\0\ud800')
  const bounded = boundReport({
    ...original,
    item: { ...original.item!, id: 'unsafe\0\ud800', parent_id: 'x'.repeat(1000) },
  })
  expect(bounded.item?.data).toEqual(data)
  expect(bounded.item?.title).toBe('title��')
  expect(bounded.item?.id).toMatch(/^baton:item:sha256:[a-f0-9]{64}$/)
  expect(bounded.item?.parent_id).toMatch(/^baton:item:sha256:[a-f0-9]{64}$/)
  expect(bounded.metadata?.item_text_sanitized).toBe(true)
  expect(bounded.truncated).toBe(false)
  expect(boundReport(bounded)).toEqual(bounded)
})
