import { Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'
import { ProjectMessageInput, ProjectMessageReference } from '../src/project.ts'

const reference = {
  kind: 'file' as const,
  title: 'source.ts',
  threadId: null,
  reply: null,
  deviceId: null,
  path: '/workspace/source.ts',
  lines: { from: 1, to: 2 },
  excerpt: 'selected code',
  bytes: 13,
}

describe('Project message references', () => {
  it('accepts an optional structured reference without changing the body', () => {
    const decode = Schema.decodeUnknownSync(ProjectMessageInput)
    expect(decode({ client_message_id: 'm', content: 'Explain', reference })).toEqual({
      client_message_id: 'm',
      content: 'Explain',
      reference,
    })
    expect(decode({ client_message_id: 'm', content: 'Explain' }).reference).toBeUndefined()
  })

  it('rejects invalid ranges, byte counts and oversized excerpts', () => {
    const decode = Schema.decodeUnknownSync(ProjectMessageReference)
    for (const invalid of [
      { ...reference, lines: { from: 2, to: 1 } },
      { ...reference, bytes: 0 },
      { ...reference, excerpt: '汉'.repeat(2731), bytes: 8193 },
      { ...reference, kind: 'other' },
    ])
      expect(() => decode(invalid)).toThrow()
  })
})
