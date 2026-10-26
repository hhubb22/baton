import { Menu as BaseMenu } from '@base-ui/react/menu'
import * as stylex from '@stylexjs/stylex'
import type { ReactElement, ReactNode } from 'react'
import { text } from '../theme/text'
import { colors, radius, space } from '../theme/tokens.stylex'
import { Icon } from './Icon'
import { StatusDot, type Tone } from './Status'

const styles = stylex.create({
  positioner: { zIndex: 20, outline: 'none' },
  popup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
    width: '304px',
    maxHeight: 'var(--available-height)',
    overflowY: 'auto',
    padding: space.xs,
    backgroundColor: colors.surface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    borderRadius: radius.md,
    boxShadow: `0 8px 24px ${colors.shadowFar}`,
    color: colors.text,
    outline: 'none',
  },
  narrow: { width: '232px' },
  option: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    height: '32px',
    paddingInline: space.sm,
    borderRadius: radius.sm,
    cursor: 'default',
    outline: 'none',
    userSelect: 'none',
  },
  highlighted: { backgroundColor: colors.hover },
  // 两行选项：名称和勾选在第一行，下面一行浅色说明
  optionTall: {
    flexWrap: 'wrap',
    rowGap: '2px',
    height: 'auto',
    paddingBlock: '6px',
  },
  detail: { flexBasis: '100%', color: colors.muted },
  name: { flexGrow: 1 },
  note: { color: colors.faint, whiteSpace: 'nowrap' },
  check: { color: colors.text },
  heading: {
    display: 'flex',
    alignItems: 'center',
    height: '28px',
    paddingTop: '6px',
    paddingInline: space.sm,
    color: colors.faint,
  },
  rule: {
    height: '1px',
    marginBlock: space.xs,
    borderWidth: 0,
    backgroundColor: colors.borderSoft,
  },
})

export function Menu({
  trigger,
  children,
  narrow,
  align = 'start',
  side = 'bottom',
}: {
  trigger: ReactElement
  children: ReactNode
  narrow?: boolean
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'bottom' | 'left' | 'right'
}) {
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger render={trigger} />
      <BaseMenu.Portal>
        <BaseMenu.Positioner side={side} align={align} sideOffset={6} {...stylex.props(styles.positioner)}>
          <BaseMenu.Popup {...stylex.props(styles.popup, narrow && styles.narrow)}>{children}</BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  )
}

export function MenuOption({
  children,
  note,
  detail,
  dot,
  selected,
  onSelect,
}: {
  children: ReactNode
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
