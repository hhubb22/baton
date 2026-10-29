import * as stylex from '@stylexjs/stylex'
import { useInbox } from '../data/queries'
import { text } from '../theme/text'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'

export function InboxFeedback() {
  const inbox = useInbox()
  if (inbox.isPending)
    return (
      <p role="status" {...stylex.props(text.caption, text.muted)}>
        正在加载问题…
      </p>
    )
  if (!inbox.isError) return null
  return (
    <Banner
      icon="alert"
      title="无法加载问题"
      action={
        <Button small onClick={() => void inbox.refetch()}>
          重试加载问题
        </Button>
      }
    />
  )
}
