import * as stylex from '@stylexjs/stylex'
import { weight } from '../theme/base.stylex'
import { colors, hues, radius } from '../theme/tokens.stylex'

export type Hue = 'slate' | 'amber' | 'violet' | 'green' | 'blue' | 'rose'

const styles = stylex.create({
  avatar: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '20px',
    height: '20px',
    borderRadius: '5px',
    color: '#fff',
    fontSize: '11px',
    lineHeight: 1,
    fontWeight: weight.semibold,
  },
  large: { width: '40px', height: '40px', borderRadius: '10px', fontSize: '18px' },
  slate: { backgroundColor: hues.slate },
  amber: { backgroundColor: hues.amber },
  violet: { backgroundColor: hues.violet },
  green: { backgroundColor: hues.green },
  blue: { backgroundColor: hues.blue },
  rose: { backgroundColor: hues.rose },
  agentMark: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '16px',
    height: '16px',
    borderRadius: radius.pill,
    backgroundColor: colors.agentSoft,
  },
  agentCore: { width: '6px', height: '6px', borderRadius: radius.pill, backgroundColor: colors.agent },
  person: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '24px',
    height: '24px',
    borderRadius: radius.pill,
    backgroundColor: colors.subtle,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSoft,
    color: colors.text,
    fontSize: '11px',
    lineHeight: 1,
    fontWeight: weight.medium,
  },
})

function initial(name: string) {
  return name.trim().charAt(0).toUpperCase() || '?'
}

// Project 头像：名称首字母配按创建顺序轮换的底色。
export function Avatar({ name, hue, large }: { name: string; hue: Hue; large?: boolean }) {
  return (
    <span {...stylex.props(styles.avatar, styles[hue], large && styles.large)} aria-hidden>
      {initial(name)}
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
