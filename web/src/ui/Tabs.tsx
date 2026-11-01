import * as stylex from '@stylexjs/stylex'
import { weight } from '../theme/base.stylex'
import { semantic } from '../theme/semantic.stylex'
import { text } from '../theme/text'
import { motion, radius, shadow, size } from '../theme/tokens.stylex'
import { focusRing } from './Button'
import { useSlidingIndicator } from './motion'

const styles = stylex.create({
  tabs: { position: 'relative', display: 'flex', alignItems: 'stretch', gap: '20px' },
  tab: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    height: '36px',
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: { default: semantic.mutedForeground, ':hover': semantic.foreground },
    transitionProperty: 'color',
    transitionDuration: motion.micro,
    transitionTimingFunction: motion.easeOut,
  },
  tabActive: { color: semantic.foreground },
  tabCount: { color: semantic.faintForeground },
  // 下划线和分段滑块是同一个元素在选项间移动，用屏幕内移动的曲线。
  underline: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    height: '1.5px',
    backgroundColor: semantic.foreground,
    pointerEvents: 'none',
  },
  sliding: {
    transitionProperty: 'transform, width',
    transitionDuration: motion.popover,
    transitionTimingFunction: motion.easeInOut,
  },
  segmented: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '2px',
    height: size.compact,
    padding: '2px',
    borderRadius: radius.md,
    backgroundColor: semantic.secondary,
  },
  thumb: {
    position: 'absolute',
    top: '2px',
    bottom: '2px',
    left: 0,
    borderRadius: radius.sm,
    backgroundColor: semantic.card,
    boxShadow: shadow.control,
    pointerEvents: 'none',
  },
  segment: {
    position: 'relative',
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
    transitionProperty: 'color',
    transitionDuration: motion.micro,
    transitionTimingFunction: motion.easeOut,
  },
  // 和输入框并排时与输入框等高，选项平分宽度。
  segmentedBlock: { flexGrow: 1, height: size.control },
  segmentBlock: { flexGrow: 1, flexBasis: 0, justifyContent: 'center' },
  segmentActive: { color: semantic.foreground },
})

function indicatorStyle(box: { x: number; width: number } | null) {
  return box ? { width: box.width, transform: `translateX(${box.x}px)` } : { display: 'none' }
}

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
  const { listRef, box, moved } = useSlidingIndicator<HTMLDivElement>(value)
  return (
    <div ref={listRef} role="tablist" aria-label={label} {...stylex.props(styles.tabs)}>
      <span aria-hidden {...stylex.props(styles.underline, moved && styles.sliding)} style={indicatorStyle(box)} />
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
  const { listRef, box, moved } = useSlidingIndicator<HTMLDivElement>(value)
  return (
    <div
      ref={listRef}
      role="radiogroup"
      aria-label={label}
      {...stylex.props(styles.segmented, block && styles.segmentedBlock)}
    >
      <span aria-hidden {...stylex.props(styles.thumb, moved && styles.sliding)} style={indicatorStyle(box)} />
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
