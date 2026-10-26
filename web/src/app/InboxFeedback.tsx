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
        Loading questions…
      </p>
    )
  if (!inbox.isError) return null
  return (
    <Banner
      icon="alert"
      title="Couldn't load questions"
      action={
        <Button small onClick={() => void inbox.refetch()}>
          Retry questions
        </Button>
      }
    />
  )
}
