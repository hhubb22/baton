import * as stylex from '@stylexjs/stylex'
import type { ReactNode } from 'react'
import { semantic } from '../theme/semantic.stylex'
import { text } from '../theme/text'
import { radius, shadow, size } from '../theme/tokens.stylex'

// 状态点只有六种颜色，含义由旁边的文字说明。
export type Tone = 'info' | 'neutral' | 'hollow' | 'success' | 'danger' | 'attention' | 'agent'

const dots = stylex.create({
  base: {
    display: 'inline-block',
    flexShrink: 0,
    width: size.dot,
    height: size.dot,
    borderRadius: radius.pill,
  },
  info: { backgroundColor: semantic.brand },
  neutral: { backgroundColor: semantic.faintForeground },
  hollow: { boxShadow: `inset 0 0 0 1.2px ${semantic.faintForeground}` },
  success: { backgroundColor: semantic.success },
  danger: { backgroundColor: semantic.destructiveForeground },
  attention: { backgroundColor: semantic.warning },
  agent: { backgroundColor: semantic.agent },
})

export function StatusDot({ tone, label }: { tone: Tone; label?: string }) {
  return (
    <span
      {...stylex.props(dots.base, dots[tone])}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  )
}

const pills = stylex.create({
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    height: size.micro,
    paddingInline: '8px',
    borderRadius: radius.pill,
    color: semantic.foreground,
    whiteSpace: 'nowrap',
  },
  info: { backgroundColor: semantic.brandSoft },
  neutral: { backgroundColor: semantic.secondary },
  hollow: { backgroundColor: semantic.secondary },
  success: { backgroundColor: semantic.successSoft },
  danger: { backgroundColor: semantic.destructiveSoft },
  attention: { backgroundColor: semantic.warningSoft },
  agent: { backgroundColor: semantic.agentSoft },
  quiet: { color: semantic.mutedForeground },
})

export function StatusPill({ tone, quiet, children }: { tone: Tone; quiet?: boolean; children: ReactNode }) {
  return (
    <span {...stylex.props(text.caption, pills.base, pills[tone], quiet && pills.quiet)}>
      <StatusDot tone={tone} />
      {children}
    </span>
  )
}

const chips = stylex.create({
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    height: size.compact,
    paddingInline: '10px',
    borderRadius: radius.pill,
    backgroundColor: semantic.card,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: semantic.border,
    boxShadow: shadow.control,
  },
  count: { color: semantic.faintForeground },
})

// 输入区上方的状态片：汇总执行中、等待设备和等你决定的数量。
export function StatusChip({ tone, label, count }: { tone: Tone; label: string; count?: number }) {
  return (
    <span {...stylex.props(text.small, chips.base)}>
      <StatusDot tone={tone} />
      {label}
      {count !== undefined && <span {...stylex.props(text.mono, chips.count)}>{count}</span>}
    </span>
  )
}
