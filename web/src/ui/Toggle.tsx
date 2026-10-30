import { Switch } from '@base-ui/react/switch'
import * as stylex from '@stylexjs/stylex'
import { semantic } from '../theme/semantic.stylex'
import { motion, radius } from '../theme/tokens.stylex'
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
    backgroundColor: semantic.input,
    transitionProperty: 'background-color',
    transitionDuration: motion.micro,
  },
  on: { backgroundColor: semantic.brand },
  thumb: {
    position: 'absolute',
    top: '2px',
    left: '2px',
    width: '14px',
    height: '14px',
    borderRadius: radius.pill,
    backgroundColor: semantic.brandOn,
    transitionProperty: 'transform',
    transitionDuration: motion.micro,
    transitionTimingFunction: motion.easeOut,
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
