import * as stylex from '@stylexjs/stylex'
import type { ComponentProps, ReactNode } from 'react'
import { weight } from '../theme/base.stylex'
import { colors, radius, size, space } from '../theme/tokens.stylex'
import { Icon, type IconName } from './Icon'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'dangerSolid'

// 按键材质：从正上方打光，静止和按下都是两层内阴影加两层投影，层数一致才能平滑过渡。
const faceGradient = `linear-gradient(180deg, ${colors.keyTop}, ${colors.keyBottom})`
const pressedGradient = `linear-gradient(180deg, ${colors.keyBottom}, ${colors.keyTop})`
const solidRest = `inset 0 1px 0 ${colors.highlight}, inset 0 -1px 0 ${colors.keyShadeSolid}, 0 1px 2px ${colors.shadowFar}, 0 4px 10px -3px ${colors.keyLiftSolid}`
const solidHover = `inset 0 1px 0 ${colors.highlight}, inset 0 -1px 0 ${colors.keyShadeSolid}, 0 1px 2px ${colors.shadowFar}, 0 8px 16px -5px ${colors.keyLiftSolid}`
const solidPressed = `inset 0 1px 2px ${colors.keyPressSolid}, inset 0 0 0 transparent, 0 1px 1px ${colors.shadowFar}, 0 0 0 transparent`
const lightRest = `inset 0 1px 0 ${colors.keyHighlight}, inset 0 -1px 0 ${colors.keyShade}, 0 1px 2px ${colors.shadowSoft}, 0 4px 10px -3px ${colors.shadowNear}`
const lightHover = `inset 0 1px 0 ${colors.keyHighlight}, inset 0 -1px 0 ${colors.keyShade}, 0 1px 2px ${colors.shadowSoft}, 0 8px 16px -5px ${colors.shadowNear}`
const lightPressed = `inset 0 1px 2px ${colors.keyPress}, inset 0 0 0 transparent, 0 1px 0 ${colors.keyGround}, 0 0 0 transparent`

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
    borderRadius: radius.md,
    fontSize: '13px',
    lineHeight: 1.45,
    fontWeight: weight.medium,
    whiteSpace: 'nowrap',
    userSelect: 'none',
    transform: { default: 'none', ':active': 'translateY(1px)' },
    transitionProperty: 'background-color, border-color, color, box-shadow, transform',
    transitionDuration: '160ms, 160ms, 160ms, 140ms, 120ms',
  },
  small: {
    height: size.compact,
    paddingInline: '10px',
    fontSize: '12px',
  },
  // small 系列不要抬升层，只留贴身投影
  smallKey: {
    boxShadow: {
      default: `inset 0 1px 0 ${colors.keyHighlight}, inset 0 -1px 0 ${colors.keyShade}, 0 1px 2px ${colors.shadowSoft}, 0 0 0 transparent`,
      ':active': lightPressed,
    },
  },
  smallSolid: {
    boxShadow: {
      default: `inset 0 1px 0 ${colors.highlight}, inset 0 -1px 0 ${colors.keyShadeSolid}, 0 1px 2px ${colors.shadowFar}, 0 0 0 transparent`,
      ':active': solidPressed,
    },
  },
  block: { width: '100%' },
  primary: {
    backgroundColor: {
      default: colors.accent,
      ':hover': colors.accentHover,
      ':active': colors.accentPressed,
    },
    backgroundImage: { default: faceGradient, ':active': pressedGradient },
    borderColor: colors.keyEdgeSolid,
    boxShadow: { default: solidRest, ':hover': solidHover, ':active': solidPressed },
    color: colors.onAccent,
  },
  dangerSolid: {
    backgroundColor: colors.dangerFill,
    backgroundImage: { default: faceGradient, ':active': pressedGradient },
    borderColor: colors.keyEdgeSolid,
    boxShadow: { default: solidRest, ':hover': solidHover, ':active': solidPressed },
    color: colors.onAccent,
  },
  secondary: {
    backgroundColor: colors.surface,
    backgroundImage: { default: faceGradient, ':hover': 'none', ':active': pressedGradient },
    borderColor: colors.border,
    boxShadow: { default: lightRest, ':hover': lightHover, ':active': lightPressed },
    color: colors.text,
  },
  ghost: {
    backgroundColor: { default: 'transparent', ':hover': colors.hover, ':active': colors.selected },
    borderColor: 'transparent',
    boxShadow: { default: 'inset 0 0 0 transparent', ':active': `inset 0 1px 2px ${colors.keyShade}` },
    color: colors.text,
  },
  danger: {
    backgroundColor: colors.surface,
    backgroundImage: { default: faceGradient, ':hover': 'none', ':active': pressedGradient },
    borderColor: colors.border,
    boxShadow: { default: lightRest, ':hover': lightHover, ':active': lightPressed },
    color: colors.danger,
  },
  icon: {
    width: size.compact,
    height: size.compact,
    padding: 0,
    borderWidth: 0,
    transform: 'none',
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
        small && (variant === 'secondary' || variant === 'danger') && styles.smallKey,
        small && (variant === 'primary' || variant === 'dangerSolid') && styles.smallSolid,
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
