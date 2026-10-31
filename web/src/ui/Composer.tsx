import * as stylex from '@stylexjs/stylex'
import { useState, type MouseEvent, type ReactNode, type RefObject } from 'react'
import { semantic } from '../theme/semantic.stylex'
import { text } from '../theme/text'
import { motion, radius, shadow, size, space } from '../theme/tokens.stylex'
import { focusRing } from './Button'
import {
  Composer as ComposerEditor,
  ComposerActions,
  ComposerInput,
  getComposerText,
  type ComposerValue,
} from './composer-editor'
import { Icon, type IconName } from './Icon'

const styles = stylex.create({
  composer: { width: '100%', maxWidth: '712px' },
  // 方案 B 托盘底座：外框 16px 圆角 + 4px 内边距，包裹内层 12px 圆角输入卡片与下部设备/目录栏。
  tray: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    maxWidth: '712px',
    padding: space.xs,
    borderRadius: radius.xl,
    backgroundColor: semantic.secondary,
  },
  composerInTray: { width: '100%', maxWidth: 'none' },
  trayFooter: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '2px',
    minHeight: '30px',
    paddingTop: space.xs,
    paddingBottom: space.xxs,
    paddingInline: '6px',
    color: semantic.mutedForeground,
  },
  trayItem: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    height: '24px',
    minWidth: 0,
    paddingInline: '6px',
    color: semantic.mutedForeground,
  },
  trayItemIcon: { color: semantic.faintForeground },
  trayEnd: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space.xs,
    marginLeft: 'auto',
  },
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
  roomyInput: { minHeight: '96px' },
  chips: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '2px',
    flexGrow: 1,
    minWidth: 0,
    cursor: 'default',
  },
  actions: { display: 'flex', alignItems: 'center', gap: space.sm, flexShrink: 0, marginLeft: 'auto' },
  send: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: size.compact,
    height: size.compact,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.sm,
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

// 下部托盘里的只读位置信息项（设备名、工作目录），与上方 Chip 图标共用同一条 16px 左基准线。
export function ComposerTrayItem({ icon, children }: { icon?: IconName; children: ReactNode }) {
  return (
    <span {...stylex.props(text.caption, styles.trayItem)}>
      {icon && <Icon name={icon} size={14} style={styles.trayItemIcon} />}
      {children}
    </span>
  )
}

export function ComposerTrayEnd({ children }: { children: ReactNode }) {
  return <span {...stylex.props(styles.trayEnd)}>{children}</span>
}

// 页面用的输入区：页面只管文字，编辑器负责草稿结构。Enter 发送，Shift+Enter 换行，输入法组合时不发送。
export function Composer({
  value,
  onChange,
  onSend,
  placeholder,
  chips,
  actions,
  header,
  footer,
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
  // 输入卡片下方的托盘栏（方案 B），例如设备与目录选择或当前 Thread 所在位置。
  footer?: ReactNode
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

  const editor = (
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
      style={[
        footer ? styles.composerInTray : styles.composer,
        compact && styles.compact,
        !footer && roomy && styles.roomy,
        !footer && project && styles.project,
        !footer && style,
      ]}
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
            <Icon name="arrow-up" size={15} />
          </button>
        </div>
      </ComposerActions>
    </ComposerEditor>
  )

  if (!footer) return editor

  return (
    <div {...stylex.props(styles.tray, roomy && styles.roomy, project && styles.project, style)}>
      {editor}
      <div {...stylex.props(text.caption, styles.trayFooter)}>{footer}</div>
    </div>
  )
}
