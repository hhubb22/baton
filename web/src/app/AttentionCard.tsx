import * as stylex from '@stylexjs/stylex'
import { Button as OpenUIButton } from '@openuidev/react-ui/Button'
import { Card } from '@openuidev/react-ui/Card'
import { RadioGroup } from '@openuidev/react-ui/RadioGroup'
import { RadioItem } from '@openuidev/react-ui/RadioItem'
import { TextArea as OpenUITextArea } from '@openuidev/react-ui/TextArea'
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
import { Button, IconButton } from '../ui/Button'
import { Field } from '../ui/Field'
import { Icon } from '../ui/Icon'
import { StatusDot } from '../ui/Status'
import { RestrictedMarkdown } from './RestrictedMarkdown'
import { copySelection, SelectionArea } from './SelectionMenu'
import { useDraft } from './drafts'
import { useWorkspace, type ItemDraft } from './workspace'
import '@openuidev/react-ui/defaults.css'
import '@openuidev/react-ui/styles/card.css'
import '@openuidev/react-ui/styles/radioGroup.css'
import '@openuidev/react-ui/styles/radioItem.css'
import '@openuidev/react-ui/styles/textArea.css'
import '@openuidev/react-ui/styles/button.css'
import './attention-card.css'

const styles = stylex.create({
  item: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.md,
    minWidth: 0,
    overflowWrap: 'anywhere',
    padding: space.xl,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
  },
  inThread: { padding: space.lg },
  row: { display: 'flex', alignItems: 'center', gap: space.sm, minWidth: 0 },
  status: { display: 'inline-flex', alignItems: 'center', gap: '6px', flexShrink: 0, color: colors.muted },
  project: { minWidth: 0, color: colors.text, fontWeight: weight.medium, textDecoration: 'none' },
  meta: { minWidth: 0, color: colors.faint, textDecoration: 'none' },
  close: { marginLeft: 'auto', width: size.compact, height: size.compact },
  body: { maxWidth: '70ch' },
  options: { marginTop: space.xs },
  recommended: {
    display: 'inline-block',
    marginLeft: space.sm,
    paddingInline: '6px',
    borderRadius: radius.sm,
    color: colors.agentText,
    backgroundColor: colors.agentSoft,
    fontSize: '11px',
    fontWeight: weight.medium,
    lineHeight: '20px',
    verticalAlign: 'middle',
  },
  action: { alignSelf: 'flex-start' },
  form: { display: 'flex', flexDirection: 'column', gap: space.sm },
  actions: { display: 'flex', gap: space.sm, justifyContent: 'flex-end' },
  result: { display: 'flex', flexDirection: 'column', gap: space.xxs, whiteSpace: 'pre-wrap', color: colors.muted },
  resultLine: { display: 'flex', alignItems: 'baseline', gap: '6px' },
  error: { color: colors.danger },
})

const statusLabels = {
  pending: '待回复',
  answered: '已回复',
  closed: '已关闭',
  withdrawn: '已撤回',
  resolved: '已解决',
}
const blankDraft: ItemDraft = { option: null, note: '', replying: false }

