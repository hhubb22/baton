import * as stylex from '@stylexjs/stylex'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { ClientError } from '../data/client'
import { clockTime, shortenExcerpt } from '../data/derive'
import { useHandleItem, useInbox, useProjectEntries, useProjects, useThreads } from '../data/queries'
import type { InboxItem, ItemDecision } from '../data/types'
import { weight } from '../theme/base.stylex'
import { text } from '../theme/text'
import { colors, radius, space } from '../theme/tokens.stylex'
import { Avatar } from '../ui/Avatar'
import { branch } from '../ui/Branch'
import { Button, focusRing } from '../ui/Button'
import { Field, TextArea } from '../ui/Field'
import { StatusDot } from '../ui/Status'
import { RestrictedMarkdown } from './RestrictedMarkdown'
import { copySelection, SelectionArea } from './SelectionMenu'
import { useWorkspace, type ItemDraft } from './workspace'

const styles = stylex.create({
  item: { display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0, overflowWrap: 'anywhere' },
  row: { display: 'flex', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  meta: { color: colors.muted, textDecoration: 'none' },
  status: { display: 'inline-flex', alignItems: 'center', gap: '6px', color: colors.attentionText },
  time: { marginLeft: 'auto', color: colors.faint },
  option: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    width: '100%',
    minWidth: 0,
    paddingBlock: '6px',
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radius.md,
    textAlign: 'left',
    color: colors.text,
    backgroundColor: { default: 'transparent', ':hover': colors.hover },
  },
  selected: { backgroundColor: { default: colors.accentSoft, ':hover': colors.accentSoft } },
  // 选项序号的键帽。
  number: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '20px',
    height: '20px',
    borderRadius: radius.sm,
    backgroundColor: colors.subtle,
    color: colors.muted,
  },
  optionLabel: { flexGrow: 1 },
  suggested: { fontWeight: weight.medium },
  recommended: { flexShrink: 0, color: colors.agentText },
  footer: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between', gap: space.sm },
  form: { display: 'flex', flexDirection: 'column', gap: space.sm },
  actions: { display: 'flex', gap: space.sm, justifyContent: 'flex-end' },
  details: { alignSelf: 'flex-start' },
  result: { whiteSpace: 'pre-wrap', color: colors.muted },
  error: { color: colors.danger },
})

const statusLabels = {
  pending: 'Waiting for your reply',
  answered: 'Answered',
  closed: 'Closed',
  withdrawn: 'Withdrawn',
  resolved: 'Resolved',
}
const blankDraft: ItemDraft = { option: null, note: '', replying: false }

