import { expect, it } from 'vite-plus/test'
import { projectToolJSONPage, boundedBase64 } from './project-tools.ts'

it('preserves binary output encoding when reducing a shell tool result', () => {
  const bytes = Buffer.alloc(32768)
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256
  const output = boundedBase64(bytes.toString('base64'), 20000)
  const retained = Buffer.from(output, 'base64')
  expect(retained.toString('base64')).toBe(output)
  expect(output.length).toBeLessThanOrEqual(20000)
  expect(retained.subarray(0, 256)).toEqual(bytes.subarray(0, 256))
  expect(retained.subarray(-256)).toEqual(bytes.subarray(-256))
})

it('chunks escaped UTF-8 JSON below tool result capacity without breaking characters', () => {
  const value = { content: '中文\\\n"'.repeat(10000) }
  let offset = 0,
    text = '',
    more = true
  while (more) {
    const p = projectToolJSONPage(value, { offset, max_bytes: 32768 })
    expect(
      Buffer.byteLength(
        JSON.stringify({ format: 'pi-ai/1', message: { content: [{ type: 'text', text: JSON.stringify(p) }] } }),
      ),
    ).toBeLessThan(32768)
    text += p.text
    more = p.truncated
    if (!more) break
    expect(p.next_offset).toBeGreaterThan(offset)
    offset = p.next_offset!
  }
  expect(JSON.parse(text)).toEqual(value)
})
