import { Switch } from '@base-ui/react/switch'
import * as stylex from '@stylexjs/stylex'
import { colors, radius } from '../theme/tokens.stylex'
import { focusRing } from './Button'

const styles = stylex.create({
  track: {
    position: 'relative',
    flexShrink: 0,
    width: '30px',
    height: '18px',
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.pill,
    backgroundColor: colors.borderStrong,
    transitionProperty: 'background-color',
    transitionDuration: '120ms',
  },
  on: { backgroundColor: colors.accent },
  thumb: {
    position: 'absolute',
    top: '2px',
    left: '2px',
    width: '14px',
    height: '14px',
    borderRadius: radius.pill,
    backgroundColor: '#fff',
    boxShadow: '0 1px 2px rgb(0 0 0 / 20%)',
    transitionProperty: 'transform',
    transitionDuration: '120ms',
  },
  thumbOn: { transform: 'translateX(12px)' },
})

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
}) {
  return (
    <Switch.Root
      checked={checked}
      onCheckedChange={(next) => onChange(next)}
      aria-label={label}
      className={(state) => stylex.props(styles.track, state.checked && styles.on, focusRing.ring).className ?? ''}
    >
      <Switch.Thumb
        className={(state) => stylex.props(styles.thumb, state.checked && styles.thumbOn).className ?? ''}
      />
    </Switch.Root>
  )
}
