import * as stylex from '@stylexjs/stylex'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { AttentionCard } from '../app/AttentionCard'
import { Column, Page } from '../app/Page'
import { pendingInbox } from '../data/derive'
import { useInbox } from '../data/queries'
import { text } from '../theme/text'
import { colors, space } from '../theme/tokens.stylex'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'

const styles = stylex.create({
  heading: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  empty: { paddingBlock: space.xl, textAlign: 'center' },
  recent: { display: 'flex', flexDirection: 'column', gap: space.md },
  // 整页的行，不画外框，靠 borderSoft 分隔线分开。
  list: { display: 'flex', flexDirection: 'column' },
  row: {
    paddingBlock: space.lg,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSoft,
  },
})

// @elyx design/screens/inbox.elyx#inbox
export function InboxPage() {
  const inbox = useInbox()
  const { handled } = useSearch({ from: '/workspace/inbox' })
  const navigate = useNavigate()
  const [recentResult, setRecentResult] = useState<{ id: string; feedback: string | null } | null>(null)
  const recentRef = useRef<HTMLDivElement>(null)
  const all = inbox.data ?? []
  const pending = pendingInbox(all)
  const items = handled
    ? all.filter((item) => item.status !== 'pending').sort((a, b) => b.createdAt - a.createdAt)
    : pending
  const recent = handled ? undefined : all.find((item) => item.id === recentResult?.id && item.status !== 'pending')
  const focusedResultId = recent?.id
  useEffect(() => {
    if (focusedResultId) recentRef.current?.focus()
  }, [focusedResultId])
  return (
    <Page
      title="Inbox"
      actions={
        <Button
          small
          variant="ghost"
          onClick={() => {
            setRecentResult(null)
            void navigate({ to: '/inbox', search: handled ? {} : { handled: true } })
          }}
        >
          {handled ? 'Pending items' : 'Handled items'}
        </Button>
      }
    >
      <Column>
        <div {...stylex.props(styles.heading)}>
          <h2 {...stylex.props(text.title)}>
            {handled
              ? 'Handled items'
              : !inbox.data
                ? 'Inbox'
                : `${pending.length} ${pending.length === 1 ? 'item' : 'items'} waiting for you`}
          </h2>
          <span {...stylex.props(text.caption, text.faint)}>Newest first</span>
        </div>
        {inbox.isPending && (
          <p role="status" {...stylex.props(text.small, text.muted)}>
            Loading inbox…
          </p>
        )}
        {inbox.isError && (
          <Banner
            icon="alert"
            title="Could not load your inbox"
            detail="Your questions are kept. Try again."
            action={
              <Button small onClick={() => void inbox.refetch()}>
                Retry
              </Button>
            }
          />
        )}
        {inbox.data && items.length === 0 && (
          <p {...stylex.props(text.body, text.muted, styles.empty)}>
            {handled ? 'No handled items yet' : 'Nothing needs your decision'}
          </p>
        )}
        {items.length > 0 && (
          <div {...stylex.props(styles.list)}>
            {items.map((item) => (
              <div key={item.id} {...stylex.props(styles.row)}>
                <AttentionCard item={item} onHandled={(id, feedback) => setRecentResult({ id, feedback })} />
              </div>
            ))}
          </div>
        )}
        {recent && (
          <div ref={recentRef} tabIndex={-1} role="region" aria-label="Latest result" {...stylex.props(styles.recent)}>
            <AttentionCard key={recent.id} item={recent} feedback={recentResult?.feedback} />
            <Button small variant="ghost" onClick={() => void navigate({ to: '/inbox', search: { handled: true } })}>
              View handled items
            </Button>
          </div>
        )}
      </Column>
    </Page>
  )
}
