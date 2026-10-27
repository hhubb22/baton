import { Schema } from 'effect'
import { expect, it } from 'vite-plus/test'
import { BrowserEvent, BrowserProjectChanged, BrowserThreadChanged, NodesChanged } from '../src/index.ts'

const id = '11111111-1111-4111-8111-111111111111'

it('round-trips entity-scoped detail changes through the browser event union', () => {
  for (const [schema, event] of [
    [BrowserThreadChanged, { type: 'thread.changed', thread_id: id, change: 'detail' }],
    [BrowserProjectChanged, { type: 'project.changed', project_id: id, change: 'detail' }],
  ] as const) {
    expect(Schema.decodeUnknownSync(schema)(event)).toEqual(event)
    const decoded = Schema.decodeUnknownSync(BrowserEvent)({ ...event, future: true })
    expect(Schema.encodeSync(BrowserEvent)(decoded)).toEqual(event)
    expect(Schema.is(BrowserEvent)({ type: event.type })).toBe(false)
    expect(Schema.is(BrowserEvent)({ ...event, change: 'unknown' })).toBe(false)
  }
  expect(Schema.decodeUnknownSync(BrowserEvent)({ type: 'nodes.changed', node_id: id })).toEqual({
    type: 'nodes.changed',
    node_id: id,
  })
  expect(Schema.is(NodesChanged)({ type: 'nodes.changed' })).toBe(false)
  expect(Schema.is(BrowserThreadChanged)({ type: 'thread.changed', thread_id: 'invalid', change: 'detail' })).toBe(
    false,
  )
  expect(Schema.is(BrowserProjectChanged)({ type: 'project.changed', project_id: 'invalid', change: 'detail' })).toBe(
    false,
  )
})
