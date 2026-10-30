import * as stylex from '@stylexjs/stylex'
import { weight } from '../theme/base.stylex'
import { semantic } from '../theme/semantic.stylex'
import { radius } from '../theme/tokens.stylex'

export type Hue = 'slate' | 'amber' | 'violet' | 'green' | 'blue' | 'rose'

const styles = stylex.create({
  projectEmoji: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '20px',
    height: '20px',
    fontSize: '16px',
    lineHeight: 1,
  },
  projectEmojiSmall: { width: '14px', height: '14px', fontSize: '14px' },
  projectEmojiLarge: { width: '40px', height: '40px', fontSize: '32px' },
  agentMark: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '16px',
    height: '16px',
    borderRadius: radius.pill,
    backgroundColor: semantic.agentSoft,
  },
  agentCore: { width: '6px', height: '6px', borderRadius: radius.pill, backgroundColor: semantic.agent },
  person: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '24px',
    height: '24px',
    borderRadius: radius.pill,
    backgroundColor: semantic.secondary,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: semantic.border,
    color: semantic.foreground,
    fontSize: '11px',
    lineHeight: 1,
    fontWeight: weight.medium,
  },
})

function initial(name: string) {
  return name.trim().charAt(0).toUpperCase() || '?'
}

// Project 图标使用项目保存的 emoji。
export function Avatar({
  emoji = '📁',
  large,
  small,
}: {
  name: string
  hue: Hue
  emoji?: string
  large?: boolean
  small?: boolean
}) {
  return (
    <span
      {...stylex.props(styles.projectEmoji, small && styles.projectEmojiSmall, large && styles.projectEmojiLarge)}
      aria-hidden
    >
      {emoji}
    </span>
  )
}

// Project Agent 的青色标识。
export function AgentMark({ label }: { label?: string }) {
  return (
    <span {...stylex.props(styles.agentMark)} role={label ? 'img' : undefined} aria-label={label} aria-hidden={!label}>
      <span {...stylex.props(styles.agentCore)} />
    </span>
  )
}

export function PersonAvatar({ name }: { name: string }) {
  return (
    <span {...stylex.props(styles.person)} aria-hidden>
      {initial(name)}
    </span>
  )
}
