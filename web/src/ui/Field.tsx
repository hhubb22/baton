import * as stylex from '@stylexjs/stylex'
import { useId, type ComponentProps, type ReactNode } from 'react'
import { text } from '../theme/text'
import { colors, radius, size, space } from '../theme/tokens.stylex'

const styles = stylex.create({
  field: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 },
  label: { color: colors.text },
  optional: { color: colors.faint, fontWeight: 400 },
  helper: { color: colors.muted },
  error: { color: colors.danger },
  input: {
    width: '100%',
    height: size.control,
    paddingBlock: 0,
    paddingInline: '10px',
    backgroundColor: colors.surface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: { default: colors.border, ':focus': colors.focus },
    borderRadius: radius.sm,
    outline: 'none',
    boxShadow: { default: 'none', ':focus': `0 0 0 0.5px ${colors.focus}` },
    color: colors.text,
    '::placeholder': { color: colors.faint },
  },
  textarea: {
    height: 'auto',
    minHeight: '80px',
    paddingBlock: space.sm,
    paddingInline: '10px',
    resize: 'vertical',
  },
  invalid: {
    borderColor: colors.danger,
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
