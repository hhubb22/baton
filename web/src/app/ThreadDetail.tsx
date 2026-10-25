import * as stylex from '@stylexjs/stylex'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { ClientError } from '../data/client'
import {
  agentNames,
  shortenExcerpt,
  threadMessageNotice,
  threadView,
  type ThreadAction,
  type ThreadNotice,
} from '../data/derive'
import {
  newClientId,
  useArchiveThread,
  useCancelMessage,
  useDevices,
  useMessages,
  useInbox,
  useProjects,
  useOperation,
  useResumeThread,
  useSendMessage,
  useSetThreadModel,
  useStopThread,
  useThread,
} from '../data/queries'
import type { Device, DeviceAgent, ID, Message, Reference, SendMode, Thread } from '../data/types'
import { text } from '../theme/text'
import { colors, radius, size, space } from '../theme/tokens.stylex'
import { Banner } from '../ui/Banner'
import { Button, focusRing, IconButton } from '../ui/Button'
import { Composer } from '../ui/Composer'
import { Dialog, DialogClose } from '../ui/Dialog'
import { Icon } from '../ui/Icon'
import { Menu, MenuOption } from '../ui/Menu'
import { StatusDot, type Tone } from '../ui/Status'
import { AttentionCard } from './AttentionCard'
import { InboxFeedback } from './InboxFeedback'
import { FilePreview } from './FilePreview'
import { MessageBody } from './MessageBody'
import { FullOutput } from './FullOutput'
import { Page } from './Page'
import { ActivityTrace, Attachments, LiveOutput } from './ReplyParts'
import { copySelection, SelectionArea } from './SelectionMenu'
import { ThreadExecutionLimit } from './ThreadExecutionLimit'
import { ThreadModelMenu } from './ThreadModelMenu'
import { useNow } from './useNow'
import { useWorkspace } from './workspace'

const styles = stylex.create({
  panel: {
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
    width: size.detail,
    minWidth: 0,
    height: '100%',
    borderLeftWidth: '1px',
    borderLeftStyle: 'solid',
    borderLeftColor: colors.borderSoft,
    backgroundColor: colors.surface,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    flexShrink: 0,
    height: size.header,
    paddingLeft: space.md,
    paddingRight: space.sm,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSoft,
  },
  headerTitle: { flexShrink: 1 },
  headerStatus: { display: 'inline-flex', alignItems: 'center', gap: '6px', flexGrow: 1, whiteSpace: 'nowrap' },
  split: { display: 'flex', height: '100%', minHeight: 0 },
  main: { display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0, minHeight: 0 },
  timeline: { flexGrow: 1, minHeight: 0, overflowY: 'auto', outline: 'none' },
  messages: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.lg,
    width: '100%',
    maxWidth: size.measure,
    marginInline: 'auto',
    padding: space.xl,
  },
  messagesPanel: { paddingInline: space.lg },
  userItem: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px' },
  user: {
    maxWidth: '85%',
    paddingBlock: space.sm,
    paddingInline: space.md,
    borderRadius: '14px',
    backgroundColor: colors.subtle,
  },
  withdrawn: { color: colors.muted },
  agent: { display: 'flex', flexDirection: 'column', gap: space.sm, alignSelf: 'stretch' },
  sender: { color: colors.faint },
  note: { display: 'inline-flex', alignItems: 'center', gap: '4px', color: colors.faint },
  noteUnknown: { color: colors.attentionText },
  link: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: colors.link,
    textDecoration: { default: 'none', ':hover': 'underline' },
  },
  info: { color: colors.info },
  muted: { color: colors.muted },
  danger: { color: colors.danger },
  attention: { color: colors.attentionText },
  dock: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: space.sm,
    flexShrink: 0,
    paddingInline: space.xl,
    paddingBottom: space.md,
  },
  dockPanel: { paddingInline: space.lg },
  notice: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space.md,
    width: '100%',
    maxWidth: size.measure,
    paddingBlock: '10px',
    paddingInline: '14px',
    backgroundColor: colors.panel,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSoft,
    borderRadius: '10px',
  },
  noticeDanger: { borderColor: 'rgb(74% 26% 23% / 24%)' },
  noticeAttention: { backgroundColor: colors.attentionSoft, borderColor: 'rgb(91% 41% 12% / 18%)' },
  noticeBody: { display: 'flex', flexDirection: 'column', gap: '2px', flexGrow: 1, minWidth: 0 },
  composer: { maxWidth: size.measure },
  status: { width: '100%', maxWidth: size.measure, minHeight: '18px', color: colors.muted },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: space.md,
    width: '100%',
    maxWidth: size.measure,
    color: colors.faint,
  },
  footerItem: { display: 'inline-flex', alignItems: 'center', gap: '4px', minWidth: 0 },
  segmented: {
    display: 'inline-flex',
    padding: '2px',
    borderRadius: radius.pill,
    backgroundColor: colors.subtle,
  },
  segment: {
    height: '24px',
    paddingInline: '10px',
    borderWidth: 0,
    borderRadius: radius.pill,
    backgroundColor: 'transparent',
    color: colors.muted,
  },
  segmentOn: { backgroundColor: colors.surface, color: colors.text, boxShadow: '0 1px 2px rgb(0 0 0 / 8%)' },
  stop: {
    width: '32px',
    height: '32px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    borderRadius: radius.pill,
  },
  empty: { padding: space.xl, color: colors.muted },
})

