import * as stylex from '@stylexjs/stylex'
import type { ComponentProps } from 'react'
import { text } from '../theme/text'
import { colors, radius, size } from '../theme/tokens.stylex'
import { focusRing } from './Button'
import { Icon, type IconName } from './Icon'

const styles = stylex.create({
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    height: size.compact,
    maxWidth: '100%',
    paddingInline: '8px',
    borderWidth: 0,
    borderRadius: radius.pill,
    backgroundColor: { default: 'transparent', ':hover': colors.hover },
    color: colors.text,
  },
  glyph: { color: colors.muted },
  caret: { color: colors.faint },
})

type ChipProps = Omit<ComponentProps<'button'>, 'className' | 'style'> & {
  icon?: IconName
  caret?: boolean
}

// 输入区工具栏里的全圆角选择片，例如位置和模型。
export function Chip({ icon, caret = true, children, type = 'button', ...rest }: ChipProps) {
  return (
    <button type={type} {...rest} {...stylex.props(text.small, styles.chip, focusRing.ring)}>
      {icon && <Icon name={icon} size={15} style={styles.glyph} />}
      <span {...stylex.props(text.truncate)}>{children}</span>
      {caret && <Icon name="chevron-down" size={12} style={styles.caret} />}
    </button>
  )
}
