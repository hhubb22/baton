import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useArrivals } from './motion'

function arrivalsOf(lists: string[][]) {
  const { result } = renderHook(() => useArrivals('thread'))
  return lists.map((ids) => [...result.current.sync(ids)])
}

describe('useArrivals', () => {
  it('首批数据不算新到，之后追加到末尾的算', () => {
    expect(
      arrivalsOf([
        ['a', 'b'],
        ['a', 'b', 'c'],
      ]),
    ).toEqual([[], ['c']])
  })

  it('向上翻出的历史不算新到', () => {
    expect(
      arrivalsOf([
        ['b', 'c'],
        ['a', 'b', 'c'],
      ]),
    ).toEqual([[], []])
  })

  it('切换对象后重新开始', () => {
    const { result, rerender } = renderHook(({ scope }) => useArrivals(scope), {
      initialProps: { scope: 'one' },
    })
    result.current.sync(['a'])
    rerender({ scope: 'two' })
    expect([...result.current.sync(['x', 'y'])]).toEqual([])
  })
})
