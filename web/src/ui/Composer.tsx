import * as stylex from '@stylexjs/stylex'
import { useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { text } from '../theme/text'
import { colors, radius, size, space } from '../theme/tokens.stylex'
import { focusRing } from './Button'
import { Icon } from './Icon'

const styles = stylex.create({
  composer: {
    display: 'flex',
    flexDirection: 'column',
    gap: '18px',
    width: '100%',
    maxWidth: size.measure,
    paddingTop: space.lg,
    paddingRight: space.md,
    paddingBottom: space.md,
    paddingLeft: '18px',
    backgroundColor: colors.surface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.hairline,
    borderRadius: '20px',
    boxShadow: `0 1px 2px ${colors.shadowSoft}, 0 8px 24px ${colors.shadowNear}`,
    cursor: 'text',
  },
  header: { cursor: 'auto' },
  input: {
    width: '100%',
    minHeight: '24px',
    maxHeight: '240px',
    padding: 0,
    borderWidth: 0,
    outline: 'none',
    resize: 'none',
    fieldSizing: 'content',
    backgroundColor: 'transparent',
    color: colors.text,
    '::placeholder': { color: colors.faint },
  },
  toolbar: {
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: space.sm,
    cursor: 'default',
  },
  chips: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px', flexGrow: 1, minWidth: 0 },
  actions: { display: 'flex', alignItems: 'center', gap: space.sm, flexShrink: 0 },
  send: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '32px',
    height: '32px',
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.pill,
    backgroundColor: { default: colors.accent, ':hover': colors.accentHover, ':active': colors.accentPressed },
    color: colors.onAccent,
  },
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
}) {
  const localRef = useRef<HTMLTextAreaElement | null>(null)
  const empty = value.trim() === ''
  const ref = inputRef ?? localRef

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    onSend()
  }

  return (
    <div {...stylex.props(styles.composer, style)} onClick={() => ref.current?.focus()}>
      {header && (
        <div onClick={(event) => event.stopPropagation()} {...stylex.props(styles.header)}>
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
        {...stylex.props(text.body, styles.input)}
      />
      <div {...stylex.props(styles.toolbar)} onClick={(event) => event.stopPropagation()}>
        <div {...stylex.props(styles.chips)}>{chips}</div>
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