const toneText: Partial<Record<Tone, stylex.StyleXStyles>> = {
  info: styles.info,
  danger: styles.danger,
  attention: styles.attention,
}

// 状态文字的颜色：执行中蓝色、停止红色、状态未知橙色，其余灰色。
export function statusTextStyle(tone: Tone) {
  return toneText[tone] ?? styles.muted
}

const actionLabels: Record<ThreadAction, string> = {
  resume: 'Resume chat',
  newChat: 'New chat in this folder',
  chooseFolder: 'Choose folder',
  viewDevices: 'View devices',
  viewActivity: 'View activity',
}

export type RecoverAction = 'newChat' | 'chooseFolder'

function waitingCount(messages: Message[]) {
  return messages.filter((item) => item.delivery === 'queued' || item.delivery === 'waitingDevice').length
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function errorText(cause: unknown, fallback: string) {
  return cause instanceof ClientError ? cause.message : fallback
}

// reply 是 Agent 回复的序号，选中文字引用时写明来源。
function MessageItem({
  message,
  agent,
  deviceId,
  device,
  devices,
  reply,
  command = false,
  onOpen,
  onCancel,
}: {
  message: Message
  agent: Thread['agent']
  deviceId: ID
  device: Device | undefined
  devices: Device[]
  reply: number | null
  command?: boolean
  onOpen: (deviceId: ID, path: string) => void
  onCancel: (message: Message) => void
}) {
  // 回复里的路径指向 Thread 所在设备。
  const onOpenPath = (path: string) => onOpen(deviceId, path)
  const notice = threadMessageNotice(message, agent)
  if (notice) {
    return (
      <article id={`message-${message.id}`} {...stylex.props(styles.agent)}>
        <h3 {...stylex.props(text.bodyMedium)}>{notice.title}</h3>
        <p {...stylex.props(text.body, styles.muted)}>{notice.detail}</p>
      </article>
    )
  }
  if (message.role === 'agent') {
    return (
      <article id={`message-${message.id}`} {...stylex.props(text.body, styles.agent)}>
        <ActivityTrace message={message} device={device} command={command} />
        <div data-reply={reply}>
          <MessageBody body={message.body} onOpenPath={onOpenPath} />
        </div>
        {message.fullOutput && <FullOutput threadId={message.threadId} reference={message.fullOutput} />}
        <Attachments attachments={message.attachments} devices={devices} onOpen={onOpen} />
      </article>
    )
  }
  const cancel = (
    <>
      {' · '}
      <button type="button" onClick={() => onCancel(message)} {...stylex.props(styles.link, focusRing.ring)}>
        Cancel
      </button>
    </>
  )
  let note: ReactNode = null
  switch (message.delivery) {
    case 'submitted':
      note = 'Sending…'
      break
    case 'saved':
      note = 'Saved'
      break
    case 'queued':
      note = <>Sending next{cancel}</>
      break
    case 'waitingDevice':
      note = (
        <>
          Saved · sends when {device?.name ?? 'the device'} is online{cancel}
        </>
      )
      break
    case 'withdrawn':
      note = 'Not sent'
      break
  }
  return (
    <article id={`message-${message.id}`} {...stylex.props(styles.userItem)}>
      <div {...stylex.props(text.body, styles.user, message.delivery === 'withdrawn' && styles.withdrawn)}>
        {message.sender === 'projectAgent' && (
          <span {...stylex.props(text.caption, styles.sender)}>From project assistant</span>
        )}
        <MessageBody body={message.body} onOpenPath={onOpenPath} />
      </div>
      {message.delivery === 'unknown' ? (
        <span {...stylex.props(text.caption, styles.note, styles.noteUnknown)}>
          <Icon name="alert" size={12} />
          Delivery unknown
        </span>
      ) : (
        note && (
          <span {...stylex.props(text.caption, styles.note)}>
            {message.delivery !== 'withdrawn' && <Icon name="clock" size={12} />}
            <span>{note}</span>
          </span>
        )
      )}
    </article>
  )
}

function NoticeCard({ notice, action }: { notice: ThreadNotice; action: ReactNode }) {
  return (
    <div
      role="status"
      {...stylex.props(
        styles.notice,
        notice.tone === 'danger' && styles.noticeDanger,
        notice.tone === 'attention' && styles.noticeAttention,
      )}
    >
      <div {...stylex.props(styles.noticeBody)}>
        <span {...stylex.props(text.label)}>{notice.title}</span>
        <span {...stylex.props(text.caption, styles.muted)}>{notice.detail}</span>
      </div>
      {action}
    </div>
  )
}

function ModelMenu({
  thread,
  agent,
  onSelect,
}: {
  thread: Thread
  agent: DeviceAgent | undefined
  onSelect: (model: string) => void
}) {
  const name = thread.agent ? agentNames[thread.agent] : 'Command'
  return (
    <ThreadModelMenu
      side="top"
      mode="switch"
      agents={agent ? [agent] : []}
      choice={thread.agent ? { agent: thread.agent, model: thread.model } : null}
      label={thread.model || 'Default model'}
      lockedReason={
        agent?.abilities.switchModel
          ? undefined
          : `${name} cannot switch models in this chat. Start a new chat to choose another.`
      }
      onSelect={(choice) => onSelect(choice.model)}
    />
  )
}

type Confirm = 'stop' | 'archive' | null

// Thread 详情：时间线、状态说明和恢复办法、输入区。列表右侧的面板和单独的页面共用。
export function ThreadDetail({
  threadId,
  layout,
  onClose,
  onBack,
  onRecover,
}: {
  threadId: string
  layout: 'panel' | 'page'
  onClose?: () => void
  // Project 页里的详情替换了概览栏，返回按钮回到概览。
  onBack?: () => void
  // 用同一设备和目录新建对话，或重新选择目录。
  onRecover: (action: RecoverAction, thread: Thread) => void
}) {
  const navigate = useNavigate()
  const threadQuery = useThread(threadId)
  const devices = useDevices()
  const messages = useMessages(threadId)
  const inbox = useInbox()
  const projects = useProjects()
  const send = useSendMessage()
  const cancelMessage = useCancelMessage()
  const setModel = useSetThreadModel()
  const stop = useStopThread()
  const archive = useArchiveThread()
  const resume = useResumeThread()
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<SendMode>('next')
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [resumeId, setResumeId] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ deviceId: ID; path: string; reply: number | null } | null>(null)
  const timelineRef = useRef<HTMLDivElement | null>(null)
  const workspace = useWorkspace()
  const resumeOperation = useOperation(resumeId)

  const thread = threadQuery.data
  const projectArchived = projects.data?.find((item) => item.id === thread?.projectId)?.status === 'archived'
  const canAsk = !!thread?.projectId && projects.isSuccess && !projectArchived
  const device = devices.data?.find((item) => item.id === thread?.deviceId)
  const agent = device?.agents.find((item) => item.kind === thread?.agent)
  const list = messages.data ?? []
  const view = thread
    ? threadView(thread, device, {
        resume: agent?.abilities.resume,
        unknownDelivery: list.some((item) => item.delivery === 'unknown'),
      })
    : null
  const now = useNow(view?.live ? 1000 : null)

  // 新消息出现时滚到最后。
  useEffect(() => {
    const node = timelineRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [list.length])

  if (threadQuery.error instanceof ClientError && threadQuery.error.code === 'notFound') {
    return (
      <Shell layout={layout} title="Chat not found" onClose={onClose}>
        <p {...stylex.props(text.body, styles.empty)}>This chat was deleted or you no longer have access.</p>
      </Shell>
    )
  }
  if (threadQuery.isError) {
    return (
      <Shell layout={layout} title="Chat" onClose={onClose}>
        <div {...stylex.props(styles.empty)}>
          <Banner
            icon="alert"
            title="Could not load this chat"
            action={
              <Button small onClick={() => void threadQuery.refetch()}>
                Retry
              </Button>
            }
          />
        </div>
      </Shell>
    )
  }
  if (!thread || !view) return null

  const name = device?.name ?? 'the device'
  const agentName = thread.agent ? agentNames[thread.agent] : 'Command'
  const running = thread.status === 'running' && thread.pending === null && !thread.starting && !thread.resumePending
  const waiting = waitingCount(list)
  const resuming =
    !!thread.resumePending ||
    (resumeOperation.data !== undefined &&
      !['done', 'failed', 'stopped', 'conflict'].includes(resumeOperation.data.phase))
  const resumeFailed = resumeOperation.data?.phase === 'failed' ? resumeOperation.data.detail : null

  // 选中回复里的文字：属于 Project 时带着来源去问 Project 助手，否则复制。
  const describeSelection = (range: Range, value: string) => {
    const start = range.startContainer
    const element = start instanceof Element ? start : start.parentElement
    const body = element?.closest<HTMLElement>('[data-reply]')
    if (!body) return null
    if (!canAsk || !thread.projectId) return () => copySelection(value)
    const projectId = thread.projectId
    const reference: Reference = {
      kind: 'thread',
      title: thread.title,
      threadId,
      reply: Number(body.dataset.reply),
      deviceId: thread.deviceId,
      path: null,
      lines: null,
      itemId: null,
      ...shortenExcerpt(value),
    }
    return () => workspace.askProject(projectId, reference)
  }

  let replies = 0
  const openFile = (reply: number | null) => (deviceId: ID, path: string) => setPreview({ deviceId, path, reply })
  const deviceList = devices.data ?? []

  const onSend = () => {
    const body = draft.trim()
    if (!body || send.isPending) return
    setError(null)
    send.mutate(
      { threadId, body, clientId: newClientId(), mode: running ? mode : 'next' },
      {
        onSuccess: () => setDraft(''),
        onError: (cause) => setError(errorText(cause, 'Could not send. Try again.')),
      },
    )
  }

  const onSendNow = () => {
    if (agent?.abilities.steer) {
      setMode('now')
      setError(null)
      return
    }
    setError(`${agentName} can't read messages during a reply. Messages send after it finishes.`)
  }

  const onModel = (model: string) => {
    setError(null)
    setModel.mutate(
      { threadId, model },
      { onError: (cause) => setError(errorText(cause, 'Could not change the model. Try again.')) },
    )
  }

  const onCancel = (message: Message) => {
    setError(null)
    cancelMessage.mutate(message.id, {
      onError: (cause) => setError(errorText(cause, 'Could not cancel. Try again.')),
    })
  }

  const onStop = () => {
    stop.mutate(threadId, {
      onSuccess: () => setConfirm(null),
      onError: (cause) => {
        setConfirm(null)
        setError(errorText(cause, 'Could not stop. Try again.'))
      },
    })
  }

  const onArchive = () => {
    archive.mutate(threadId, {
      onSuccess: () => setConfirm(null),
      onError: (cause) => {
        setConfirm(null)
        setError(errorText(cause, 'Could not archive. Try again.'))
      },
    })
  }

  const onAction = (action: ThreadAction) => {
    setError(null)
    switch (action) {
      case 'resume':
        if (resuming || resume.isPending) return
        resume.mutate(threadId, {
          onSuccess: (operation) => setResumeId(operation.id),
          onError: (cause) => setError(errorText(cause, 'Could not resume. Try again.')),
        })
        return
      case 'newChat':
      case 'chooseFolder':
        onRecover(action, thread)
        return
      case 'viewDevices':
        void navigate({ to: '/devices' })
        return
      case 'viewActivity': {
        // 回到时间线里状态不确定的那条消息，由你判断要不要重发。
        const target = [...list].reverse().find((item) => item.delivery === 'unknown') ?? list[list.length - 1]
        const node = target ? document.getElementById(`message-${target.id}`) : null
        node?.scrollIntoView?.({ block: 'center' })
        timelineRef.current?.focus()
        return
      }
    }
  }

  let status: ReactNode = null
  if (error) status = error
  else if (resumeFailed) status = resumeFailed
  else if (resuming || resume.isPending) status = 'Resuming…'
  else if (thread.pending === 'stop' && view.live) status = 'Stopping… (forces quit in 1m)'
  else if (running) status = mode === 'now' ? 'Sends during the current reply' : 'Sends after current reply'

  const menuItems = [
    (running || thread.starting || thread.resumePending) && !thread.pending && (
      <MenuOption key="stop" onSelect={() => setConfirm('stop')}>
        Stop current reply
      </MenuOption>
    ),
    thread.status !== 'archived' && thread.pending !== 'archive' && (
      <MenuOption key="archive" onSelect={() => setConfirm('archive')}>
        Archive chat
      </MenuOption>
    ),
  ].filter(Boolean)
  const more = menuItems.length > 0 && (
    <Menu align="end" narrow trigger={<IconButton icon="dots" label="Chat actions" />}>
      {menuItems}
    </Menu>
  )

  const statusLabel = (
    <span {...stylex.props(text.caption, styles.headerStatus, statusTextStyle(view.status.tone))}>
      <StatusDot tone={view.status.tone} />
      {view.status.label}
    </span>
  )

  const body = (
    <div {...stylex.props(styles.split)}>
      <div {...stylex.props(styles.main)}>
        <div ref={timelineRef} tabIndex={-1} aria-label="Messages" role="region" {...stylex.props(styles.timeline)}>
          <SelectionArea
            label={canAsk ? 'Ask project assistant' : 'Copy selection'}
            icon={canAsk ? 'reply' : 'copy'}
            describe={describeSelection}
            style={[styles.messages, layout === 'panel' && styles.messagesPanel]}
          >
            <InboxFeedback />
            {messages.isPending && <p {...stylex.props(text.caption, styles.muted)}>Loading messages…</p>}
            {messages.isError && (
              <Banner
                icon="alert"
                title="Could not load messages"
                action={
                  <Button small onClick={() => void messages.refetch()}>
                    Retry
                  </Button>
                }
              />
            )}
            {[
              ...list.map((message) => ({ id: message.id, at: message.createdAt, message, item: null })),
              ...(inbox.data ?? [])
                .filter((item) => item.threadId === threadId)
                .map((item) => ({ id: item.id, at: item.createdAt, message: null, item })),
            ]
              .sort((a, b) => a.at - b.at)
              .map(({ message, item, id }) => {
                if (item) return <AttentionCard key={id} item={item} />
                if (!message) return null
                const reply = message.role === 'agent' ? ++replies : null
                return (
                  <MessageItem
                    key={message.id}
                    message={message}
                    agent={thread.agent}
                    deviceId={thread.deviceId}
                    device={device}
                    devices={deviceList}
                    reply={reply}
                    command={thread.agent === null}
                    onOpen={openFile(reply)}
                    onCancel={onCancel}
                  />
                )
              })}
            <LiveOutput thread={thread} device={device} live={view.live} now={now} />
          </SelectionArea>
        </div>
        <div {...stylex.props(styles.dock, layout === 'panel' && styles.dockPanel)}>
          {view.notice && (
            <NoticeCard
              notice={view.notice}
              action={
                view.notice.action && (
                  <Button
                    small
                    disabled={view.notice.action === 'resume' && (resuming || resume.isPending)}
                    onClick={() => onAction(view.notice!.action!)}
                  >
                    {actionLabels[view.notice.action]}
                  </Button>
                )
              }
            />
          )}
          {view.composer && (
            <Composer
              value={draft}
              onChange={setDraft}
              onSend={onSend}
              placeholder={`Message ${agentName} on ${device?.name ?? 'this device'}…`}
              style={styles.composer}
              chips={
                <>
                  <ModelMenu thread={thread} agent={agent} onSelect={onModel} />
                  <ThreadExecutionLimit key={thread.id} thread={thread} />
                </>
              }
              actions={
                running && (
                  <>
                    <div role="group" aria-label="Send mode" {...stylex.props(styles.segmented)}>
                      <button
                        type="button"
                        aria-pressed={mode === 'next'}
                        onClick={() => {
                          setMode('next')
                          setError(null)
                        }}
                        {...stylex.props(
                          text.caption,
                          styles.segment,
                          mode === 'next' && styles.segmentOn,
                          focusRing.ring,
                        )}
                      >
                        Send next
                      </button>
                      <button
                        type="button"
                        aria-pressed={mode === 'now'}
                        onClick={onSendNow}
                        {...stylex.props(
                          text.caption,
                          styles.segment,
                          mode === 'now' && styles.segmentOn,
                          focusRing.ring,
                        )}
                      >
                        Send now
                      </button>
                    </div>
                    <IconButton
                      icon="stop"
                      label="Stop current reply"
                      onClick={() => setConfirm('stop')}
                      style={styles.stop}
                    />
                  </>
                )
              }
            />
          )}
          <span
            role="status"
            {...stylex.props(text.caption, styles.status, (error !== null || resumeFailed !== null) && styles.danger)}
          >
            {status}
          </span>
          <div {...stylex.props(text.caption, styles.footer)}>
            <span {...stylex.props(styles.footerItem)}>
              <Icon name="laptop" size={12} />
              {device?.name ?? 'Removed device'}
            </span>
            <span {...stylex.props(styles.footerItem)}>
              <Icon name="folder" size={12} />
              <span title={thread.folder} {...stylex.props(text.mono, text.truncate)}>
                {thread.folder}
              </span>
            </span>
          </div>
        </div>
      </div>
    </div>
  )

  const dialogs = (
    <>
      {preview && (
        <FilePreview
          key={`${preview.deviceId}:${preview.path}`}
          deviceId={preview.deviceId}
          path={preview.path}
          onClose={() => setPreview(null)}
          projectId={thread.projectId}
          source={{ threadId, reply: preview.reply }}
        />
      )}
      <StopDialog
        open={confirm === 'stop'}
        onClose={() => setConfirm(null)}
        onConfirm={onStop}
        submitting={stop.isPending}
        canStop={thread.agent === null || !!agent?.abilities.stop}
        agentName={agentName}
        deviceName={name}
        waiting={waiting}
        finalFocus={timelineRef}
      />
      <ArchiveDialog
        open={confirm === 'archive'}
        onClose={() => setConfirm(null)}
        onConfirm={onArchive}
        submitting={archive.isPending}
        thread={thread}
        agent={agent}
        agentName={agentName}
        deviceName={name}
        waiting={waiting}
        finalFocus={timelineRef}
      />
    </>
  )

  if (layout === 'page') {
    return (
      <Page
        title={thread.title}
        actions={
          <>
            {statusLabel}
            {more}
          </>
        }
      >
        {body}
        {dialogs}
      </Page>
    )
  }

  return (
    <aside aria-label={thread.title} {...stylex.props(styles.panel)}>
      <div {...stylex.props(styles.header)}>
        {onBack && <IconButton icon="chevron-left" label="Back to overview" onClick={onBack} />}
        <h2 {...stylex.props(text.bodyMedium, styles.headerTitle, text.truncate)}>{thread.title}</h2>
        {statusLabel}
        <IconButton
          icon="external"
          label="Open in full page"
          onClick={() => void navigate({ to: '/threads/$threadId', params: { threadId } })}
        />
        {more}
        {onClose && <IconButton icon="close" label="Close chat" onClick={onClose} />}
      </div>
      {body}
      {dialogs}
    </aside>
  )
}

function Shell({
  layout,
  title,
  onClose,
  children,
}: {
  layout: 'panel' | 'page'
  title: string
  onClose?: () => void
  children: ReactNode
}) {
  if (layout === 'page') return <Page title={title}>{children}</Page>
  return (
    <aside aria-label={title} {...stylex.props(styles.panel)}>
      <div {...stylex.props(styles.header)}>
        <h2 {...stylex.props(text.bodyMedium, styles.headerStatus, text.truncate)}>{title}</h2>
        {onClose && <IconButton icon="close" label="Close chat" onClick={onClose} />}
      </div>
      {children}
    </aside>
  )
}

type FinalFocus = RefObject<HTMLElement | null>

function StopDialog({
  open,
  onClose,
  onConfirm,
  submitting,
  canStop,
  agentName,
  deviceName,
  waiting,
  finalFocus,
}: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  submitting: boolean
  canStop: boolean
  agentName: string
  deviceName: string
  waiting: number
  finalFocus: FinalFocus
}) {
  if (!canStop) {
    return (
      <Dialog
        open={open}
        onOpenChange={(next) => !next && onClose()}
        title="Stopping is unavailable"
        description={`${agentName} on ${deviceName} does not support stopping from Baton. Wait for the reply to finish, or stop it on the device.`}
        finalFocus={finalFocus}
        actions={<DialogClose render={<Button variant="primary">Back to chat</Button>} />}
      />
    )
  }
  const canceled = waiting > 0 ? ` and cancels ${plural(waiting, 'message')} waiting to send` : ''
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title="Stop current reply?"
      description={`Stops ${agentName} on ${deviceName}${canceled}. File changes and commands already run will not be undone. If ${agentName} does not stop within 1 minute, Baton ends its process.`}
      finalFocus={finalFocus}
      actions={
        <>
          <DialogClose render={<Button>Keep running</Button>} />
          <Button variant="danger" onClick={onConfirm}>
            {submitting ? 'Stopping…' : 'Stop reply'}
          </Button>
        </>
      }
    />
  )
}

