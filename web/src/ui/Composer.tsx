import * as stylex from '@stylexjs/stylex'
import { useState, type MouseEvent, type ReactNode, type RefObject } from 'react'
import { semantic } from '../theme/semantic.stylex'
import { motion, radius, shadow, space } from '../theme/tokens.stylex'
import { focusRing } from './Button'
import {
  Composer as ComposerEditor,
  ComposerActions,
  ComposerInput,
  getComposerText,
  type ComposerValue,
} from './composer-editor'
import { Icon } from './Icon'

const styles = stylex.create({
  composer: { width: '100%', maxWidth: '712px' },
  // 没有工具栏时，输入和发送按钮排在同一行。
  compact: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    alignItems: 'end',
  },
  roomy: { maxWidth: '840px' },
  project: { maxWidth: '640px' },
  header: { paddingTop: space.sm, paddingInline: space.sm, cursor: 'auto' },
  compactHeader: { gridColumn: '1 / -1' },
  input: { lineHeight: '24px' },
  roomyInput: { minHeight: '104px' },
  chips: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '2px',
    flexGrow: 1,
    minWidth: 0,
    marginLeft: '-4px',
    cursor: 'default',
  },
  actions: { display: 'flex', alignItems: 'center', gap: space.sm, flexShrink: 0, marginLeft: 'auto' },
  send: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '32px',
    height: '32px',
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.md,
    backgroundColor: { default: semantic.primary, ':hover': semantic.primaryHover },
    boxShadow: shadow.filled,
    color: semantic.primaryForeground,
    transform: { default: 'none', ':active': 'scale(0.97)' },
    transitionProperty: 'background-color, transform',
    transitionDuration: motion.micro,
  },
  // 没有内容时按钮变灰，是否发送由页面决定，例如只带引用也可以发。
  sendIdle: {
    backgroundColor: { default: semantic.secondary, ':hover': semantic.secondary },
    boxShadow: 'none',
    color: semantic.faintForeground,
  },
})

const toParts = (value: string): ComposerValue => (value ? [{ type: 'text', text: value }] : [])

const keepFocus = (event: MouseEvent) => event.stopPropagation()

// 页面用的输入区：页面只管文字，编辑器负责草稿结构。Enter 发送，Shift+Enter 换行，输入法组合时不发送。
export function Composer({
  value,
  onChange,
  onSend,
  placeholder,
  chips,
  actions,
  header,
  label = '消息',
  inputRef,
  style,
  roomy = false,
  project = false,
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
  inputRef?: RefObject<HTMLDivElement | null>
  style?: stylex.StyleXStyles
  roomy?: boolean
  project?: boolean
}) {
  const [parts, setParts] = useState<ComposerValue>(() => toParts(value))
  // 页面清空或恢复草稿时，以页面的文字为准。
  const current = getComposerText(parts) === value ? parts : toParts(value)
  const compact = !chips && !actions

  return (
    // 工具栏里有按钮和菜单，根节点用 div，避免它们触发表单提交。
    <ComposerEditor
      render={<div />}
      value={current}
      onValueChange={(next) => {
        setParts(next)
        onChange(getComposerText(next))
      }}
      onSubmit={onSend}
      allowEmpty
      style={[styles.composer, compact && styles.compact, roomy && styles.roomy, project && styles.project, style]}
    >
      {header && (
        <div
          onClick={keepFocus}
          onMouseDown={keepFocus}
          {...stylex.props(styles.header, compact && styles.compactHeader)}
        >
          {header}
        </div>
      )}
      <ComposerInput
        ref={inputRef}
        aria-label={label}
        placeholder={placeholder}
        style={[styles.input, roomy && styles.roomyInput]}
      />
      <ComposerActions>
        {chips && (
          <div onClick={keepFocus} onMouseDown={keepFocus} {...stylex.props(styles.chips)}>
            {chips}
          </div>
        )}
        <div {...stylex.props(styles.actions)}>
          {actions}
          <button
            type="button"
            aria-label="发送"
            onClick={onSend}
            {...stylex.props(styles.send, value.trim() === '' && styles.sendIdle, focusRing.ring)}
          >
            <Icon name="arrow-up" size={16} />
          </button>
        </div>
      </ComposerActions>
    </ComposerEditor>
  )
}
