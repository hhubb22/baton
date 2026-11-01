import * as stylex from '@stylexjs/stylex'
import { enter, leave } from '../theme/motion'
import { semantic } from '../theme/semantic.stylex'
import { space } from '../theme/tokens.stylex'
import { Button } from './Button'
import { usePresence } from './motion'

const styles = stylex.create({
  frame: {
    position: 'absolute',
    insetInline: 0,
    bottom: space.md,
    zIndex: 1,
    display: 'flex',
    justifyContent: 'center',
    pointerEvents: 'none',
  },
  button: { borderRadius: '999px', backgroundColor: semantic.popover, pointerEvents: 'auto' },
})

// 放在相对定位的消息区容器里，页面离开底部时 visible 为真。
export function JumpToLatest({
  visible,
  onClick,
  style,
}: {
  visible: boolean
  onClick: () => void
  style?: stylex.StyleXStyles
}) {
  const { mounted, leaving } = usePresence(visible)
  if (!mounted) return null
  return (
    <div {...stylex.props(styles.frame, enter.rise, leaving && leave.fade, style)}>
      <Button variant="secondary" small icon="arrow-down" style={styles.button} onClick={onClick}>
        跳到最新
      </Button>
    </div>
  )
}