function ArchiveDialog({
  open,
  onClose,
  onConfirm,
  submitting,
  thread,
  agent,
  agentName,
  deviceName,
  waiting,
  finalFocus,
}: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  submitting: boolean
  thread: Thread
  agent: DeviceAgent | undefined
  agentName: string
  deviceName: string
  waiting: number
  finalFocus: FinalFocus
}) {
  const running = thread.status === 'running' || !!thread.starting || !!thread.resumePending
  if (running && thread.agent !== null && !agent?.abilities.stop) {
    return (
      <Dialog
        open={open}
        onOpenChange={(next) => !next && onClose()}
        title="Archiving is unavailable"
        description={`${agentName} is still running on ${deviceName} and does not support stopping from Baton. Archive this chat after the reply finishes.`}
        finalFocus={finalFocus}
        actions={<DialogClose render={<Button variant="primary">Back to chat</Button>} />}
      />
    )
  }
  const canceled = waiting > 0 ? ` ${plural(waiting, 'message')} waiting to send will be canceled.` : ''
  const description = running
    ? `${agentName} is still running on ${deviceName}. Baton stops it first and archives the chat after the device confirms.${canceled} You can still read archived chats.`
    : `The chat stays readable but can't receive new messages.${canceled}`
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title="Archive this chat?"
      description={description}
      finalFocus={finalFocus}
      actions={
        <>
          <DialogClose render={<Button>Keep chat</Button>} />
          <Button variant={running ? 'danger' : 'primary'} onClick={onConfirm}>
            {submitting ? 'Archiving…' : running ? 'Stop and archive' : 'Archive chat'}
          </Button>
        </>
      }
    />
  )
}
