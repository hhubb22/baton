import { Collapsible } from '@base-ui/react/collapsible'
import * as stylex from '@stylexjs/stylex'
import type { ReactNode } from 'react'
import { motion } from '../theme/tokens.stylex'
import { Icon } from './Icon'

const styles = stylex.create({
  panel: {
    height: 'var(--collapsible-panel-height)',
    minWidth: 0,
    // 内容撑开时裁掉溢出，同时给焦点环留出位置。
    overflow: 'clip',
    overflowClipMargin: '4px',
    opacity: 1,
    transitionProperty: 'height, opacity',
    transitionDuration: motion.popover,
    transitionTimingFunction: motion.easeOut,
  },
  hidden: { height: 0, opacity: 0 },
  leaving: { transitionDuration: motion.exit },
  // 系统自动收起时用户没有预期，放慢并用屏幕内移动的曲线，让下方内容平稳上移。
  settling: { transitionDuration: motion.modal, transitionTimingFunction: motion.easeInOut },
  chevron: {
    flexShrink: 0,
    transitionProperty: 'transform',
    transitionDuration: motion.micro,
    transitionTimingFunction: motion.easeOut,
  },
  chevronOpen: { transform: 'rotate(90deg)' },
})

export const Disclosure = Collapsible.Root
export const DisclosureTrigger = Collapsible.Trigger

export function DisclosurePanel({ settling = false, children }: { settling?: boolean; children: ReactNode }) {
  return (
    <Collapsible.Panel
      className={(state) =>
        stylex.props(
          styles.panel,
          (state.transitionStatus === 'starting' || state.transitionStatus === 'ending') && styles.hidden,
          state.transitionStatus === 'ending' && (settling ? styles.settling : styles.leaving),
        ).className ?? ''
      }
    >
      {children}
    </Collapsible.Panel>
  )
}

export function DisclosureChevron({ open }: { open: boolean }) {
  return (
    <Icon name="chevron-right" size={12} style={[styles.chevron, open && styles.chevronOpen] as stylex.StyleXStyles} />
  )
}
