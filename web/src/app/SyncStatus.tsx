import * as stylex from '@stylexjs/stylex'
import { text } from '../theme/text'
import { Button } from '../ui/Button'

export function SyncStatus({ retry }: { retry: () => void }) {
  return (
    <span role="status" {...stylex.props(text.caption, text.muted)}>
      更新失败，显示上次内容{' '}
      <Button small variant="ghost" onClick={retry}>
        重试
      </Button>
    </span>
  )
}
