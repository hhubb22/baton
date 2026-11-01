import { Select as BaseSelect } from '@base-ui/react/select'
import * as stylex from '@stylexjs/stylex'
import { semantic } from '../theme/semantic.stylex'
import { text } from '../theme/text'
import { motion, radius, shadow, size, space } from '../theme/tokens.stylex'
import { focusRing } from './Button'
import { useInFormRow } from './Field'
import { Icon } from './Icon'

// 转写自 coss ui 的 Select（MIT），触发器和 Input 同高同边框。
const styles = stylex.create({
  trigger: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    width: '100%',
    height: size.control,
    paddingBlock: 0,
    paddingInline: '11px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: { default: semantic.fieldBorder, ':hover': semantic.fieldBorderHover },
    borderRadius: radius.md,
    backgroundColor: semantic.field,
    color: semantic.foreground,
    textAlign: 'start',
    transitionProperty: 'border-color',
    transitionDuration: motion.micro,
  },
  invalid: { borderColor: semantic.destructiveForeground },
  bare: {
    height: '40px',
    paddingInline: space.md,
    borderWidth: 0,
    borderRadius: 0,
    backgroundColor: 'transparent',
    outline: 'none',
  },
  caret: { color: semantic.faintForeground, flexShrink: 0 },
  positioner: { zIndex: 40, outline: 'none' },
  popup: {
    minWidth: 'var(--anchor-width)',
    maxHeight: 'var(--available-height)',
    overflowY: 'auto',
    padding: space.xs,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: semantic.border,
    borderRadius: radius.lg,
    backgroundColor: semantic.popover,
    boxShadow: shadow.floating,
    color: semantic.foreground,
    outline: 'none',
    transformOrigin: 'var(--transform-origin)',
    transitionProperty: 'opacity, transform',
    transitionDuration: motion.popover,
    transitionTimingFunction: motion.easeOut,
  },
  popupHidden: { opacity: 0, transform: 'scale(0.98)' },
  leaving: { transitionDuration: motion.exit },
  item: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    minHeight: '32px',
    paddingInline: space.sm,
    borderRadius: radius.sm,
    cursor: 'default',
    outline: 'none',
    userSelect: 'none',
  },
  highlighted: { backgroundColor: semantic.accent },
  groupLabel: { paddingBlock: space.xs, paddingInline: space.sm, color: semantic.faintForeground },
  placeholder: { color: semantic.faintForeground },
})

export type SelectOption<T extends string> = { value: T; label: string }

export type SelectGroup<T extends string> = { label: string; options: readonly SelectOption<T>[] }

export function Select<T extends string>({
  options,
  groups,
  value,
  onChange,
  placeholder,
  ...rest
}: {
  options?: readonly SelectOption<T>[]
  groups?: readonly SelectGroup<T>[]
  value: T | null
  onChange: (value: T) => void
  placeholder?: string
  id?: string
  'aria-label'?: string
  'aria-invalid'?: true
  'aria-describedby'?: string
}) {
  const bare = useInFormRow()
  const all = [...(options ?? []), ...(groups ?? []).flatMap((group) => group.options)]
  const selected = all.find((option) => option.value === value)
  const items = (list: readonly SelectOption<T>[]) =>
    list.map((option) => (
      <BaseSelect.Item
        key={option.value}
        value={option.value}
        className={(state) =>
          stylex.props(text.small, styles.item, state.highlighted && styles.highlighted).className ?? ''
        }
      >
        <BaseSelect.ItemText>{option.label}</BaseSelect.ItemText>
        <BaseSelect.ItemIndicator>
          <Icon name="check" size={14} />
        </BaseSelect.ItemIndicator>
      </BaseSelect.Item>
    ))
  return (
    // Base UI 在选项变化后发现当前值不在列表里时，会自己把值改回初始值并触发 onValueChange，
    // 联动的模型列表因此会悄悄改掉用户的选择。选项集合变化时重新挂载，值只由用户的操作改变。
    <BaseSelect.Root
      key={all.map((option) => option.value).join('\n')}
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next)
      }}
    >
      <BaseSelect.Trigger
        {...rest}
        {...stylex.props(
          text.small,
          styles.trigger,
          bare ? styles.bare : [rest['aria-invalid'] && styles.invalid, focusRing.ring],
        )}
      >
        <span {...stylex.props(text.truncate, !selected && styles.placeholder)}>{selected?.label ?? placeholder}</span>
        <Icon name="chevron-down" size={14} style={styles.caret} />
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={4} alignItemWithTrigger={false} {...stylex.props(styles.positioner)}>
          <BaseSelect.Popup
            className={(state) =>
              stylex.props(
                styles.popup,
                state.transitionStatus !== undefined && styles.popupHidden,
                state.transitionStatus === 'ending' && styles.leaving,
              ).className ?? ''
            }
          >
            <BaseSelect.List>
              {options && items(options)}
              {groups
                ?.filter((group) => group.options.length > 0)
                .map((group) => (
                  <BaseSelect.Group key={group.label}>
                    <BaseSelect.GroupLabel {...stylex.props(text.caption, styles.groupLabel)}>
                      {group.label}
                    </BaseSelect.GroupLabel>
                    {items(group.options)}
                  </BaseSelect.Group>
                ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  )
}
