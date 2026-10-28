import * as stylex from '@stylexjs/stylex'
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { colors, radius, size } from '../theme/tokens.stylex'

const styles = stylex.create({
  pane: { position: 'relative', flexShrink: 0, height: '100%', minWidth: 0 },
  animatedWidth: {
    transition: 'width 220ms cubic-bezier(0.32, 0.72, 0, 1)',
    '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
  },
  draggingWidth: { transition: 'none' },
  floating: {
    position: 'absolute',
    top: 0,
    right: 0,
    zIndex: 2,
    pointerEvents: 'none',
    opacity: 1,
    transform: 'translateY(0) scale(1)',
    transformOrigin: 'top right',
    visibility: 'visible',
    transition:
      'opacity 180ms cubic-bezier(0.23, 1, 0.32, 1), transform 180ms cubic-bezier(0.23, 1, 0.32, 1), visibility 0s',
    '@media (prefers-reduced-motion: reduce)': { transition: 'opacity 120ms ease', transform: 'none' },
  },
  floatingClosed: {
    opacity: 0,
    transform: 'translateY(-6px) scale(0.98)',
    visibility: 'hidden',
    transition:
      'opacity 180ms cubic-bezier(0.23, 1, 0.32, 1), transform 180ms cubic-bezier(0.23, 1, 0.32, 1), visibility 0s 180ms',
    '@media (prefers-reduced-motion: reduce)': {
      transition: 'opacity 120ms ease, visibility 0s 120ms',
      transform: 'none',
    },
  },
  paneStack: { '@media (max-width: 700px)': { width: '100% !important', height: 'auto' } },
  handle: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: '10px',
    zIndex: 5,
    cursor: 'col-resize',
    pointerEvents: 'auto',
    touchAction: 'none',
    backgroundColor: 'transparent',
    outline: { default: 'none', ':focus-visible': `2px solid ${colors.focus}` },
  },
  right: { right: '-5px' },
  rightAcrossGutter: { right: `calc(-5px - ${size.gutter})` },
  left: { left: '-5px' },
  handleStack: { '@media (max-width: 700px)': { display: 'none' } },
  line: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: '4.75px',
    width: '0.5px',
    pointerEvents: 'none',
    overflow: 'hidden',
    backgroundColor: colors.borderStrong,
    maskImage: 'linear-gradient(to bottom, transparent, black 10%, black 90%, transparent)',
    opacity: 0,
    transition: 'opacity 250ms ease 100ms',
    '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
  },
  highlight: {
    position: 'absolute',
    top: '-50%',
    width: '100%',
    height: '200%',
    backgroundColor: colors.text,
    opacity: 0.95,
    maskImage:
      'linear-gradient(to bottom, transparent 5%, rgba(0,0,0,0.1) 11.4%, rgba(0,0,0,0.2) 17.2%, rgba(0,0,0,0.3) 22.2%, rgba(0,0,0,0.4) 26.6%, rgba(0,0,0,0.5) 30.3%, rgba(0,0,0,0.6) 33.4%, rgba(0,0,0,0.7) 35.7%, rgba(0,0,0,0.8) 37.4%, rgba(0,0,0,0.9) 38.4%, black 38.75%, black 61.25%, rgba(0,0,0,0.9) 61.6%, rgba(0,0,0,0.8) 62.6%, rgba(0,0,0,0.7) 64.3%, rgba(0,0,0,0.6) 66.6%, rgba(0,0,0,0.5) 69.7%, rgba(0,0,0,0.4) 73.4%, rgba(0,0,0,0.3) 77.8%, rgba(0,0,0,0.2) 82.9%, rgba(0,0,0,0.1) 88.6%, transparent 95%)',
  },
  lineInset: { top: radius.lg, bottom: radius.lg },
  lineVisible: { opacity: 1 },
})

function initialWidth(key: string, fallback: number, min: number, max: number) {
  try {
    const saved = localStorage.getItem(key)
    const value = saved === null ? fallback : Number(saved)
    return Number.isFinite(value) && value >= min && value <= max ? value : fallback
  } catch {
    return fallback
  }
}

