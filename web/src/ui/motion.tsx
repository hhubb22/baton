import * as stylex from '@stylexjs/stylex'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { enter } from '../theme/motion'

const styles = stylex.create({
  slot: { display: 'inline-flex', flexShrink: 0, alignItems: 'center', justifyContent: 'center' },
})

function exitDuration() {
  return Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--motion-exit')) || 0
}

// 让内容在 show 变假后多留一段退场时间。leaving 为真时由调用方套上 leave 样式。
export function usePresence(show: boolean) {
  const [mounted, setMounted] = useState(show)
  if (show && !mounted) setMounted(true)
  useEffect(() => {
    if (show || !mounted) return
    const timer = window.setTimeout(() => setMounted(false), exitDuration())
    return () => window.clearTimeout(timer)
  }, [show, mounted])
  return { mounted: mounted || show, leaving: mounted && !show }
}

// value 变化时新内容弹入。首次渲染不播放，所以列表加载时不会一起动。
export function Swap({ value, children }: { value: string; children: ReactNode }) {
  const [previous, setPrevious] = useState(value)
  const [changed, setChanged] = useState(false)
  if (previous !== value) {
    setPrevious(value)
    setChanged(true)
  }
  return (
    <span key={value} {...stylex.props(styles.slot, changed && enter.pop)}>
      {children}
    </span>
  )
}

// when 从假变真时弹入；一开始就为真的直接显示。用于未读点这类会中途出现的小符号。
export function Appear({ when, children }: { when: boolean; children: ReactNode }) {
  const [wasAbsent, setWasAbsent] = useState(!when)
  if (!when && !wasAbsent) setWasAbsent(true)
  if (!when) return null
  return <span {...stylex.props(styles.slot, wasAbsent && enter.pop)}>{children}</span>
}

type Arrivals = { scope: unknown; seen: Set<string>; arrived: Set<string> }

// 找出列表末尾新到的条目。首批数据和向上翻出的历史都算已读过，scope 变化时重新开始。
export function useArrivals(scope: unknown) {
  const state = useRef<Arrivals>({ scope, seen: new Set(), arrived: new Set() })
  return {
    sync(ids: readonly string[]) {
      if (state.current.scope !== scope) state.current = { scope, seen: new Set(), arrived: new Set() }
      const { seen, arrived } = state.current
      const initialized = seen.size > 0
      let lastSeen = -1
      ids.forEach((id, index) => {
        if (seen.has(id)) lastSeen = index
      })
      ids.forEach((id, index) => {
        if (seen.has(id)) return
        seen.add(id)
        if (initialized && index > lastSeen) arrived.add(id)
      })
      return arrived
    },
  }
}

// 测量当前选中项的位置，供 Tabs 和 Segmented 的滑块使用。首次定位不播放过渡。
export function useSlidingIndicator<T extends HTMLElement>(
  value: string,
): { listRef: RefObject<T | null>; box: { x: number; width: number } | null; moved: boolean } {
  const listRef = useRef<T | null>(null)
  const [box, setBox] = useState<{ x: number; width: number } | null>(null)
  const [previous, setPrevious] = useState(value)
  const [moved, setMoved] = useState(false)
  if (previous !== value) {
    setPrevious(value)
    setMoved(true)
  }
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const measure = () => {
      const active = list.querySelector<HTMLElement>('[aria-selected="true"], [aria-checked="true"]')
      if (!active) return
      const next = { x: active.offsetLeft, width: active.offsetWidth }
      setBox((current) => (current?.x === next.x && current.width === next.width ? current : next))
    }
    measure()
    // 字体加载和计数变化都会改变选项宽度。
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    for (const child of list.children) observer.observe(child)
    return () => observer.disconnect()
  }, [value])
  return { listRef, box, moved }
}
