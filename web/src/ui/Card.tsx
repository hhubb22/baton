import * as stylex from '@stylexjs/stylex'
import type { ReactNode } from 'react'
import { colors, space } from '../theme/tokens.stylex'

const styles = stylex.create({
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    padding: space.lg,
    paddingBottom: space.md,
    backgroundColor: colors.surface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.hairline,
    borderRadius: '14px',
    boxShadow: `0 1px 2px ${colors.shadowSoft}, 0 8px 24px ${colors.shadowNear}`,
  },
  flush: { padding: space.xs, gap: 0 },
})

// 卡片只有 Thread 卡片和等你决定的事项两种，共用这个外观。
export function Card({
  children,
  flush,
  label,
  style,
}: {
  children: ReactNode
  flush?: boolean
  label?: string
  style?: stylex.StyleXStyles
}) {
  return (
    <section aria-label={label} {...stylex.props(styles.card, flush && styles.flush, style)}>
      {children}
    </section>
  )
}
