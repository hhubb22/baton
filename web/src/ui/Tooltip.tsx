import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip'
import * as stylex from '@stylexjs/stylex'
import type { ReactElement, ReactNode } from 'react'
import { semantic } from '../theme/semantic.stylex'
import { motion, radius, shadow } from '../theme/tokens.stylex'

// 转写自 coss ui 的 Tooltip（MIT）。第一个等待 600 ms，连续悬停时后面的立即出现且不播放进场。
const styles = stylex.create({
  positioner: { zIndex: 40 },
  popup: {
    maxWidth: '280px',
    paddingBlock: '4px',
    paddingInline: '8px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: semantic.border,
    borderRadius: radius.md,
    backgroundColor: semantic.popover,
    boxShadow: shadow.floating,
    color: semantic.foreground,
    fontSize: '12px',
    lineHeight: 1.45,
    textWrap: 'balance',
    transformOrigin: 'var(--transform-origin)',
    transitionProperty: 'opacity, transform',
    transitionDuration: motion.popover,
    transitionTimingFunction: motion.easeOut,
  },
  hidden: { opacity: 0, transform: 'scale(0.98)' },
  leaving: { transitionDuration: motion.exit },
  instant: { transitionDuration: '0ms' },
})

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <BaseTooltip.Provider delay={600}>{children}</BaseTooltip.Provider>
}

export function Tooltip({
  label,
  children,
  side = 'top',
  align = 'center',
}: {
  label: ReactNode
  children: ReactElement<Record<string, unknown>>
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
}) {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} align={align} sideOffset={4} {...stylex.props(styles.positioner)}>
          <BaseTooltip.Popup
            className={(state) =>
              stylex.props(
                styles.popup,
                state.transitionStatus !== undefined && styles.hidden,
                state.transitionStatus === 'ending' && styles.leaving,
                state.instant !== undefined && styles.instant,
              ).className ?? ''
            }
          >
            {label}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  )
}
