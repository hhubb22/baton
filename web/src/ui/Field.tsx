import * as stylex from '@stylexjs/stylex'
import { createContext, useContext, useId, type ComponentProps, type ReactNode } from 'react'
import { enter } from '../theme/motion'
import { fonts, weight } from '../theme/base.stylex'
import { semantic } from '../theme/semantic.stylex'
import { text } from '../theme/text'
import { motion, radius, shadow, size, space } from '../theme/tokens.stylex'
import { Icon } from './Icon'
import { Toggle } from './Toggle'

// 属性行里的控件去掉边框，由整行承担悬停和焦点。
const RowContext = createContext(false)
export const useInFormRow = () => useContext(RowContext)

// 输入框的焦点样式转写自 coss ui 的 Input（MIT）；边框和底色使用 field 一组 token。
const styles = stylex.create({
  field: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 },
  // 上边线向上错开 1px：第一行的线被面板裁掉，嵌套分组时也只留一条分隔线。
  row: {
    position: 'relative',
    display: 'grid',
    gridTemplateColumns: '128px minmax(0, 1fr)',
    minHeight: '40px',
    minWidth: 0,
    marginTop: '-1px',
    paddingLeft: space.md,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: semantic.border,
    backgroundColor: {
      default: 'transparent',
      ':hover': { default: semantic.muted, ':has(input:read-only, textarea:read-only)': 'transparent' },
    },
    outlineWidth: '2px',
    // 多留 1px，第一行被面板裁掉上边线时焦点框仍然完整。
    outlineOffset: '-3px',
    outlineStyle: { default: 'none', ':focus-within': 'solid' },
    outlineColor: semantic.ring,
  },
  rowInvalid: { outlineColor: semantic.destructiveForeground },
  // 标签撑满行高，点左栏任何位置都能把焦点放进控件。
  rowLabel: { paddingTop: '11px', paddingBottom: '9px', color: semantic.foreground, minWidth: 0 },
  rowLabelInvalid: { color: semantic.destructiveForeground },
  changedDot: {
    position: 'absolute',
    top: '18px',
    left: '4px',
    width: '4px',
    height: '4px',
    borderRadius: radius.pill,
    backgroundColor: semantic.brand,
  },
  rowBody: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  rowNote: { marginTop: '-4px', paddingInline: space.md, paddingBottom: '10px' },
  switchRow: {
    display: 'flex',
    alignItems: 'center',
    gap: space.md,
    paddingBlock: '10px',
    paddingRight: space.md,
    cursor: 'default',
    outlineStyle: 'none',
  },
  switchText: { display: 'flex', flexDirection: 'column', flexGrow: 1, gap: space.xxs, minWidth: 0 },
  plainRow: {
    display: 'flex',
    alignItems: 'center',
    gap: space.md,
    paddingBlock: space.sm,
    paddingRight: space.md,
    backgroundColor: 'transparent',
    outlineStyle: 'none',
  },
  label: { color: semantic.foreground },
  optional: { color: semantic.faintForeground, fontWeight: 400 },
  helper: { color: semantic.mutedForeground },
  error: { display: 'flex', gap: space.xs, color: semantic.destructiveForeground },
  errorIcon: { flexShrink: 0, marginTop: '1px' },
  input: {
    width: '100%',
    height: size.control,
    paddingBlock: 0,
    paddingInline: '11px',
    backgroundColor: semantic.field,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: { default: semantic.fieldBorder, ':hover': semantic.fieldBorderHover, ':focus': semantic.ring },
    borderRadius: radius.md,
    outline: 'none',
    boxShadow: { default: 'none', ':focus': shadow.focus },
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
  mono: { fontFamily: fonts.mono },
  bare: {
    height: '40px',
    paddingInline: space.md,
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderRadius: 0,
    boxShadow: 'none',
  },
  // 文本框从一行开始，随内容长高。
  bareTextarea: {
    height: 'auto',
    minHeight: '40px',
    paddingBlock: '10px',
    resize: 'none',
    fieldSizing: 'content',
  },
  bareLocked: { color: semantic.mutedForeground, cursor: 'default' },
  locked: {
    backgroundColor: semantic.muted,
    borderColor: semantic.border,
    boxShadow: 'none',
    color: semantic.mutedForeground,
  },
  invalid: {
    borderColor: semantic.destructiveForeground,
    boxShadow: { default: 'none', ':focus': shadow.focusDanger },
  },
  section: { display: 'flex', flexDirection: 'column', gap: space.md },
  sectionHead: { display: 'flex', flexDirection: 'column', gap: space.xxs },
  sectionTitle: { fontSize: '14px', fontWeight: weight.semibold, lineHeight: 1.45 },
  sectionDescription: { color: semantic.mutedForeground },
  panel: {
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: semantic.border,
    borderRadius: radius.lg,
    backgroundColor: semantic.card,
    boxShadow: shadow.panel,
  },
  saveBar: { position: 'sticky', bottom: space.lg, zIndex: 10 },
  saveBarOpen: {
    display: 'flex',
    alignItems: 'center',
    gap: space.md,
    minHeight: '48px',
    paddingBlock: space.sm,
    paddingInline: space.lg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: semantic.input,
    borderRadius: radius.lg,
    backgroundColor: semantic.popover,
    boxShadow: shadow.floating,
  },
  saveStatus: {
    display: 'flex',
    alignItems: 'center',
    columnGap: space.md,
    flexGrow: 1,
    minWidth: 0,
    color: semantic.mutedForeground,
  },
})

