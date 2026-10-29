import { Effect, Stream } from 'effect'
import { describe, expect, it } from 'vite-plus/test'
import { makeOutputMailbox, OutputBuffer, outputCapacity, outputPageBytes } from './output.ts'

const page = (buffer: OutputBuffer, cursor?: string) => {
  const result = buffer.read(cursor)
  if (!result.ok) throw new Error(result.code)
  return result
}

describe('current turn output', () => {
  it('uses byte cursors, validates UTF-8 boundaries and returns at most 16 KiB', () => {
    const buffer = new OutputBuffer()
    const origin = page(buffer).cursor
    buffer.append('a'.repeat(outputPageBytes - 1) + '😀汉字')
    const first = page(buffer, origin)
    expect(Buffer.byteLength(first.text)).toBe(outputPageBytes - 1)
    const second = page(buffer, first.cursor)
    expect(second.text).toBe('😀汉字')
    expect(page(buffer, second.cursor).text).toBe('')
    const epoch = first.cursor.split(':')[0]
    expect(buffer.read(`${epoch}:${outputPageBytes}`)).toMatchObject({ ok: false, code: 'invalid_cursor' })
    for (const cursor of ['bad', 'epoch:-1', ':0', 'epoch:1:2', 'epoch:1.5', 'epoch:9007199254740992'])
      expect(buffer.read(cursor)).toMatchObject({ ok: false, code: 'invalid_cursor' })
  })

  it('retains a UTF-8 suffix within 256 KiB across wraps and reports evicted and future cursors', () => {
    const buffer = new OutputBuffer()
    const origin = page(buffer).cursor
    const text = '汉😀'.repeat(70_000)
    for (let index = 0; index < text.length; index += 300) buffer.append(text.slice(index, index + 300))
    let result = page(buffer, origin)
    expect(result.gap).toBe(true)
    let retained = result.text
    while (true) {
      result = page(buffer, result.cursor)
      expect(result.gap).toBe(false)
      if (!result.text) break
      retained += result.text
    }
    expect(Buffer.byteLength(retained)).toBeLessThanOrEqual(outputCapacity)
    expect(retained).not.toContain('�')
    expect(text.endsWith(retained)).toBe(true)
    expect(page(buffer, `${result.cursor.split(':')[0]}:9999999`).gap).toBe(true)
  })

  it('marks upstream loss even at the previous end and changes epoch when cleared', () => {
    const buffer = new OutputBuffer()
    buffer.append('first')
    const previous = page(buffer)
    buffer.append('after loss', true)
    expect(page(buffer, previous.cursor)).toMatchObject({ text: 'after loss', gap: true })
    const current = page(buffer)
    expect(page(buffer, current.cursor)).toMatchObject({ text: '', gap: false })
    buffer.reset()
    expect(page(buffer, current.cursor)).toMatchObject({ text: '', gap: true })
    expect(page(buffer).gap).toBe(false)
    expect(page(buffer).cursor).not.toBe(current.cursor)
  })

  it('bounds a stalled output consumer and preserves a visible upstream gap', async () => {
    const mailbox = makeOutputMailbox()
    const identity = { nativeSessionId: 'native', messageId: 'input', executionId: 'run' }
    for (let index = 0; index < 20_000; index++) mailbox.offer({ ...identity, text: '😀'.repeat(32) })
    const result = await Effect.runPromise(Stream.runCollect(mailbox.stream.pipe(Stream.take(16))))
    expect(result[0]?.gap).toBe(true)
    expect(result.every((item) => Buffer.byteLength(item.text) <= outputPageBytes)).toBe(true)
    expect(Buffer.byteLength(result.map((item) => item.text).join(''))).toBe(outputCapacity)
  })

  it('keeps the current reply identity when a later reply replaces buffered output', async () => {
    const mailbox = makeOutputMailbox()
    const identity = { nativeSessionId: 'native', messageId: 'input', executionId: 'run' }
    mailbox.offer({ ...identity, replyId: 'first', text: 'first reply' })
    mailbox.offer({ ...identity, replyId: 'second', text: 'second reply' })
    const result = await Effect.runPromise(Stream.runCollect(mailbox.stream.pipe(Stream.take(1))))
    expect(result[0]).toMatchObject({ replyId: 'second', text: 'second reply' })
  })
})
