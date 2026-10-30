import * as stylex from '@stylexjs/stylex'
import { semantic } from '../theme/semantic.stylex'
import { space } from '../theme/tokens.stylex'
import { Button } from './Button'

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

// 放在相对定位的消息区容器里，由页面在离开底部时显示。
export function JumpToLatest({ onClick, style }: { onClick: () => void; style?: stylex.StyleXStyles }) {
  return (
    <div {...stylex.props(styles.frame, style)}>
      <Button variant="secondary" small icon="arrow-down" style={styles.button} onClick={onClick}>
        跳到最新
      </Button>
    </div>
  )
}
