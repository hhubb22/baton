import * as stylex from '@stylexjs/stylex'
import type { ComponentProps } from 'react'
import { weight } from '../theme/base.stylex'
import { semantic } from '../theme/semantic.stylex'
import { radius, shadow, space } from '../theme/tokens.stylex'

// 转写自 coss ui 的 Frame（MIT）。用于设置分组、Project 概览和工具结果这类成组内容，面板里不再嵌套卡片。
const styles = stylex.create({
  frame: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.xs,
    padding: space.xs,
    borderRadius: radius.xl,
    backgroundColor: semantic.muted,
  },
  panel: {
    padding: '20px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: semantic.border,
    borderRadius: radius.lg,
    backgroundColor: semantic.card,
    boxShadow: shadow.panel,
  },
  header: { display: 'flex', flexDirection: 'column', paddingBlock: space.md, paddingInline: '20px' },
  title: { fontSize: '14px', fontWeight: weight.semibold, lineHeight: 1.45 },
  description: { color: semantic.mutedForeground, fontSize: '13px', lineHeight: 1.5 },
  footer: { paddingBlock: space.md, paddingInline: '20px' },
})

type DivProps = Omit<ComponentProps<'div'>, 'className' | 'style'> & { style?: stylex.StyleXStyles }

export function Frame({ style, ...rest }: DivProps) {
  return <div {...rest} {...stylex.props(styles.frame, style)} />
}

export function FramePanel({ style, ...rest }: DivProps) {
  return <div {...rest} {...stylex.props(styles.panel, style)} />
}

export function FrameHeader({ style, ...rest }: DivProps) {
  return <div {...rest} {...stylex.props(styles.header, style)} />
}

export function FrameTitle({ style, ...rest }: DivProps) {
  return <div {...rest} {...stylex.props(styles.title, style)} />
}

export function FrameDescription({ style, ...rest }: DivProps) {
  return <div {...rest} {...stylex.props(styles.description, style)} />
}

export function FrameFooter({ style, ...rest }: DivProps) {
  return <div {...rest} {...stylex.props(styles.footer, style)} />
}