// @elyx design/blocks/attention-card.elyx#attentionCard
export function AttentionCard({
  item,
  onHandled,
  feedback,
}: {
  item: InboxItem
  onHandled?: (itemId: string, feedback: string | null) => void
  feedback?: string | null
}) {
  const projects = useProjects()
  const threads = useThreads()
  const entries = useProjectEntries(item.projectId)
  const handle = useHandleItem()
  const workspace = useWorkspace()
  const [expanded, setExpanded] = useState(false)
  const [optionsExpanded, setOptionsExpanded] = useState(false)
  const inbox = useInbox()
  const pendingCount = (inbox.data ?? []).filter(
    (value) => value.projectId === item.projectId && value.kind !== 'system' && value.status === 'pending',
  ).length
  const visibleOptions = optionsExpanded ? item.options : item.options.slice(0, 5)
  const [error, setError] = useState<string | null>(null)
  const project = projects.data?.find((value) => value.id === item.projectId)
  const thread = threads.data?.find((value) => value.id === item.threadId)
  const draft = workspace.itemDrafts[item.id] ?? blankDraft
  const setDraft = (next: ItemDraft) => workspace.setItemDraft(item.id, next)
  const archived = project?.status === 'archived'
  const pending = item.status === 'pending' && !archived
  const system = item.kind === 'system'
  const input = entries.data?.find((entry) => entry.id === item.result?.inputId)
  const waiting = item.result?.inputId && input?.kind === 'user' && input.delivery !== 'delivered'
  const describe = (_range: Range, value: string) =>
    archived
      ? () => copySelection(value)
      : () =>
          workspace.askProject(item.projectId, {
            kind: 'item',
            title: item.title,
            threadId: item.threadId,
            reply: null,
            deviceId: null,
            path: null,
            lines: null,
            itemId: item.id,
            ...shortenExcerpt(value),
          })

  const submit = (decision: ItemDecision) => {
    if (handle.isPending) return
    setError(null)
    if (decision.kind === 'answer') {
      if (decision.option === null && !decision.note.trim()) {
        setError('Enter a reply.')
        return
      }
      if (new TextEncoder().encode(decision.note).length > 4096) {
        setError('Keep your reply within 4 KB of text.')
        return
      }
    }
    handle.mutate(
      { itemId: item.id, revision: item.revision, decision },
      {
        onSuccess: (operation) => {
          workspace.setItemDraft(item.id, null)
          onHandled?.(item.id, operation.phase === 'conflict' ? operation.detail : null)
          if (operation.phase === 'conflict') setError(operation.detail ?? 'This question was already handled.')
        },
        onError: (cause) =>
          setError(
            cause instanceof ClientError && cause.code === 'invalid'
              ? cause.message
              : decision.kind === 'close'
                ? `Could not close this ${system ? 'notice' : 'question'}. Try again.`
                : 'Your reply could not be saved. Your choice and note are kept. Try again.',
          ),
      },
    )
  }

  return (
    <section aria-label={item.title} {...stylex.props(styles.item)}>
      <div {...stylex.props(text.caption, styles.row)}>
        {project && (
          <>
            <Avatar name={project.name} hue={project.hue} />
            <Link to="/projects/$projectId" params={{ projectId: project.id }} {...stylex.props(styles.meta)}>
              {project.name}
            </Link>
          </>
        )}
        <span {...stylex.props(pending ? styles.status : styles.meta)}>
          <StatusDot tone={pending ? 'attention' : 'neutral'} />{' '}
          {pending && system ? 'Needs attention' : statusLabels[item.status]}
        </span>
        {system && <span {...stylex.props(styles.meta)}>Baton</span>}
        <time
          dateTime={new Date(item.createdAt).toISOString()}
          title={new Date(item.createdAt).toLocaleString()}
          {...stylex.props(styles.time)}
        >
          {clockTime(item.createdAt)}
        </time>
      </div>
      <h2 {...stylex.props(text.heading)}>{item.title}</h2>
      <Button
        small
        variant="ghost"
        icon={expanded ? 'chevron-down' : 'chevron-right'}
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        style={styles.details}
      >
        {expanded ? 'Hide details' : 'Show details'}
      </Button>
      {expanded && (
        <SelectionArea
          label={archived ? 'Copy selection' : 'Ask project assistant'}
          icon={archived ? 'copy' : 'reply'}
          describe={describe}
        >
          <RestrictedMarkdown body={item.body} />
        </SelectionArea>
      )}
      {thread && (
        <Link
          to="/projects/$projectId"
          params={{ projectId: item.projectId }}
          search={{ thread: thread.id }}
          {...stylex.props(text.caption, styles.meta)}
        >
          {thread.title} · {thread.status === 'idle' ? 'Idle' : 'View thread'}
        </Link>
      )}
      {pending && !system && (
        <>
          {pendingCount >= 10 && (
            <p {...stylex.props(text.caption, styles.meta)}>
              {pendingCount} questions waiting in this project. Consider answering or closing older questions.
            </p>
          )}
          <div {...stylex.props(branch.line)}>
            {visibleOptions.map((option, index) => (
              <button
                type="button"
                key={option}
                aria-pressed={draft.option === option}
                onClick={() => {
                  if (handle.isPending) return
                  setError(null)
                  setDraft({ ...draft, option, replying: true })
                }}
                {...stylex.props(text.small, styles.option, draft.option === option && styles.selected, focusRing.ring)}
              >
                <span {...stylex.props(text.caption, styles.number)}>{index + 1}</span>
                <span {...stylex.props(styles.optionLabel, index === item.recommended && styles.suggested)}>
                  {option}
                </span>
                {index === item.recommended && (
                  <span {...stylex.props(text.caption, styles.recommended)}>Recommended</span>
                )}
              </button>
            ))}
          </div>
          {item.options.length > 5 && (
            <Button
              small
              variant="ghost"
              aria-expanded={optionsExpanded}
              onClick={() => setOptionsExpanded(!optionsExpanded)}
            >
              {optionsExpanded ? 'Show fewer options' : `Show all ${item.options.length} options`}
            </Button>
          )}
          <div {...stylex.props(styles.footer)}>
            {item.allowText && (
              <Button
                variant="ghost"
                small
                onClick={() => {
                  if (!handle.isPending) setDraft({ ...draft, option: null, replying: true })
                }}
              >
                Reply with text
              </Button>
            )}
            <Button variant="ghost" small onClick={() => submit({ kind: 'close' })}>
              Close question
            </Button>
          </div>
          {draft.replying && (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                submit({ kind: 'answer', option: draft.option, note: draft.note })
              }}
              {...stylex.props(styles.form)}
            >
              <Field
                label={draft.option === null ? 'Your reply' : 'Note'}
                optional={draft.option !== null}
                helper="Up to 4 KB of text"
                error={error}
              >
                {(props) => (
                  <TextArea
                    {...props}
                    autoFocus
                    value={draft.note}
                    readOnly={handle.isPending}
                    onChange={(event) => setDraft({ ...draft, note: event.target.value })}
                  />
                )}
              </Field>
              <div {...stylex.props(styles.actions)}>
                <Button
                  small
                  variant="ghost"
                  onClick={() => {
                    if (!handle.isPending) {
                      workspace.setItemDraft(item.id, null)
                      setError(null)
                    }
                  }}
                >
                  Cancel
                </Button>
                <Button small type="submit">
                  {handle.isPending ? 'Saving…' : 'Send reply'}
                </Button>
              </div>
            </form>
          )}
        </>
      )}
      {pending && system && (
        <div {...stylex.props(styles.footer)}>
          <Link
            to="/projects/$projectId"
            params={{ projectId: item.projectId }}
            {...stylex.props(text.small, styles.meta)}
          >
            Go to project
          </Link>
          <Button variant="ghost" small onClick={() => submit({ kind: 'close' })}>
            {handle.isPending ? 'Closing…' : 'Close notice'}
          </Button>
        </div>
      )}
      {!pending && item.result && (
        <div role="status" {...stylex.props(text.small, styles.result)}>
          <p>
            {[item.result.option, item.result.note].filter(Boolean).join(' · ') || statusLabels[item.status]} ·{' '}
            {item.result.actor} · {clockTime(item.result.at)}
          </p>
          {item.result.reason && <p>{item.result.reason}</p>}
          {waiting && (
            <p>
              {project?.status === 'paused'
                ? 'Your reply is saved. The project assistant will read it when the project resumes.'
                : project?.agent.state === 'waitingDevice'
                  ? 'Your reply is saved. The project assistant will read it when a device is available.'
                  : project?.agent.state === 'blocked'
                    ? 'Your reply is saved. Retry the project to continue.'
                    : 'Your reply is saved. The project assistant will read it next.'}
            </p>
          )}
        </div>
      )}
      {(error ?? feedback) && (!pending || !draft.replying || system) && (
        <p role="alert" {...stylex.props(text.caption, styles.error)}>
          {error ?? feedback}
        </p>
      )}
      {handle.isPending && !draft.replying && !system && (
        <p role="status" {...stylex.props(text.caption, styles.meta)}>
          Saving…
        </p>
      )}
    </section>
  )
}
