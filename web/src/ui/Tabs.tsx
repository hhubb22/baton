import * as stylex from '@stylexjs/stylex'
import { weight } from '../theme/base.stylex'
import { semantic } from '../theme/semantic.stylex'
import { text } from '../theme/text'
import { radius, shadow, size } from '../theme/tokens.stylex'
import { focusRing } from './Button'

const styles = stylex.create({
  tabs: { display: 'flex', alignItems: 'stretch', gap: '20px' },
  tab: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    height: '36px',
    padding: 0,
    borderWidth: 0,
    borderBottomWidth: '1.5px',
    borderStyle: 'solid',
    borderColor: 'transparent',
    backgroundColor: 'transparent',
    color: { default: semantic.mutedForeground, ':hover': semantic.foreground },
  },
  tabActive: { borderBottomColor: semantic.foreground, color: semantic.foreground },
  tabCount: { color: semantic.faintForeground },
  segmented: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '2px',
    height: size.compact,
    padding: '2px',
    borderRadius: radius.md,
    backgroundColor: semantic.secondary,
  },
  segment: {
    display: 'inline-flex',
    alignItems: 'center',
    height: '100%',
    paddingInline: '10px',
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: 'transparent',
    color: { default: semantic.mutedForeground, ':hover': semantic.foreground },
    fontSize: '12px',
    lineHeight: 1,
    fontWeight: weight.medium,
  },
  // 和输入框并排时与输入框等高，选项平分宽度。
  segmentedBlock: { flexGrow: 1, height: size.control },
  segmentBlock: { flexGrow: 1, flexBasis: 0, justifyContent: 'center' },
  segmentActive: {
    backgroundColor: semantic.card,
    color: semantic.foreground,
    boxShadow: shadow.control,
  },
})

export type TabOption<T extends string> = { value: T; label: string; count?: number }

export function Tabs<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: TabOption<T>[]
  value: T
  onChange: (value: T) => void
  label: string
}) {
  return (
    <div role="tablist" aria-label={label} {...stylex.props(styles.tabs)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          onClick={() => onChange(option.value)}
          {...stylex.props(text.label, styles.tab, option.value === value && styles.tabActive, focusRing.ring)}
        >
          {option.label}
          {option.count !== undefined && <span {...stylex.props(styles.tabCount)}>{option.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  block,
}: {
  options: TabOption<T>[]
  value: T
  onChange: (value: T) => void
  label: string
  block?: boolean
}) {
  return (
    <div role="radiogroup" aria-label={label} {...stylex.props(styles.segmented, block && styles.segmentedBlock)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
          {...stylex.props(
            styles.segment,
            block && styles.segmentBlock,
            option.value === value && styles.segmentActive,
            focusRing.ring,
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