// stack 用于弹窗。row 是设置页的属性行：整行就是控件，平时只显示值，悬停和获得焦点时才显示范围。
// changed 在标签前标一个点，表示这一项有未保存的修改。
export function Field({
  label,
  optional,
  helper,
  error,
  layout = 'stack',
  changed = false,
  children,
}: {
  label: string
  optional?: boolean
  helper?: ReactNode
  error?: ReactNode
  layout?: 'stack' | 'row'
  changed?: boolean
  children: (props: { id: string; 'aria-invalid'?: true; 'aria-describedby'?: string }) => ReactNode
}) {
  const id = useId()
  const noteId = `${id}-note`
  const errorId = `${id}-error`
  const inRow = layout === 'row'
  const described = [error && errorId, helper && (inRow || !error) && noteId].filter(Boolean).join(' ')
  const labelNode = (
    <label
      htmlFor={id}
      {...stylex.props(
        text.label,
        styles.label,
        inRow && styles.rowLabel,
        inRow && Boolean(error) && styles.rowLabelInvalid,
      )}
    >
      {label}
      {optional && <span {...stylex.props(styles.optional)}> （可选）</span>}
    </label>
  )
  const helperNode = helper && (inRow || !error) && (
    <p id={noteId} {...stylex.props(text.caption, styles.helper, inRow && styles.rowNote)}>
      {helper}
    </p>
  )
  const errorNode = error && (
    <p id={errorId} {...stylex.props(text.caption, styles.error, inRow && styles.rowNote)}>
      <Icon name="alert" size={14} style={styles.errorIcon} />
      {error}
    </p>
  )
  const control = children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': described || undefined })
  if (inRow) {
    return (
      <div {...stylex.props(styles.row, Boolean(error) && styles.rowInvalid)}>
        {changed && <span aria-hidden {...stylex.props(styles.changedDot)} />}
        {labelNode}
        <div {...stylex.props(styles.rowBody)}>
          <RowContext.Provider value>{control}</RowContext.Provider>
          {helperNode}
          {errorNode}
        </div>
      </div>
    )
  }
  return (
    <div {...stylex.props(styles.field)}>
      {labelNode}
      {control}
      {errorNode ?? helperNode}
    </div>
  )
}

// 整行可点，开关靠行尾。
export function SwitchField({
  label,
  helper,
  checked,
  onChange,
}: {
  label: string
  helper?: ReactNode
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label {...stylex.props(styles.row, styles.switchRow)}>
      <span {...stylex.props(styles.switchText)}>
        <span {...stylex.props(text.label, styles.label)}>{label}</span>
        {helper && <span {...stylex.props(text.caption, styles.helper)}>{helper}</span>}
      </span>
      <Toggle label={label} checked={checked} onChange={onChange} />
    </label>
  )
}

// 面板里不是字段的一行：说明、操作按钮。
export function FormRow({ children }: { children: ReactNode }) {
  return <div {...stylex.props(styles.row, styles.plainRow)}>{children}</div>
}

export function FormSection({
  title,
  description,
  children,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <section {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.sectionHead)}>
        <h3 {...stylex.props(styles.sectionTitle)}>{title}</h3>
        {description && <p {...stylex.props(text.small, styles.sectionDescription)}>{description}</p>}
      </div>
      <div {...stylex.props(styles.panel)}>{children}</div>
    </section>
  )
}

// 有内容时贴在滚动区底部。状态区始终挂载，读屏软件才能念出后来写入的状态。
export function SaveBar({ open, status, actions }: { open: boolean; status: ReactNode; actions?: ReactNode }) {
  return (
    <div {...stylex.props(styles.saveBar)}>
      <div {...stylex.props(open && styles.saveBarOpen, open && enter.rise)}>
        <span role="status" {...stylex.props(text.small, styles.saveStatus)}>
          {status}
        </span>
        {open && actions}
      </div>
    </div>
  )
}

type InputProps = Omit<ComponentProps<'input'>, 'className' | 'style'> & {
  style?: stylex.StyleXStyles
  mono?: boolean
}

export function Input({ style, mono = false, ...rest }: InputProps) {
  const bare = useInFormRow()
  const locked = rest.readOnly || rest.disabled
  return (
    <input
      spellCheck={mono ? false : undefined}
      // 属性行平时没有边框，空值要靠占位文字才看得出这里能填。
      placeholder={bare && !locked ? '未填写' : undefined}
      {...rest}
      {...stylex.props(
        text.small,
        styles.input,
        mono && styles.mono,
        bare
          ? [styles.bare, locked && styles.bareLocked]
          : [locked && styles.locked, rest['aria-invalid'] && styles.invalid],
        style,
      )}
    />
  )
}

type TextAreaProps = Omit<ComponentProps<'textarea'>, 'className' | 'style'> & { style?: stylex.StyleXStyles }

export function TextArea({ style, ...rest }: TextAreaProps) {
  const bare = useInFormRow()
  const locked = rest.readOnly || rest.disabled
  return (
    <textarea
      rows={bare ? 1 : undefined}
      placeholder={bare && !locked ? '未填写' : undefined}
      {...rest}
      {...stylex.props(
        text.small,
        styles.input,
        styles.textarea,
        bare
          ? [styles.bare, styles.bareTextarea, locked && styles.bareLocked]
          : [locked && styles.locked, rest['aria-invalid'] && styles.invalid],
        style,
      )}
    />
  )
}
