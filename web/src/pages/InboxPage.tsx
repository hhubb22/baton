import * as stylex from '@stylexjs/stylex'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { AttentionCard } from '../app/AttentionCard'
import { Column, Page } from '../app/Page'
import { pendingInbox } from '../data/derive'
import type { InboxItem, Project } from '../data/types'
import { useInbox, useProjects } from '../data/queries'
import { text } from '../theme/text'
import { colors, radius, space } from '../theme/tokens.stylex'
import { Avatar } from '../ui/Avatar'
import { Banner } from '../ui/Banner'
import { Button, focusRing } from '../ui/Button'

const styles = stylex.create({
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
  // 收起的事项只留项目和问题，点开后成为当前展开的一项。
  collapsed: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    width: '100%',
    minWidth: 0,
    marginBlock: `calc(-1 * ${space.xs})`,
    paddingBlock: space.xs,
    paddingInline: 0,
    borderWidth: 0,
    borderRadius: radius.md,
    textAlign: 'left',
    color: { default: colors.muted, ':hover': colors.text },
    backgroundColor: 'transparent',
  },
  project: { flexShrink: 0, color: colors.text },
})

// @elyx design/screens/inbox.elyx#inbox
export function InboxPage() {
  const inbox = useInbox()
  const projects = useProjects()
  const [openId, setOpenId] = useState<string | null>(null)
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
  // 同时只展开一项，默认第一项。
  const expandedId = items.some((item) => item.id === openId) ? openId : items[0]?.id
  const focusedResultId = recent?.id
  useEffect(() => {
    if (focusedResultId) recentRef.current?.focus()
  }, [focusedResultId])
  return (
    <Page
      title={handled ? 'Handled' : 'Inbox'}
      actions={
        <Button
          small
          onClick={() => {
            setRecentResult(null)
            void navigate({ to: '/inbox', search: handled ? {} : { handled: true } })
          }}
        >
          {handled ? 'Back to inbox' : 'Handled'}
        </Button>
      }
    >
      <Column>
        {!handled && inbox.data && pending.length > 0 && (
          <h2 {...stylex.props(text.title)}>{pending.length} waiting for you</h2>
        )}
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
            {handled ? 'Nothing handled yet' : 'Nothing waiting'}
          </p>
        )}
        {items.length > 0 && (
          <div {...stylex.props(styles.list)}>
            {items.map((item) => (
              <div key={item.id} {...stylex.props(styles.row)}>
                {handled || item.id === expandedId ? (
                  <AttentionCard
                    item={item}
                    showProject
                    onHandled={(id, feedback) => setRecentResult({ id, feedback })}
                  />
                ) : (
                  <CollapsedItem
                    item={item}
                    project={projects.data?.find((project) => project.id === item.projectId)}
                    onOpen={() => setOpenId(item.id)}
                  />
                )}
              </div>
            ))}
          </div>
        )}
        {recent && (
          <div ref={recentRef} tabIndex={-1} role="region" aria-label="Latest result" {...stylex.props(styles.recent)}>
            <AttentionCard key={recent.id} item={recent} showProject feedback={recentResult?.feedback} />
            <Button small variant="ghost" onClick={() => void navigate({ to: '/inbox', search: { handled: true } })}>
              View handled
            </Button>
          </div>
        )}
      </Column>
    </Page>
  )
}

function CollapsedItem({
  item,
  project,
  onOpen,
}: {
  item: InboxItem
  project: Project | undefined
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      aria-expanded={false}
      onClick={onOpen}
      {...stylex.props(text.small, styles.collapsed, focusRing.ring)}
    >
      {project && (
        <>
          <Avatar name={project.name} hue={project.hue} />
          <span {...stylex.props(text.caption, styles.project)}>{project.name}</span>
        </>
      )}
      <span {...stylex.props(text.truncate)}>{item.title}</span>
    </button>
  )
}
