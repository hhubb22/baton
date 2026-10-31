import { Menu as BaseMenu } from '@base-ui/react/menu'
import * as stylex from '@stylexjs/stylex'
import type { ReactElement, ReactNode } from 'react'
import { semantic } from '../theme/semantic.stylex'
import { text } from '../theme/text'
import { radius, shadow, space } from '../theme/tokens.stylex'
import { Icon } from './Icon'
import { StatusDot, type Tone } from './Status'

// 外观转写自 coss ui 的 Menu（MIT）。菜单每天打开上百次，直接出现，不加进出场动画。
const styles = stylex.create({
  positioner: { zIndex: 20, outline: 'none' },
  popup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
    width: 'max-content',
    minWidth: '96px',
    maxWidth: '304px',
    maxHeight: 'var(--available-height)',
    overflowY: 'auto',
    padding: space.xs,
    backgroundColor: semantic.popover,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: semantic.border,
    borderRadius: radius.lg,
    boxShadow: shadow.floating,
    color: semantic.foreground,
    outline: 'none',
  },
  // 两行说明需要足够的行宽，固定宽度
  wide: { width: '304px' },
  // 带搜索框的短列表：下限足够宽，过滤时宽度基本不跳动，长名称仍可撑开
  search: { minWidth: '240px' },
  // 收起的侧栏里触发器很窄，此时由 minWidth 保证可读
  trigger: { width: 'var(--anchor-width)', minWidth: '160px', maxWidth: 'none' },
  option: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    minHeight: '32px',
    paddingInline: space.sm,
    borderRadius: radius.sm,
    cursor: 'default',
    outline: 'none',
    userSelect: 'none',
  },
  highlighted: { backgroundColor: semantic.accent },
  // 两行选项：名称和勾选在第一行，下面一行浅色说明
  optionTall: {
    flexWrap: 'wrap',
    rowGap: '2px',
    paddingBlock: '6px',
  },
  detail: { flexBasis: '100%', color: semantic.mutedForeground },
  name: { flexGrow: 1 },
  note: { color: semantic.faintForeground, whiteSpace: 'nowrap' },
  check: { color: semantic.foreground },
  heading: {
    display: 'flex',
    alignItems: 'center',
    height: '28px',
    paddingTop: '6px',
    paddingInline: space.sm,
    color: semantic.faintForeground,
  },
  rule: {
    height: '1px',
    marginBlock: space.xs,
    marginInline: space.sm,
    borderWidth: 0,
    backgroundColor: semantic.border,
  },
})

export function Menu({
  trigger,
  children,
  width = 'content',
  align = 'start',
  side = 'bottom',
  onOpenChange,
}: {
  trigger: ReactElement
  children: ReactNode
  width?: 'content' | 'search' | 'wide' | 'trigger'
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'bottom' | 'left' | 'right'
  onOpenChange?: (open: boolean) => void
}) {
  return (
    <BaseMenu.Root onOpenChange={onOpenChange}>
      <BaseMenu.Trigger render={trigger} />
      <BaseMenu.Portal>
        <BaseMenu.Positioner side={side} align={align} sideOffset={4} {...stylex.props(styles.positioner)}>
          <BaseMenu.Popup
            {...stylex.props(
              styles.popup,
              width === 'search' && styles.search,
              width === 'wide' && styles.wide,
              width === 'trigger' && styles.trigger,
            )}
          >
            {children}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  )
}

export function MenuOption({
  children,
  leading,
  note,
  detail,
  dot,
  selected,
  onSelect,
}: {
  children: ReactNode
  leading?: ReactNode
  note?: ReactNode
  detail?: ReactNode
  dot?: Tone
  selected?: boolean
  onSelect?: () => void
}) {
  return (
    <BaseMenu.Item
      onClick={onSelect}
      aria-checked={selected === undefined ? undefined : selected}
      className={(state) =>
        stylex.props(
          text.small,
          styles.option,
          detail != null && styles.optionTall,
          state.highlighted && styles.highlighted,
        ).className ?? ''
      }
    >
      {leading}
      {dot && <StatusDot tone={dot} />}
      <span {...stylex.props(styles.name, text.truncate)}>{children}</span>
      {note && <span {...stylex.props(text.caption, styles.note)}>{note}</span>}
      {selected && <Icon name="check" size={14} style={styles.check} />}
      {detail && <span {...stylex.props(text.caption, styles.detail)}>{detail}</span>}
    </BaseMenu.Item>
  )
}

export function MenuHeading({ children }: { children: ReactNode }) {
  return <div {...stylex.props(text.captionMedium, styles.heading)}>{children}</div>
}

export function MenuRule() {
  return <BaseMenu.Separator {...stylex.props(styles.rule)} />
}
