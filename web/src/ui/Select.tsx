import { Select as BaseSelect } from '@base-ui/react/select'
import * as stylex from '@stylexjs/stylex'
import { semantic } from '../theme/semantic.stylex'
import { text } from '../theme/text'
import { radius, shadow, size, space } from '../theme/tokens.stylex'
import { focusRing } from './Button'
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
    borderColor: semantic.input,
    borderRadius: radius.md,
    backgroundColor: { default: semantic.card, ':hover': semantic.secondary },
    boxShadow: shadow.control,
    color: semantic.foreground,
    textAlign: 'start',
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
  },
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
  placeholder: { color: semantic.faintForeground },
})

export type SelectOption<T extends string> = { value: T; label: string }

export function Select<T extends string>({
  options,
  value,
  onChange,
  placeholder,
  ...rest
}: {
  options: readonly SelectOption<T>[]
  value: T | null
  onChange: (value: T) => void
  placeholder?: string
  id?: string
  'aria-label'?: string
  'aria-invalid'?: true
  'aria-describedby'?: string
}) {
  const selected = options.find((option) => option.value === value)
  return (
    <BaseSelect.Root
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next)
      }}
    >
      <BaseSelect.Trigger {...rest} {...stylex.props(text.small, styles.trigger, focusRing.ring)}>
        <span {...stylex.props(text.truncate, !selected && styles.placeholder)}>{selected?.label ?? placeholder}</span>
        <Icon name="chevron-down" size={14} style={styles.caret} />
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={4} alignItemWithTrigger={false} {...stylex.props(styles.positioner)}>
          <BaseSelect.Popup {...stylex.props(styles.popup)}>
            <BaseSelect.List>
              {options.map((option) => (
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
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  )
}
