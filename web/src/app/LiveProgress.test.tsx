import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { quietLabel, usePacedCount, useQuietSeconds } from './LiveProgress'

describe('useQuietSeconds', () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms))

  it('30 秒没有新事件才开始计时，新事件到达后清零', () => {
    const { result, rerender } = renderHook(({ signal }) => useQuietSeconds(signal, true), {
      initialProps: { signal: 1 },
    })
    advance(29_000)
    expect(result.current).toBeNull()
    advance(16_000)
    expect(result.current).toBe(45)
    rerender({ signal: 2 })
    expect(result.current).toBeNull()
  })

  it('这一轮结束后不再计时', () => {
    const { result, rerender } = renderHook(({ active }) => useQuietSeconds(1, active), {
      initialProps: { active: true },
    })
    advance(40_000)
    rerender({ active: false })
    expect(result.current).toBeNull()
  })
})

describe('usePacedCount', () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  it('首屏直接显示，成批到达时逐条显示，积压太多时跳过', () => {
    const { result, rerender } = renderHook(({ target }) => usePacedCount(target, 700, 4), {
      initialProps: { target: 3 },
    })
    expect(result.current).toBe(3)
    rerender({ target: 5 })
    expect(result.current).toBe(3)
    act(() => void vi.advanceTimersByTime(700))
    expect(result.current).toBe(4)
    rerender({ target: 20 })
    act(() => void vi.advanceTimersByTime(700))
    expect(result.current).toBe(16)
  })
})

it('超过一分钟时显示分和秒', () => {
  expect(quietLabel(45)).toBe('45 秒没有新进展')
  expect(quietLabel(125)).toBe('2 分 05 秒没有新进展')
})
