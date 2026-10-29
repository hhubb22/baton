import * as stylex from '@stylexjs/stylex'
import type { ReactNode } from 'react'
import { weight } from '../theme/base.stylex'
import { colors, radius, size } from '../theme/tokens.stylex'

const styles = stylex.create({
  count: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: colors.muted,
    fontSize: '12px',
    lineHeight: 1,
    fontWeight: weight.medium,
    fontVariantNumeric: 'tabular-nums',
  },
  tag: {
    display: 'inline-flex',
    alignItems: 'center',
    height: '18px',
    paddingInline: '6px',
    borderRadius: radius.inner,
    backgroundColor: colors.subtle,
    color: colors.muted,
    fontSize: '11px',
    lineHeight: 1,
    whiteSpace: 'nowrap',
  },
  tagAgent: { backgroundColor: colors.agentSoft, color: colors.agentText },
  tagAttention: { backgroundColor: colors.attentionSoft, color: colors.attentionText },
  unread: {
    display: 'inline-block',
    width: size.dot,
    height: size.dot,
    borderRadius: radius.pill,
    backgroundColor: colors.accentText,
  },
})

export function Count({ value, label }: { value: number; label?: string }) {
  return (
    <span {...stylex.props(styles.count)} aria-label={label}>
      {value > 9 ? '9+' : value}
    </span>
  )
}

export function Tag({ tone, children }: { tone?: 'agent' | 'attention'; children: ReactNode }) {
  return (
    <span
      {...stylex.props(styles.tag, tone === 'agent' && styles.tagAgent, tone === 'attention' && styles.tagAttention)}
    >
      {children}
    </span>
  )
}

export function UnreadDot({ label = 'Unread' }: { label?: string }) {
  return <span {...stylex.props(styles.unread)} role="img" aria-label={label} />
}
