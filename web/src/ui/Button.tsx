import * as stylex from '@stylexjs/stylex'
import type { ComponentProps, ReactNode } from 'react'
import { weight } from '../theme/base.stylex'
import { colors, radius, size, space } from '../theme/tokens.stylex'
import { Icon, type IconName } from './Icon'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export const focusRing = stylex.create({
  ring: {
    outline: {
      default: 'none',
      ':focus-visible': `2px solid ${colors.focus}`,
    },
    outlineOffset: '2px',
  },
})

const styles = stylex.create({
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
    flexShrink: 0,
    height: size.control,
    paddingBlock: 0,
    paddingInline: space.md,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderRadius: radius.sm,
    fontSize: '13px',
    lineHeight: 1.45,
    fontWeight: weight.medium,
    whiteSpace: 'nowrap',
    userSelect: 'none',
    transitionProperty: 'background-color, border-color, color',
    transitionDuration: '120ms',
  },
  small: {
    height: size.compact,
    paddingInline: '10px',
    fontSize: '12px',
  },
  block: { width: '100%' },
  primary: {
    backgroundColor: {
      default: colors.accent,
      ':hover': colors.accentHover,
      ':active': colors.accentPressed,
    },
    borderColor: 'transparent',
    color: colors.onAccent,
  },
  secondary: {
    backgroundColor: { default: colors.surface, ':hover': colors.subtle },
    borderColor: colors.border,
    color: colors.text,
  },
  ghost: {
    backgroundColor: { default: 'transparent', ':hover': colors.hover },
    borderColor: 'transparent',
    color: colors.text,
  },
  danger: {
    backgroundColor: { default: colors.surface, ':hover': colors.dangerSoft },
    borderColor: colors.border,
    color: colors.danger,
  },
  icon: {
    width: size.compact,
    height: size.compact,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: 'transparent', ':hover': colors.hover },
    color: { default: colors.muted, ':hover': colors.text },
  },
  iconActive: {
    backgroundColor: colors.selected,
    color: colors.text,
  },
})

type ButtonProps = Omit<ComponentProps<'button'>, 'className' | 'style'> & {
  variant?: ButtonVariant
  small?: boolean
  block?: boolean
  icon?: IconName
  style?: stylex.StyleXStyles
}

// 不可用的操作仍然可以点击，由调用方在 onClick 里说明原因，所以这里没有禁用态样式。
export function Button({ variant = 'secondary', small, block, icon, style, children, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      {...rest}
      {...stylex.props(styles.base, styles[variant], small && styles.small, block && styles.block, focusRing.ring, style)}
    >
      {icon && <Icon name={icon} size={15} />}
      {children}
    </button>
  )
}

type IconButtonProps = Omit<ComponentProps<'button'>, 'className' | 'style' | 'children'> & {
  icon: IconName
  label: string
  active?: boolean
  style?: stylex.StyleXStyles
  children?: ReactNode
}

export function IconButton({ icon, label, active, style, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      {...rest}
      {...stylex.props(styles.base, styles.icon, active && styles.iconActive, focusRing.ring, style)}
    >
      <Icon name={icon} size={16} />
    </button>
  )
}