export function AttentionCard({
  item,
  onHandled,
  feedback,
  showProject = false,
  detail = false,
  inThread = false,
}: {
  item: InboxItem
  showProject?: boolean
  onHandled?: (itemId: string, feedback: string | null) => void
  feedback?: string | null
  detail?: boolean
  inThread?: boolean
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
        setError('请选择一个选项或填写回复。')
        return
      }
      if (new TextEncoder().encode(decision.note).length > 4096) {
        setError('回复超过 4 KB，请缩短后发送。')
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
            setError(operation.detail ?? `此问题已在其他窗口${decision.kind === 'close' ? '关闭' : '回复'}。`)
        },
        onError: (cause) =>
          setError(
            cause instanceof ClientError && cause.code === 'invalid'
              ? cause.message
              : decision.kind === 'close'
                ? `无法关闭${system ? '提示' : '问题'}，请重试。`
                : '无法发送，请重试。',
          ),
      },
    )
  }

  const done = !pending && item.result
  return (
    <section aria-label={item.title}>
      <Card width="full" {...stylex.props(styles.item, inThread && styles.inThread)}>
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
          <span {...stylex.props(styles.status)}>
            <StatusDot tone={pending ? 'attention' : 'neutral'} />
            {archived ? '项目已归档' : pending ? '待回复' : statusLabels[item.status]}
          </span>
          {thread && !inThread ? (
            <Link
              to="/projects/$projectId"
              params={{ projectId: item.projectId }}
              search={{ thread: thread.id }}
              {...stylex.props(styles.meta, text.truncate)}
            >
              {thread.title}
            </Link>
          ) : !thread && !showProject ? (
            <span {...stylex.props(styles.meta)}>{system ? 'Baton' : '项目'}</span>
          ) : null}
          {pending && (
            <IconButton
              icon="close"
              label={system ? '关闭通知' : '关闭问题'}
              onClick={() => submit({ kind: 'close' })}
              style={styles.close}
            />
          )}
        </div>
        <h2 {...stylex.props(text.heading, detail && text.title)}>{item.title}</h2>
        {!done && (
          <SelectionArea
            label={archived ? '复制所选内容' : '询问项目助手'}
            icon={archived ? 'copy' : 'reply'}
            describe={describe}
          >
            <div {...stylex.props(styles.body)}>
              <RestrictedMarkdown body={item.body} muted />
            </div>
          </SelectionArea>
        )}
        {pending && !system && (
          <>
            {pendingCount >= 10 && (
              <p {...stylex.props(text.caption, styles.meta)}>
                此项目有 {pendingCount} 个待处理问题，请先回答或关闭较早的问题。
              </p>
            )}
            <RadioGroup
              aria-label={item.title}
              value={
                draft.replying ? (draft.option === null ? 'other' : String(item.options.indexOf(draft.option))) : ''
              }
              disabled={handle.isPending}
              onValueChange={(value) => {
                setError(null)
                setDraft({
                  ...draft,
                  option: value === 'other' ? null : (item.options[Number(value)] ?? null),
                  replying: true,
                })
              }}
              className={`attention-card-options ${stylex.props(styles.options).className ?? ''}`}
            >
              {[
                ...visibleOptions.map((option, index) => (
                  <RadioItem
                    key={index}
                    value={String(index)}
                    ref={(element) =>
                      element?.setAttribute('aria-label', `${option}${index === item.recommended ? '，推荐' : ''}`)
                    }
                    label={
                      <>
                        {option}
                        {index === item.recommended && <span {...stylex.props(styles.recommended)}>推荐</span>}
                      </>
                    }
                  />
                )),
                ...(item.allowText
                  ? [
                      <RadioItem
                        key="other"
                        value="other"
                        label="其他…"
                        ref={(element) => element?.setAttribute('aria-label', '其他…')}
                      />,
                    ]
                  : []),
              ]}
            </RadioGroup>
            {item.options.length > 5 && (
              <Button
                small
                variant="ghost"
                aria-expanded={optionsExpanded}
                onClick={() => setOptionsExpanded(!optionsExpanded)}
              >
                {optionsExpanded ? '收起选项' : `显示全部 ${item.options.length} 个选项`}
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
                  label={draft.option === null ? '你的回复' : '备注'}
                  optional={draft.option !== null}
                  error={error}
                >
                  {(props) => (
                    <OpenUITextArea
                      {...props}
                      hasError={Boolean(error)}
                      autoFocus
                      value={draft.note}
                      readOnly={handle.isPending}
                      onChange={(event) => setDraft({ ...draft, note: event.target.value })}
                    />
                  )}
                </Field>
                <div {...stylex.props(styles.actions)}>
                  <OpenUIButton
                    size="small"
                    variant="tertiary"
                    type="button"
                    onClick={() => {
                      if (!handle.isPending) {
                        workspace.itemDrafts.set(item.id, null)
                        setError(null)
                      }
                    }}
                  >
                    取消
                  </OpenUIButton>
                  <OpenUIButton size="small" type="submit">
                    {handle.isPending ? '正在保存…' : '发送回复'}
                  </OpenUIButton>
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
            前往项目
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
                  ? '回复已保存 · 恢复项目后读取'
                  : project?.agent.state === 'waitingDevice'
                    ? '回复已保存 · 设备上线后读取'
                    : project?.agent.state === 'blocked'
                      ? '回复已保存 · 请在项目中重试'
                      : '回复已保存'}
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
            正在保存回复…
          </p>
        )}
      </Card>
    </section>
  )
}
