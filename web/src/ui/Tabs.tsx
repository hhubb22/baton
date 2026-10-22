import * as stylex from '@stylexjs/stylex'
import { weight } from '../theme/base.stylex'
import { text } from '../theme/text'
import { colors, radius, size } from '../theme/tokens.stylex'
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
    color: { default: colors.muted, ':hover': colors.text },
  },
  tabActive: { borderBottomColor: colors.text, color: colors.text },
  tabCount: { color: colors.faint },
  segmented: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '2px',
    height: size.compact,
    padding: '2px',
    borderRadius: radius.pill,
    backgroundColor: colors.subtle,
  },
  segment: {
    display: 'inline-flex',
    alignItems: 'center',
    height: '100%',
    paddingInline: '10px',
    borderWidth: 0,
    borderRadius: radius.pill,
    backgroundColor: 'transparent',
    color: { default: colors.muted, ':hover': colors.text },
    fontSize: '12px',
    lineHeight: 1,
    fontWeight: weight.medium,
  },
  // 和输入框并排时与输入框等高，选项平分宽度。
  segmentedBlock: { flexGrow: 1, height: size.control },
  segmentBlock: { flexGrow: 1, flexBasis: 0, justifyContent: 'center' },
  segmentActive: {
    backgroundColor: colors.surface,
    color: colors.text,
    boxShadow: '0 1px 2px rgb(0 0 0 / 8%), 0 1px 6px rgb(0 0 0 / 4%)',
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
