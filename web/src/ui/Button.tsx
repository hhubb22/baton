import * as stylex from '@stylexjs/stylex'
import type { ComponentProps, ReactNode } from 'react'
import { weight } from '../theme/base.stylex'
import { semantic } from '../theme/semantic.stylex'
import { motion, radius, shadow, size } from '../theme/tokens.stylex'
import { Icon, type IconName } from './Icon'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'dangerSolid'

export const focusRing = stylex.create({
  ring: {
    outline: {
      default: 'none',
      ':focus-visible': `2px solid ${semantic.ring}`,
    },
    outlineOffset: '1px',
  },
})

// 结构和状态转写自 coss ui 的 Button（MIT），变体名沿用 Baton 页面已有的调用。
const styles = stylex.create({
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
    flexShrink: 0,
    height: size.control,
    paddingBlock: 0,
    paddingInline: '11px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderRadius: radius.md,
    fontSize: '13px',
    lineHeight: 1.45,
    fontWeight: weight.medium,
    whiteSpace: 'nowrap',
    userSelect: 'none',
    transform: { default: 'none', ':active': 'scale(0.97)' },
    transitionProperty: 'background-color, border-color, color, box-shadow, transform',
    transitionDuration: motion.micro,
    transitionTimingFunction: motion.easeOut,
    opacity: { default: 1, ':disabled': 0.64 },
  },
  small: {
    height: size.compact,
    gap: '4px',
    paddingInline: '9px',
    fontSize: '12px',
  },
  block: { width: '100%' },
  primary: {
    backgroundColor: { default: semantic.primary, ':hover': semantic.primaryHover },
    borderColor: semantic.primary,
    boxShadow: { default: shadow.filled, ':active': 'none' },
    color: semantic.primaryForeground,
  },
  dangerSolid: {
    backgroundColor: semantic.destructive,
    borderColor: semantic.destructive,
    boxShadow: { default: shadow.filled, ':active': 'none' },
    color: semantic.brandOn,
  },
  secondary: {
    backgroundColor: { default: semantic.popover, ':hover': semantic.secondary },
    borderColor: semantic.input,
    boxShadow: { default: shadow.control, ':active': 'none' },
    color: semantic.foreground,
  },
  ghost: {
    backgroundColor: { default: 'transparent', ':hover': semantic.accent },
    borderColor: 'transparent',
    color: semantic.foreground,
  },
  danger: {
    backgroundColor: { default: semantic.popover, ':hover': semantic.destructiveSoft },
    borderColor: semantic.input,
    boxShadow: { default: shadow.control, ':active': 'none' },
    color: semantic.destructiveForeground,
  },
  icon: {
    width: size.compact,
    height: size.compact,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: 'transparent', ':hover': semantic.accent },
    color: { default: semantic.mutedForeground, ':hover': semantic.foreground },
  },
  iconActive: {
    backgroundColor: semantic.accent,
    color: semantic.foreground,
  },
})

type ButtonProps = Omit<ComponentProps<'button'>, 'className' | 'style'> & {
  variant?: ButtonVariant
  small?: boolean
  block?: boolean
  icon?: IconName
  style?: stylex.StyleXStyles
}

// 不可用的操作通常仍然可以点击，由调用方在 onClick 里说明原因；真正传 disabled 时才显示为半透明。
export function Button({
  variant = 'secondary',
  small,
  block,
  icon,
  style,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      {...rest}
      {...stylex.props(
        styles.base,
        styles[variant],
        small && styles.small,
        block && styles.block,
        focusRing.ring,
        style,
      )}
    >
      {icon && <Icon name={icon} size={15} />}
      {children}
    </button>
  )
}

type IconButtonProps = Omit<ComponentProps<'button'>, 'className' | 'style' | 'children'> & {
  icon: IconName
  label: string
  iconSize?: ComponentProps<typeof Icon>['size']
  active?: boolean
  style?: stylex.StyleXStyles
  children?: ReactNode
}

export function IconButton({ icon, label, iconSize = 16, active, style, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      {...rest}
      {...stylex.props(styles.base, styles.icon, active && styles.iconActive, focusRing.ring, style)}
    >
      <Icon name={icon} size={iconSize} />
    </button>
  )
}
