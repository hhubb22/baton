import * as stylex from '@stylexjs/stylex'
import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { text } from '../theme/text'
import { colors, radius, space } from '../theme/tokens.stylex'
import { focusRing } from './Button'
import { Icon } from './Icon'

const styles = stylex.create({
  composer: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.sm,
    width: '100%',
    maxWidth: '712px',
    padding: '12px 12px 12px 16px',
    backgroundColor: colors.surface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.hairline,
    borderRadius: '24px',
    boxShadow: `0 3px 6px -2px ${colors.shadowSoft}, 0 1px 1px ${colors.shadowNear}`,
    cursor: 'text',
  },
  compact: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    alignItems: 'center',
    padding: '8px',
    borderRadius: '28px',
  },
  roomy: { maxWidth: '840px' },
  header: { cursor: 'auto' },
  compactHeader: { gridColumn: '1 / -1' },
  input: {
    width: '100%',
    height: '24px',
    minHeight: '24px',
    maxHeight: '240px',
    padding: 0,
    borderWidth: 0,
    outline: 'none',
    resize: 'none',
    overflowY: 'hidden',
    backgroundColor: 'transparent',
    color: colors.text,
    fontSize: '15px',
    lineHeight: '24px',
    transition: 'height 150ms cubic-bezier(0.23, 1, 0.32, 1)',
    '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
    '::placeholder': { color: colors.faint },
  },
  compactInput: { paddingLeft: '8px' },
  roomyInput: { minHeight: '96px' },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    cursor: 'default',
  },
  chips: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '2px',
    flexGrow: 1,
    minWidth: 0,
    marginLeft: '-8px',
  },
  actions: { display: 'flex', alignItems: 'center', gap: space.sm, flexShrink: 0 },
  send: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '36px',
    height: '36px',
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.pill,
    backgroundColor: { default: colors.accent, ':hover': colors.accentHover, ':active': colors.accentPressed },
    color: colors.onAccent,
  },
  compactToolbar: { alignSelf: 'end' },
  // 没有内容时按钮变灰，点击不发送。
  sendIdle: {
    backgroundColor: { default: colors.subtle, ':hover': colors.subtle, ':active': colors.subtle },
    color: colors.faint,
  },
})

// 输入区：提示文字在上，工具栏在下。Enter 发送，Shift+Enter 换行，输入法组合时不发送。
export function Composer({
  value,
  onChange,
  onSend,
  placeholder,
  chips,
  actions,
  header,
  label = 'Message',
  inputRef,
  style,
  roomy = false,
}: {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  placeholder: string
  chips?: ReactNode
  // 发送按钮左边的控件，例如发送方式和停止。
  actions?: ReactNode
  // 输入框上方的内容，例如要一起发送的引用。
  header?: ReactNode
  label?: string
  inputRef?: RefObject<HTMLTextAreaElement | null>
  style?: stylex.StyleXStyles
  roomy?: boolean
}) {
  const localRef = useRef<HTMLTextAreaElement | null>(null)
  const empty = value.trim() === ''
  const compact = !chips && !actions
  const ref = inputRef ?? localRef

  useLayoutEffect(() => {
    const input = ref.current
    if (!input) return
    let width = input.clientWidth
    const resize = () => {
      const previous = input.style.height
      input.style.transition = 'none'
      input.style.height = '0px'
      const contentHeight = input.scrollHeight
      const next = `${Math.max(roomy ? 96 : 24, Math.min(contentHeight, 240))}px`
      input.style.overflowY = contentHeight > 240 ? 'auto' : 'hidden'
      input.style.height = previous
      void input.offsetHeight
      input.style.transition = ''
      input.style.height = next
    }
    resize()
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            if (input.clientWidth === width) return
            width = input.clientWidth
            resize()
          })
    observer?.observe(input)
    return () => observer?.disconnect()
  }, [ref, roomy, value])

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    onSend()
  }

  return (
    <div
      {...stylex.props(styles.composer, compact && styles.compact, roomy && styles.roomy, style)}
      onClick={() => ref.current?.focus()}
    >
      {header && (
        <div
          onClick={(event) => event.stopPropagation()}
          {...stylex.props(styles.header, compact && styles.compactHeader)}
        >
          {header}
        </div>
      )}
      <textarea
        ref={ref}
        aria-label={label}
        rows={1}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        {...stylex.props(text.body, styles.input, compact && styles.compactInput, roomy && styles.roomyInput)}
      />
      <div
        {...stylex.props(styles.toolbar, compact && styles.compactToolbar)}
        onClick={(event) => event.stopPropagation()}
      >
        {chips && <div {...stylex.props(styles.chips)}>{chips}</div>}
        <div {...stylex.props(styles.actions)}>
          {actions}
          <button
            type="button"
            aria-label="Send"
            onClick={onSend}
            {...stylex.props(styles.send, empty && styles.sendIdle, focusRing.ring)}
          >
            <Icon name="arrow-up" size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}
