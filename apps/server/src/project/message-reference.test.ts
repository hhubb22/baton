import { describe, expect, it } from 'vite-plus/test'
import { normalizeProjectMessage } from './message-reference.ts'

const reference = {
  kind: 'file' as const,
  title: 'source.ts',
  threadId: null,
  reply: null,
  deviceId: null,
  path: '/workspace/source.ts',
  lines: null,
  excerpt: 'code',
  bytes: 4,
}
const legacy = (value: unknown) =>
  'Question\n\n<baton-reference version="1">\n' + JSON.stringify(value) + '\n</baton-reference>'

describe('legacy Project message references', () => {
  it('splits a complete legacy suffix while preserving malformed and ordinary text', () => {
    expect(normalizeProjectMessage({ content: legacy(reference) })).toEqual({ content: 'Question', reference })
    for (const content of [
      'plain text',
      legacy({ kind: 'file' }),
      legacy({ ...reference, bytes: 0 }),
      legacy(reference) + '\nmore text',
      'Question\n\n<baton-reference version="1">\n{bad}\n</baton-reference>',
    ]) {
      expect(normalizeProjectMessage({ content })).toEqual({ content })
    }
  })

  it('keeps new literal message text intact when the structured field is present', () => {
    const message = { content: legacy(reference), reference: null }
    expect(normalizeProjectMessage(message)).toEqual(message)
  })
})
