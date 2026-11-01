import * as stylex from '@stylexjs/stylex'
import type { ComponentProps, ReactNode } from 'react'
import { semantic } from '../theme/semantic.stylex'
import { text } from '../theme/text'
import { radius, size, space } from '../theme/tokens.stylex'
import { focusRing } from './Button'
import { Icon, type IconName } from './Icon'

const styles = stylex.create({
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    height: '24px',
    maxWidth: '100%',
    paddingInline: '6px',
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: 'transparent', ':hover': semantic.accent },
    color: semantic.foreground,
  },
  glyph: { color: semantic.mutedForeground },
  caret: { color: semantic.faintForeground },
  composer: { height: size.compact, paddingInline: '6px', borderRadius: radius.sm, fontSize: '13px' },
  // 列表上方的筛选：和列表卡片同样的底色和边框。1px 边框、12px 内边距、16px 图标和 8px 间距也与列表行相同，
  // 第一个筛选的左缘贴齐卡片左缘时，图标和文字仍落在行的对齐线上。
  filter: {
    gap: space.sm,
    height: size.control,
    paddingLeft: space.md,
    paddingRight: space.sm,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: { default: semantic.input, ':hover': semantic.fieldBorderHover },
    borderRadius: radius.md,
    backgroundColor: semantic.card,
  },
  // 未筛选时文字用灰色，选了具体条件才用前景色并加底色。
  filterIdle: { color: semantic.mutedForeground },
  filterActive: { backgroundColor: semantic.accent },
})

type ChipProps = Omit<ComponentProps<'button'>, 'className' | 'style'> & {
  icon?: IconName
  leading?: ReactNode
  caret?: boolean
  composer?: boolean
  filter?: 'idle' | 'active'
}

// 输入区工具栏里的全圆角选择片，例如位置和模型。
export function Chip({
  icon,
  leading,
  caret = true,
  composer = false,
  filter,
  children,
  type = 'button',
  ...rest
}: ChipProps) {
  return (
    <button
      type={type}
      {...rest}
      {...stylex.props(
        text.small,
        styles.chip,
        composer && styles.composer,
        filter && styles.filter,
        filter === 'idle' && styles.filterIdle,
        filter === 'active' && styles.filterActive,
        focusRing.ring,
      )}
    >
      {leading ?? (icon && <Icon name={icon} size={composer || filter ? 16 : 15} style={styles.glyph} />)}
      <span {...stylex.props(text.truncate)}>{children}</span>
      {caret && <Icon name="chevron-down" size={12} style={styles.caret} />}
    </button>
  )
}
