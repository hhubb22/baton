import * as stylex from '@stylexjs/stylex'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { AttentionCard } from '../app/AttentionCard'
import { DesktopTargetNotice } from '../app/DesktopWorkspace'
import { pane } from '../app/Page'
import { useWorkspace } from '../app/workspace'
import { pendingInbox } from '../data/derive'
import type { InboxItem, Project } from '../data/types'
import { useInbox, useProjects } from '../data/queries'
import { text } from '../theme/text'
import { colors, radius, size, space } from '../theme/tokens.stylex'
import { Avatar } from '../ui/Avatar'
import { Banner } from '../ui/Banner'
import { Button, focusRing, IconButton } from '../ui/Button'
import { ResizablePane } from '../ui/ResizablePane'

const styles = stylex.create({
  layout: {
    display: 'flex',
    flexGrow: 1,
    minWidth: 0,
    height: '100%',
    backgroundColor: colors.canvas,
    '@media (max-width: 700px)': { flexDirection: 'column', overflowY: 'auto' },
  },
  listPane: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    borderRightWidth: '1px',
    borderRightStyle: 'solid',
    borderRightColor: colors.borderSoft,
    '@media (max-width: 700px)': { height: 'auto', borderRightWidth: 0 },
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    flexShrink: 0,
    height: size.header,
    paddingInline: space.md,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSoft,
  },
  headerTitle: { flexGrow: 1, minWidth: 0 },
  tabs: { display: 'flex', gap: space.xs, paddingBlock: space.sm, paddingInline: space.sm },
  tab: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space.xs,
    height: '28px',
    paddingInline: '10px',
    borderWidth: 0,
    borderRadius: radius.pill,
    backgroundColor: { default: colors.surface, ':hover': colors.hover },
    boxShadow: `0 0 0 0.5px ${colors.border}, 0 3px 6px -2px ${colors.shadowSoft}, 0 1px 1px ${colors.shadowNear}`,
    color: colors.muted,
  },
  activeTab: {
    backgroundColor: { default: colors.subtle, ':hover': colors.subtle },
    boxShadow: `0 0 0 0.5px ${colors.border}`,
    color: colors.text,
  },
  listScroll: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: 'auto',
    '@media (max-width: 700px)': { maxHeight: '224px' },
  },
  detail: { display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0, minHeight: 0 },
  detailScroll: { flexGrow: 1, minHeight: 0, overflowY: 'auto', paddingBlock: space.xxl, paddingInline: space.xl },
  detailContent: { width: '100%', maxWidth: '720px', marginInline: 'auto' },
  empty: { paddingBlock: space.section, textAlign: 'center' },
  recent: { display: 'flex', flexDirection: 'column', gap: space.md },
  list: { display: 'flex', flexDirection: 'column', gap: space.xxs, paddingInline: space.sm },
  collapsed: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    width: '100%',
    minWidth: 0,
    minHeight: '56px',
    paddingBlock: space.sm,
    paddingInline: space.md,
    borderWidth: 0,
    borderRadius: radius.md,
    textAlign: 'left',
    color: colors.text,
    backgroundColor: { default: 'transparent', ':hover': colors.hover },
  },
  selected: { backgroundColor: { default: colors.selected, ':hover': colors.selected } },
  rowContent: { display: 'flex', flexDirection: 'column', gap: space.xxs, minWidth: 0 },
  notice: { paddingInline: space.md, ':empty': { display: 'none' } },
})

export function InboxPage() {
  const inbox = useInbox()
  const projects = useProjects()
  const workspace = useWorkspace()
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
  const selected = items.find((item) => item.id === expandedId)
  const focusedResultId = recent?.id
  useEffect(() => {
    if (focusedResultId) recentRef.current?.focus()
  }, [focusedResultId])
  return (
    <section {...stylex.props(styles.layout, pane.card)}>
      <ResizablePane
        label="Resize inbox list"
        storageKey="baton.width.inbox-list"
        defaultWidth={400}
        min={280}
        max={640}
        reserve={360}
        stackOnNarrow
      >
        <div {...stylex.props(styles.listPane)}>
          <header {...stylex.props(styles.header)}>
            <IconButton
              icon="sidebar"
              label={workspace.collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-expanded={!workspace.collapsed}
              onClick={workspace.toggleSidebar}
            />
            <h1 {...stylex.props(text.bodyMedium, styles.headerTitle)}>{handled ? 'Handled' : 'Inbox'}</h1>
          </header>
          <div {...stylex.props(styles.notice)}>
            <DesktopTargetNotice />
          </div>
          <div {...stylex.props(styles.tabs)}>
            <button
              type="button"
              aria-current={!handled ? 'page' : undefined}
              onClick={() => {
                setRecentResult(null)
                void navigate({ to: '/inbox', search: {} })
              }}
              {...stylex.props(text.captionMedium, styles.tab, !handled && styles.activeTab, focusRing.ring)}
            >
              Waiting {pending.length}
            </button>
            <button
              type="button"
              aria-current={handled ? 'page' : undefined}
              onClick={() => {
                setRecentResult(null)
                void navigate({ to: '/inbox', search: { handled: true } })
              }}
              {...stylex.props(text.captionMedium, styles.tab, handled && styles.activeTab, focusRing.ring)}
            >
              Handled
            </button>
          </div>
          <div {...stylex.props(styles.listScroll)}>
            {inbox.isPending && (
              <p role="status" {...stylex.props(text.small, text.muted)}>
                Loading inbox…
              </p>
            )}
            {inbox.isError && (
              <Banner
                icon="alert"
                title="Couldn't load inbox"
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
                  <CollapsedItem
                    key={item.id}
                    item={item}
                    project={projects.data?.find((project) => project.id === item.projectId)}
                    selected={!recent && item.id === expandedId}
                    onOpen={() => {
                      setRecentResult(null)
                      setOpenId(item.id)
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </ResizablePane>
      <div {...stylex.props(styles.detail)}>
        <header {...stylex.props(text.small, text.muted, styles.header)}>
          <span {...stylex.props(text.truncate)}>{(recent ?? selected)?.title ?? (handled ? 'Handled' : 'Inbox')}</span>
        </header>
        <div {...stylex.props(styles.detailScroll)}>
          <div {...stylex.props(styles.detailContent)}>
            {selected && !recent && (
              <AttentionCard
                key={selected.id}
                item={selected}
                showProject
                detail
                onHandled={(id, feedback) => setRecentResult({ id, feedback })}
              />
            )}
            {recent && (
              <div
                ref={recentRef}
                tabIndex={-1}
                role="region"
                aria-label="Latest result"
                {...stylex.props(styles.recent)}
              >
                <AttentionCard key={recent.id} item={recent} showProject detail feedback={recentResult?.feedback} />
                <Button
                  small
                  variant="ghost"
                  onClick={() => void navigate({ to: '/inbox', search: { handled: true } })}
                >
                  View handled
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

function CollapsedItem({
  item,
  project,
  selected,
  onOpen,
}: {
  item: InboxItem
  project: Project | undefined
  selected: boolean
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onOpen}
      {...stylex.props(text.small, styles.collapsed, selected && styles.selected, focusRing.ring)}
    >
      {project && (
        <>
          <Avatar name={project.name} hue={project.hue} emoji={project.emoji} />
        </>
      )}
      <span {...stylex.props(styles.rowContent)}>
        <span {...stylex.props(text.truncate)}>{item.title}</span>
        {project && <span {...stylex.props(text.caption, text.muted, text.truncate)}>{project.name}</span>}
      </span>
    </button>
  )
}
