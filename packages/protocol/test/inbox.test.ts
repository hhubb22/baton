import { Schema } from 'effect'
import { expect, it } from 'vite-plus/test'
import { InboxAsk } from '../src/inbox.ts'

it('accepts expandable options and bounds their count, JSON bytes and identities', () => {
  const options = Array.from({ length: 50 }, (_, index) => ({ id: `option-${index}`, label: `Choice ${index}` }))
  const ask = { title: 'Choose', content: 'Details', allow_text: false, options }
  const valid = Schema.is(InboxAsk)
  expect(valid(ask)).toBe(true)
  expect(valid({ ...ask, options: [...options, { id: 'extra', label: 'Extra' }] })).toBe(false)
  expect(valid({ ...ask, options: [options[0], options[0]] })).toBe(false)
  expect(valid({ ...ask, options: [{ id: 'large', label: 'Large', description: '文'.repeat(6000) }] })).toBe(false)
})
