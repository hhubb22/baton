import * as stylex from '@stylexjs/stylex'
import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { shadow } from '../theme/base.stylex'
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
    boxShadow: shadow.composer,
    cursor: 'text',
  },
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
  chips: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px', minWidth: 0 },
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
})

// 输入区：提示文字在上，工具栏在下。Enter 发送，Shift+Enter 换行，输入法组合时不发送。
export function Composer({
  value,
  onChange,
  onSend,
  placeholder,
  chips,
  label = 'Message',
}: {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  placeholder: string
  chips?: ReactNode
  label?: string
}) {
  const localRef = useRef<HTMLTextAreaElement | null>(null)

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    onSend()
  }

  return (
    <div {...stylex.props(styles.composer)} onClick={() => localRef.current?.focus()}>
      <textarea
        ref={localRef}
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
        <button type="button" aria-label="Send" onClick={onSend} {...stylex.props(styles.send, focusRing.ring)}>
          <Icon name="arrow-up" size={16} />
        </button>
      </div>
    </div>
  )
}
