import * as stylex from '@stylexjs/stylex'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { text } from '../theme/text'
import { colors, radius } from '../theme/tokens.stylex'
import { focusRing } from '../ui/Button'
import { Icon, type IconName } from '../ui/Icon'

const styles = stylex.create({
  area: { position: 'relative' },
  menu: {
    position: 'absolute',
    zIndex: 5,
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    height: '30px',
    paddingInline: '10px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: { default: colors.surface, ':hover': colors.hover },
    boxShadow: `0 8px 24px ${colors.shadowFar}`,
    color: colors.text,
    whiteSpace: 'nowrap',
  },
  feedback: { color: colors.muted },
})

// 选中的文字会做什么：返回 Promise 时，按钮在结束后显示它给出的一句结果，例如 Copied。
export type SelectionRun = () => void | Promise<string>

interface Anchor {
  top: number
  bottom: number
  left: number
  run: SelectionRun
}

const gap = 6

function selectionIn(area: HTMLElement) {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (!area.contains(range.commonAncestorContainer)) return null
  const value = selection.toString()
  return value.trim() ? { range, value } : null
}

// 在区域里选中文字后，在选区上方显示一个按钮；上方放不下时放到下方。
// 选区收起、按 Escape 或点过按钮后隐藏。打开时按 Tab 把焦点移到按钮上，Escape 让焦点回到原处。
export function SelectionArea({
  label,
  icon,
  describe,
  onHide,
  style,
  children,
}: {
  label: string
  icon: IconName
  // 选区不在可引用的内容里时返回 null，不显示按钮。
  describe: (range: Range, value: string) => SelectionRun | null
  onHide?: () => void
  style?: stylex.StyleXStyles
  children: ReactNode
}) {
  const areaRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLButtonElement | null>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const latest = useRef({ describe, onHide })
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)

  useEffect(() => {
    latest.current = { describe, onHide }
  })

  const hide = () => {
    setAnchor(null)
    setFeedback(null)
    latest.current.onHide?.()
  }

  const update = () => {
    const area = areaRef.current
    if (!area) return
    const found = selectionIn(area)
    const run = found && latest.current.describe(found.range, found.value)
    if (!found || !run) {
      if (anchor) hide()
      return
    }
    const box = area.getBoundingClientRect()
    const rect = found.range.getBoundingClientRect()
    setFeedback(null)
    setAnchor({ top: rect.top - box.top, bottom: rect.bottom - box.top, left: rect.left - box.left, run })
  }

  // 选区收起或移出区域时隐藏。
  useEffect(() => {
    if (!anchor) return
    const onChange = () => {
      const area = areaRef.current
      if (!area || selectionIn(area)) return
      if (document.activeElement === menuRef.current && feedback) return
      setAnchor(null)
      setFeedback(null)
      latest.current.onHide?.()
    }
    document.addEventListener('selectionchange', onChange)
    return () => document.removeEventListener('selectionchange', onChange)
  }, [anchor, feedback])

  // 位置通过 CSSOM 设置，页面的 CSP 不允许内联 style 属性。
  useLayoutEffect(() => {
    const menu = menuRef.current
    const area = areaRef.current
    if (!menu || !area || !anchor) return
    const height = menu.offsetHeight
    const width = menu.offsetWidth
    const above = anchor.top - height - gap
    const top = above >= 0 ? above : anchor.bottom + gap
    const left = Math.min(Math.max(0, anchor.left), Math.max(0, area.clientWidth - width))
    menu.style.top = `${top}px`
    menu.style.left = `${left}px`
  }, [anchor, feedback])

  const onKeyDown = (event: KeyboardEvent) => {
    if (!anchor) return
    if (event.key === 'Escape') {
      event.stopPropagation()
      hide()
      return
    }
    if (event.key === 'Tab' && !event.shiftKey && event.target !== menuRef.current) {
      event.preventDefault()
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      menuRef.current?.focus()
    }
  }

  const onMenuKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    hide()
    returnFocus.current?.focus()
  }

  const onRun = () => {
    if (!anchor) return
    const result = anchor.run()
    if (!result) {
      hide()
      return
    }
    void result.then(setFeedback)
  }

  return (
    <div
      ref={areaRef}
      onMouseUp={update}
      onKeyUp={(event) => {
        if (event.key !== 'Tab' && event.key !== 'Escape') update()
      }}
      onKeyDown={onKeyDown}
      {...stylex.props(styles.area, style)}
    >
      {children}
      {anchor && (
        <button
          ref={menuRef}
          type="button"
          // 按下时不让按钮抢走焦点，选区保持不变。
          onMouseDown={(event) => event.preventDefault()}
          onClick={onRun}
          onKeyDown={onMenuKeyDown}
          {...stylex.props(text.small, styles.menu, focusRing.ring)}
        >
          {feedback ? (
            <span role="status" {...stylex.props(styles.feedback)}>
              {feedback}
            </span>
          ) : (
            <>
              <Icon name={icon} size={14} />
              {label}
            </>
          )}
        </button>
      )}
    </div>
  )
}

export function copyText(value: string) {
  if (!navigator.clipboard) return Promise.reject(new Error('Clipboard unavailable'))
  return navigator.clipboard.writeText(value)
}

// 复制选中的文字，返回按钮上显示的结果。
export function copySelection(value: string) {
  return copyText(value).then(
    () => 'Copied',
    () => 'Clipboard blocked. Press ⌘C to copy.',
  )
}