export function ResizablePane({
  children,
  label,
  storageKey,
  defaultWidth,
  min,
  max,
  reserve,
  edge = 'right',
  collapsed = false,
  stackOnNarrow = false,
  acrossGutter = false,
  floating = false,
  open = true,
  animateCollapse = false,
}: {
  children: ReactNode
  label: string
  storageKey: string
  defaultWidth: number
  min: number
  max: number
  reserve: number
  edge?: 'left' | 'right'
  collapsed?: boolean
  stackOnNarrow?: boolean
  acrossGutter?: boolean
  floating?: boolean
  open?: boolean
  animateCollapse?: boolean
}) {
  const pane = useRef<HTMLDivElement>(null)
  const line = useRef<HTMLDivElement>(null)
  const highlight = useRef<HTMLDivElement>(null)
  const drag = useRef<{ start: number; width: number } | null>(null)
  const [preferred, setPreferred] = useState(() => initialWidth(storageKey, defaultWidth, min, max))
  const [width, setWidth] = useState(preferred)
  const [bounds, setBounds] = useState({ min, max })
  const [hovered, setHovered] = useState(false)
  const [dragging, setDragging] = useState(false)

  useLayoutEffect(() => {
    const element = pane.current
    const parent = element?.parentElement
    if (!element || !parent) return
    const update = () => {
      const available = parent.clientWidth
        ? Math.max(Math.min(min, parent.clientWidth), parent.clientWidth - reserve)
        : max
      const upper = Math.min(max, available)
      const lower = Math.min(min, upper)
      const next = collapsed ? 52 : Math.max(lower, Math.min(preferred, upper))
      element.style.width = `${next}px`
      if (floating) parent.style.setProperty('--project-panel-width', `${next}px`)
      setWidth(next)
      setBounds((current) => (current.min === lower && current.max === upper ? current : { min: lower, max: upper }))
    }
    update()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(parent)
    window.addEventListener('resize', update)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update)
      if (floating) parent.style.removeProperty('--project-panel-width')
    }
  }, [collapsed, floating, max, min, preferred, reserve])

  function change(value: number) {
    const parentWidth = pane.current?.parentElement?.clientWidth ?? 0
    const upper = Math.min(max, parentWidth ? Math.max(Math.min(min, parentWidth), parentWidth - reserve) : max)
    const next = Math.round(Math.max(Math.min(min, upper), Math.min(value, upper)))
    setPreferred(next)
    try {
      localStorage.setItem(storageKey, String(next))
    } catch {
      /* 宽度仅在当前页面生效。 */
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const direction = edge === 'right' ? 1 : -1
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault()
      change(width + (event.key === 'ArrowRight' ? 1 : -1) * direction * (event.shiftKey ? 40 : 10))
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      change(event.key === 'Home' ? min : max)
    }
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { start: event.clientX, width }
    setDragging(true)
  }

  function moveHighlight(event: PointerEvent<HTMLDivElement>) {
    if (!line.current || !highlight.current) return
    const bounds = line.current.getBoundingClientRect()
    const offset = Math.max(
      -bounds.height / 2,
      Math.min(event.clientY - bounds.top - bounds.height / 2, bounds.height / 2),
    )
    highlight.current.style.transform = `translate3d(0, ${offset}px, 0)`
  }

  return (
    <div
      ref={pane}
      inert={!open || undefined}
      aria-hidden={!open || undefined}
      {...stylex.props(
        styles.pane,
        animateCollapse && styles.animatedWidth,
        dragging && styles.draggingWidth,
        floating && styles.floating,
        floating && !open && styles.floatingClosed,
        stackOnNarrow && styles.paneStack,
      )}
    >
      {children}
      {!collapsed && open && (
        <div
          role="separator"
          tabIndex={0}
          aria-label={label}
          aria-orientation="vertical"
          aria-valuemin={bounds.min}
          aria-valuemax={bounds.max}
          aria-valuenow={width}
          onKeyDown={onKeyDown}
          onPointerEnter={(event) => {
            moveHighlight(event)
            setHovered(true)
          }}
          onPointerLeave={() => setHovered(false)}
          onPointerDown={onPointerDown}
          onPointerMove={(event) => {
            moveHighlight(event)
            if (drag.current)
              change(drag.current.width + (event.clientX - drag.current.start) * (edge === 'right' ? 1 : -1))
          }}
          onPointerUp={() => {
            drag.current = null
            setDragging(false)
          }}
          onPointerCancel={() => {
            drag.current = null
            setDragging(false)
          }}
          onLostPointerCapture={() => {
            drag.current = null
            setDragging(false)
          }}
          {...stylex.props(
            styles.handle,
            edge === 'right' ? styles.right : styles.left,
            edge === 'right' && acrossGutter && styles.rightAcrossGutter,
            stackOnNarrow && styles.handleStack,
          )}
        >
          <div
            ref={line}
            aria-hidden="true"
            {...stylex.props(
              styles.line,
              acrossGutter && styles.lineInset,
              (hovered || dragging) && styles.lineVisible,
            )}
          >
            <div ref={highlight} {...stylex.props(styles.highlight)} />
          </div>
        </div>
      )}
    </div>
  )
}
