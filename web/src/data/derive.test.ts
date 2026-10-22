import { describe, expect, it } from 'vitest'
import { referenceLimit, shortenExcerpt } from './derive'

describe('shortenExcerpt', () => {
  it('keeps a short selection whole', () => {
    expect(shortenExcerpt('héllo')).toEqual({ excerpt: 'héllo', bytes: 6 })
  })

  it('cuts at 8 KiB of UTF-8 without splitting a character', () => {
    // 每个汉字 3 字节，8192 不是 3 的倍数，截断点落在字符中间。
    const selected = '重连'.repeat(2000)
    const { excerpt, bytes } = shortenExcerpt(selected)
    expect(bytes).toBe(12_000)
    expect(excerpt.length).toBe(Math.floor(referenceLimit / 3))
    expect(selected.startsWith(excerpt)).toBe(true)
  })
})
