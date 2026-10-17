import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearCSRF, readCSRF, writeCSRF } from './session.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('CSRF', () => {
  it('只放在 sessionStorage', () => {
    const setLocal = vi.spyOn(Storage.prototype, 'setItem')
    writeCSRF('csrf-token-value-0123456789')
    expect(readCSRF()).toBe('csrf-token-value-0123456789')
    expect(localStorage.length).toBe(0)
    const localWrites = setLocal.mock.calls.filter((call) => call[0] !== 'baton_csrf')
    expect(localWrites).toEqual([])
    clearCSRF()
    expect(readCSRF()).toBe('')
  })
})
