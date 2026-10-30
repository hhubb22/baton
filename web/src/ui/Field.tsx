import * as stylex from '@stylexjs/stylex'
import { useId, type ComponentProps, type ReactNode } from 'react'
import { semantic } from '../theme/semantic.stylex'
import { text } from '../theme/text'
import { motion, radius, shadow, size, space } from '../theme/tokens.stylex'

// 输入框的边框、阴影和焦点转写自 coss ui 的 Input（MIT）。
const styles = stylex.create({
  field: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 },
  label: { color: semantic.foreground },
  optional: { color: semantic.faintForeground, fontWeight: 400 },
  helper: { color: semantic.mutedForeground },
  error: { color: semantic.destructiveForeground },
  input: {
    width: '100%',
    height: size.control,
    paddingBlock: 0,
    paddingInline: '11px',
    backgroundColor: semantic.card,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: { default: semantic.input, ':focus': semantic.ring },
    borderRadius: radius.md,
    outline: 'none',
    boxShadow: { default: shadow.control, ':focus': shadow.focus },
    color: semantic.foreground,
    transitionProperty: 'border-color, box-shadow',
    transitionDuration: motion.micro,
    '::placeholder': { color: semantic.faintForeground },
  },
  textarea: {
    height: 'auto',
    minHeight: '80px',
    paddingBlock: space.sm,
    resize: 'vertical',
  },
  invalid: {
    borderColor: semantic.destructiveForeground,
    boxShadow: { default: 'none', ':focus': shadow.focusDanger },
  },
})

export function Field({
  label,
  optional,
  helper,
  error,
  children,
}: {
  label: string
  optional?: boolean
  helper?: ReactNode
  error?: ReactNode
  children: (props: { id: string; 'aria-invalid'?: true; 'aria-describedby'?: string }) => ReactNode
}) {
  const id = useId()
  const noteId = `${id}-note`
  const note = error ?? helper
  return (
    <div {...stylex.props(styles.field)}>
      <label htmlFor={id} {...stylex.props(text.label, styles.label)}>
        {label}
        {optional && <span {...stylex.props(styles.optional)}> （可选）</span>}
      </label>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': note ? noteId : undefined })}
      {note && (
        <p id={noteId} {...stylex.props(text.caption, error ? styles.error : styles.helper)}>
          {note}
        </p>
      )}
    </div>
  )
}

type InputProps = Omit<ComponentProps<'input'>, 'className' | 'style'> & { style?: stylex.StyleXStyles }

export function Input({ style, ...rest }: InputProps) {
  return <input {...rest} {...stylex.props(text.small, styles.input, rest['aria-invalid'] && styles.invalid, style)} />
}

type TextAreaProps = Omit<ComponentProps<'textarea'>, 'className' | 'style'> & { style?: stylex.StyleXStyles }

export function TextArea({ style, ...rest }: TextAreaProps) {
  return (
    <textarea
      {...rest}
      {...stylex.props(text.small, styles.input, styles.textarea, rest['aria-invalid'] && styles.invalid, style)}
    />
  )
}
