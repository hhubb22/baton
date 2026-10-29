import * as stylex from '@stylexjs/stylex'
import { Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { ClientError } from '../data/client'
import { clockTime, shortenExcerpt } from '../data/derive'
import { useHandleItem, useInbox, useProjectEntries, useProjects, useThreads } from '../data/queries'
import type { InboxItem, ItemDecision } from '../data/types'
import { weight } from '../theme/base.stylex'
import { text } from '../theme/text'
import { colors, radius, size, space } from '../theme/tokens.stylex'
import { Avatar } from '../ui/Avatar'
import { branch } from '../ui/Branch'
import { Button, focusRing, IconButton } from '../ui/Button'
import { Field, TextArea } from '../ui/Field'
import { Icon } from '../ui/Icon'
import { StatusDot } from '../ui/Status'
import { RestrictedMarkdown } from './RestrictedMarkdown'
import { copySelection, SelectionArea } from './SelectionMenu'
import { useDraft } from './drafts'
import { useWorkspace, type ItemDraft } from './workspace'

const styles = stylex.create({
  item: { display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0, overflowWrap: 'anywhere' },
  row: { display: 'flex', alignItems: 'center', gap: space.sm, minWidth: 0 },
  project: { minWidth: 0, color: colors.text, fontWeight: weight.medium, textDecoration: 'none' },
  meta: { minWidth: 0, color: colors.faint, textDecoration: 'none' },
  close: { marginLeft: 'auto', width: size.compact, height: size.compact },
  body: { color: colors.muted },
  action: { alignSelf: 'flex-start' },
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
  form: { display: 'flex', flexDirection: 'column', gap: space.sm },
  actions: { display: 'flex', gap: space.sm, justifyContent: 'flex-end' },
  result: { display: 'flex', flexDirection: 'column', gap: space.xxs, whiteSpace: 'pre-wrap', color: colors.muted },
  resultLine: { display: 'flex', alignItems: 'baseline', gap: '6px' },
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

export function AttentionCard({
  item,
  onHandled,
  feedback,
  showProject = false,
  detail = false,
}: {
  item: InboxItem
  showProject?: boolean
  onHandled?: (itemId: string, feedback: string | null) => void
  feedback?: string | null
  detail?: boolean
}) {
  const projects = useProjects()
  const threads = useThreads()
  const entries = useProjectEntries(item.projectId)
  const handle = useHandleItem()
  const workspace = useWorkspace()
  const navigate = useNavigate()
  const [optionsExpanded, setOptionsExpanded] = useState(false)
  const inbox = useInbox()
  const pendingCount = (inbox.data ?? []).filter(
    (value) => value.projectId === item.projectId && value.kind !== 'system' && value.status === 'pending',
  ).length
  const visibleOptions = optionsExpanded ? item.options : item.options.slice(0, 5)
  const [error, setError] = useState<string | null>(null)
  const project = projects.data?.find((value) => value.id === item.projectId)
  const thread = threads.data?.find((value) => value.id === item.threadId)
  const draft = useDraft(workspace.itemDrafts, item.id) ?? blankDraft
  const setDraft = (next: ItemDraft) => workspace.itemDrafts.set(item.id, next)
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
        setError('Choose an option or write a reply.')
        return
      }
      if (new TextEncoder().encode(decision.note).length > 4096) {
        setError('Over 4 KB. Shorten it to send.')
        return
      }
    }
    handle.mutate(
      { itemId: item.id, revision: item.revision, decision },
      {
        onSuccess: (operation) => {
          workspace.itemDrafts.set(item.id, null)
          onHandled?.(item.id, operation.phase === 'conflict' ? operation.detail : null)
          if (operation.phase === 'conflict')
            setError(
              operation.detail ?? `Already ${decision.kind === 'close' ? 'closed' : 'answered'} in another window.`,
            )
        },
        onError: (cause) =>
          setError(
            cause instanceof ClientError && cause.code === 'invalid'
              ? cause.message
              : decision.kind === 'close'
                ? `Couldn't close this ${system ? 'notice' : 'question'}. Try again.`
                : "Couldn't send. Try again.",
          ),
      },
    )
  }

  const done = !pending && item.result
  return (
    <section aria-label={item.title} {...stylex.props(styles.item)}>
      <div {...stylex.props(text.caption, styles.row)}>
        {showProject && project && (
          <>
            <Avatar name={project.name} hue={project.hue} emoji={project.emoji} />
            <Link
              to="/projects/$projectId"
              params={{ projectId: project.id }}
              {...stylex.props(styles.project, text.truncate)}
            >
              {project.name}
            </Link>
          </>
        )}
        {(!showProject || system) && <StatusDot tone={pending ? 'attention' : 'neutral'} />}
        {thread ? (
          <Link
            to="/projects/$projectId"
            params={{ projectId: item.projectId }}
            search={{ thread: thread.id }}
            {...stylex.props(styles.meta, text.truncate)}
          >
            {thread.title}
          </Link>
        ) : (
          system && !showProject && <span {...stylex.props(styles.meta)}>Baton</span>
        )}
        {pending && (
          <IconButton
            icon="close"
            label={system ? 'Close notice' : 'Close question'}
            onClick={() => submit({ kind: 'close' })}
            style={styles.close}
          />
        )}
      </div>
      <h2 {...stylex.props(text.heading, detail && text.title)}>{item.title}</h2>
      {!done && (
        <SelectionArea
          label={archived ? 'Copy selection' : 'Ask project assistant'}
          icon={archived ? 'copy' : 'reply'}
          describe={describe}
        >
          <div {...stylex.props(text.small, styles.body)}>
            <RestrictedMarkdown body={item.body} />
          </div>
        </SelectionArea>
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
                  <span {...stylex.props(text.caption, styles.recommended)}>Suggested</span>
                )}
              </button>
            ))}
            {item.allowText && (
              <button
                type="button"
                aria-pressed={draft.replying && draft.option === null}
                onClick={() => {
                  if (handle.isPending) return
                  setError(null)
                  setDraft({ ...draft, option: null, replying: true })
                }}
                {...stylex.props(
                  text.small,
                  styles.option,
                  draft.replying && draft.option === null && styles.selected,
                  focusRing.ring,
                )}
              >
                <span {...stylex.props(text.caption, styles.number)}>{item.options.length + 1}</span>
                <span {...stylex.props(styles.optionLabel)}>Other…</span>
              </button>
            )}
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
                      workspace.itemDrafts.set(item.id, null)
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
        <Button
          small
          style={styles.action}
          onClick={() => void navigate({ to: '/projects/$projectId', params: { projectId: item.projectId } })}
        >
          Go to project
        </Button>
      )}
      {!pending && item.result && (
        <div role="status" {...stylex.props(text.small, styles.result)}>
          <p {...stylex.props(styles.resultLine)}>
            <Icon name="check" size={12} />
            <span>
              {[item.result.option, item.result.note].filter(Boolean).join(' · ') || statusLabels[item.status]} ·{' '}
              {item.result.actor} · {clockTime(item.result.at)}
            </span>
          </p>
          {item.result.reason && <p>{item.result.reason}</p>}
          {waiting && (
            <p>
              {project?.status === 'paused'
                ? 'Reply saved · read after you resume'
                : project?.agent.state === 'waitingDevice'
                  ? 'Reply saved · read when a device is online'
                  : project?.agent.state === 'blocked'
                    ? 'Reply saved · retry from the project when ready'
                    : 'Reply saved'}
            </p>
          )}
        </div>
      )}
      {(error ?? feedback) && (!pending || !draft.replying || system) && (
        <p role="alert" {...stylex.props(text.caption, styles.error)}>
          {error ?? feedback}
        </p>
      )}
      {handle.isPending && !draft.replying && (
        <p role="status" {...stylex.props(text.caption, styles.meta)}>
          Saving reply…
        </p>
      )}
    </section>
  )
}
