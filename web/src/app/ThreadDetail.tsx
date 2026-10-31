import * as stylex from '@stylexjs/stylex'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { memo, useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { ClientError, isAccessError } from '../data/client'
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
  keys,
  useArchiveThread,
  useAnswerThreadQuestion,
  useCancelMessage,
  useDevices,
  useMessages,
  useClient,
  useLiveOutput,
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
import { semantic } from '../theme/semantic.stylex'
import { radius, shadow, size, space } from '../theme/tokens.stylex'
import { AgentMark } from '../ui/Avatar'
import { Banner } from '../ui/Banner'
import { Button, focusRing, IconButton } from '../ui/Button'
import { Composer } from '../ui/Composer'
import { Dialog, DialogClose } from '../ui/Dialog'
import { Icon } from '../ui/Icon'
import { JumpToLatest } from '../ui/JumpToLatest'
import { useChatScroll } from '../ui/useChatScroll'
import { Menu, MenuOption } from '../ui/Menu'
import { StatusDot, type Tone } from '../ui/Status'
import { ThreadAccessMenu } from './ThreadAccessMenu'
import { LocalThreadActions } from './LocalThreadActions'
import { FilePreview } from './FilePreview'
import { MessageBody } from './MessageBody'
import { MessageActions } from './MessageActions'
import { Page, pane } from './Page'
import { ActivityTrace, Attachments, TurnActivityTrace, LiveOutput } from './ReplyParts'
import { copySelection, SelectionArea } from './SelectionMenu'
import { ThreadQuestionForm } from './ThreadQuestionForm'
import { ThreadQuestionAnswerStatus } from './ThreadQuestionAnswerStatus'
import { ThreadModelMenu } from './ThreadModelMenu'
import { modelThinking, ThinkingMenu } from './ThinkingMenu'
import { useNow } from './useNow'
import { useWorkspace } from './workspace'

const styles = stylex.create({
  panel: {
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
    width: '100%',
    minWidth: 0,
    height: '100%',
    backgroundColor: semantic.card,
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
    borderBottomColor: semantic.border,
  },
  headerTitle: { flexShrink: 1 },
  headerStatus: { display: 'inline-flex', alignItems: 'center', gap: '6px', flexGrow: 1, whiteSpace: 'nowrap' },
  split: { display: 'flex', height: '100%', minHeight: 0 },
  main: { position: 'relative', display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0, minHeight: 0 },
  timelineFrame: { position: 'relative', display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 },
  timeline: { flexGrow: 1, minHeight: 0, overflowY: 'auto', outline: 'none' },
  syncNotice: { position: 'absolute', top: space.sm, right: space.md, zIndex: 1, backgroundColor: semantic.card },
  messages: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.xl,
    width: '100%',
    maxWidth: size.measure,
    marginInline: 'auto',
    padding: space.xl,
    paddingBottom: space.xl,
  },
  messagesPanel: { paddingInline: space.lg },
  userItem: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px' },
  // Project Agent 发来的消息在气泡左下角带它的标记。
  userLine: { display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end', gap: space.sm, maxWidth: '85%' },
  user: {
    minWidth: 0,
    paddingBlock: space.sm,
    paddingInline: space.md,
    borderRadius: radius.lg,
    backgroundColor: semantic.secondary,
  },
  withdrawn: { color: semantic.mutedForeground },
  agent: { display: 'flex', flexDirection: 'column', gap: space.md, alignSelf: 'stretch', minWidth: 0 },
  note: { display: 'inline-flex', alignItems: 'center', gap: '4px', color: semantic.faintForeground },
  noteUnknown: { color: semantic.warningForeground },
  link: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: semantic.brandForeground,
    textDecoration: { default: 'none', ':hover': 'underline' },
  },
  agentText: { color: semantic.agentForeground },
  muted: { color: semantic.mutedForeground },
  danger: { color: semantic.destructiveForeground },
  attention: { color: semantic.warningForeground },
  dock: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    flexShrink: 0,
    maxHeight: '55%',
    overflowY: 'auto',
    paddingTop: space.md,
    paddingInline: space.xl,
    paddingBottom: space.md,
  },
  dockContent: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: space.sm,
    width: '100%',
    maxWidth: size.measure,
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
    backgroundColor: semantic.sidebar,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: semantic.border,
    borderRadius: radius.md,
  },
  noticeDanger: { backgroundColor: semantic.destructiveSoft },
  noticeCompact: { padding: 0, borderWidth: 0, backgroundColor: 'transparent' },
  noticeBodyCompact: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', gap: '4px' },
  noticeAttention: {
    paddingBlock: '14px',
    paddingLeft: '18px',
    paddingRight: '14px',
    backgroundColor: semantic.inverse,
    borderColor: 'transparent',
    borderRadius: radius.xl,
    boxShadow: shadow.floating,
    color: semantic.onInverse,
  },
  noticeDetailInverse: { color: semantic.onInverseMuted },
  noticeBody: { display: 'flex', flexDirection: 'column', gap: '2px', flexGrow: 1, minWidth: 0 },
  composer: { maxWidth: size.measure },
  status: { width: '100%', maxWidth: size.measure, color: semantic.mutedForeground },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: space.md,
    width: '100%',
    maxWidth: size.measure,
    color: semantic.faintForeground,
  },
  footerItem: { display: 'inline-flex', alignItems: 'center', gap: '4px', minWidth: 0 },
  segmented: {
    display: 'inline-flex',
    padding: '2px',
    borderRadius: radius.pill,
    backgroundColor: semantic.secondary,
  },
  segment: {
    height: '24px',
    paddingInline: '10px',
    borderWidth: 0,
    borderRadius: radius.pill,
    backgroundColor: 'transparent',
    color: semantic.mutedForeground,
  },
  segmentOn: { backgroundColor: semantic.card, color: semantic.foreground, boxShadow: shadow.control },
  stop: {
    width: '32px',
    height: '32px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: semantic.input,
    borderRadius: radius.pill,
  },
  empty: { padding: space.xl, color: semantic.mutedForeground },
})

const toneText: Partial<Record<Tone, stylex.StyleXStyles>> = {
  agent: styles.agentText,
  danger: styles.danger,
  attention: styles.attention,
}

// 状态文字的颜色：运行中用 Agent 色、失败红色、需要处理橙色，其余灰色。
export function statusTextStyle(tone: Tone) {
  return toneText[tone] ?? styles.muted
}

const actionLabels: Record<ThreadAction, string> = {
  resume: '恢复对话',
  newChat: '在此文件夹新建对话',
  chooseFolder: '选择文件夹',
  viewDevices: '查看设备',
  viewActivity: '查看执行过程',
}

export type RecoverAction = 'newChat' | 'chooseFolder'

function waitingCount(messages: Message[]) {
  return messages.filter((item) => item.delivery === 'queued' || item.delivery === 'waitingDevice').length
}

function errorText(cause: unknown, fallback: string) {
  return cause instanceof ClientError ? cause.message : fallback
}

// reply 是 Agent 回复的序号，选中文字引用时写明来源。
const MessageItem = memo(function MessageItem({
  message,
  agent,
  deviceId,
  device,
  devices,
  reply,
  command = false,
  latest = false,
  outputGap = false,
  traceInMessage = true,
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
  latest?: boolean
  outputGap?: boolean
  traceInMessage?: boolean
  onOpen: (reply: number | null, deviceId: ID, path: string) => void
  onCancel: (message: Message) => void
}) {
  const [actionsRevealed, setActionsRevealed] = useState(false)
  // 回复里的路径指向 Thread 所在设备。
  const onOpenPath = (path: string) => onOpen(reply, deviceId, path)
  const notice = threadMessageNotice(message, agent)
  if (message.role === 'interrupted')
    return (
      <p role="status" {...stylex.props(text.caption, styles.muted)}>
        {message.body}
      </p>
    )
  if (message.role === 'activity') {
    return (
      <article id={`message-${message.id}`} {...stylex.props(styles.agent)}>
        {traceInMessage && <ActivityTrace message={message} device={device} command={command} />}
      </article>
    )
  }
  if (notice) {
    return (
      <article id={`message-${message.id}`} {...stylex.props(styles.agent)}>
        {traceInMessage && <ActivityTrace message={message} device={device} command={command} />}
        <h3 {...stylex.props(text.bodyMedium)}>{notice.title}</h3>
        {notice.detail && <p {...stylex.props(text.body, styles.muted)}>{notice.detail}</p>}
      </article>
    )
  }
  if (message.role === 'agent') {
    return (
      <article
        id={`message-${message.id}`}
        data-thread-reply=""
        data-latest-reply={latest ? '' : undefined}
        data-actions-revealed={actionsRevealed ? '' : undefined}
        onPointerUp={(event) => {
          if (event.pointerType !== 'touch' || latest || !(event.target instanceof Element)) return
          if (event.target.closest('button, a, input, textarea, select') || !window.getSelection()?.isCollapsed) return
          setActionsRevealed((shown) => !shown)
        }}
        {...stylex.props(text.body, styles.agent)}
      >
        {traceInMessage && <ActivityTrace message={message} device={device} command={command} />}
        <div data-reply={reply}>
          {outputGap && <span {...stylex.props(text.caption, styles.muted)}>较早的输出未保留</span>}
          <MessageBody body={message.body} onOpenPath={onOpenPath} streaming={message.streaming} />
        </div>
        {message.truncated && (
          <span {...stylex.props(text.caption, styles.muted)}>内容已截断，原始大小 {message.originalBytes} 字节</span>
        )}
        <Attachments
          attachments={message.attachments}
          devices={devices}
          onOpen={(id, path) => onOpen(reply, id, path)}
        />
        {message.body && <MessageActions body={message.body} thread />}
      </article>
    )
  }
  const cancel = (
    <>
      {' · '}
      <button type="button" onClick={() => onCancel(message)} {...stylex.props(styles.link, focusRing.ring)}>
        取消
      </button>
    </>
  )
  let note: ReactNode = null
  switch (message.delivery) {
    case 'submitted':
      note = '正在发送…'
      break
    case 'saved':
      note = '已保存'
      break
    case 'queued':
      note = <>下一条发送{cancel}</>
      break
    case 'waitingDevice':
      note = <>设备上线后发送{cancel}</>
      break
    case 'withdrawn':
      note = '未发送'
      break
  }
  return (
    <article id={`message-${message.id}`} {...stylex.props(styles.userItem)}>
      <div {...stylex.props(styles.userLine)}>
        {message.sender === 'projectAgent' && <AgentMark label="来自项目助手" />}
        <div {...stylex.props(text.body, styles.user, message.delivery === 'withdrawn' && styles.withdrawn)}>
          <MessageBody body={message.body} onOpenPath={onOpenPath} keepLineBreaks />
        </div>
      </div>
      {message.delivery === 'unknown' ? (
        <span
          role="img"
          aria-label="发送状态未知"
          title="发送状态未知"
          {...stylex.props(text.caption, styles.note, styles.noteUnknown)}
        >
          <Icon name="alert" size={12} />
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
})

function NoticeCard({
  notice,
  action,
  compact = false,
}: {
  notice: ThreadNotice
  action: ReactNode
  compact?: boolean
}) {
  return (
    <div
      role="status"
      {...stylex.props(
        styles.notice,
        compact && styles.noticeCompact,
        notice.tone === 'danger' && styles.noticeDanger,
        notice.tone === 'attention' && styles.noticeAttention,
      )}
    >
      <div {...stylex.props(styles.noticeBody, compact && styles.noticeBodyCompact)}>
        <span {...stylex.props(compact ? text.caption : text.label)}>{notice.title}</span>
        {compact && notice.detail && (
          <span aria-hidden="true" {...stylex.props(text.caption, styles.muted)}>
            ·
          </span>
        )}
        {notice.detail && (
          <span
            {...stylex.props(text.caption, styles.muted, notice.tone === 'attention' && styles.noticeDetailInverse)}
          >
            {notice.detail}
          </span>
        )}
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
  const name = thread.agent ? agentNames[thread.agent] : '命令'
  return (
    <ThreadModelMenu
      side="top"
      mode="switch"
      agents={agent ? [agent] : []}
      choice={thread.agent ? { agent: thread.agent, model: thread.model } : null}
      label={thread.model || '默认模型'}
      lockedReason={agent?.abilities.switchModel ? undefined : `${name} 无法在此对话中切换模型。`}
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
  const client = useClient()
  const queryClient = useQueryClient()
  const threadQuery = useThread(threadId)
  const liveOutput = useLiveOutput(
    threadId,
    threadQuery.data?.status === 'running' && threadQuery.data.runStartedAt !== null,
  )
  const devices = useDevices()
  const messages = useMessages(threadId)
  const projects = useProjects()
  const send = useSendMessage()
  const cancelMessage = useCancelMessage()
  const cancel = cancelMessage.mutate
  const setModel = useSetThreadModel()
  const answerQuestion = useAnswerThreadQuestion()
  const stop = useStopThread()
  const archive = useArchiveThread()
  const resume = useResumeThread()
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<SendMode>('next')
  const [thinkingChoice, setThinkingChoice] = useState<{
    key: string
    value: import('@baton/protocol').ThinkingSelection | null
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [resumeId, setResumeId] = useState<string | null>(null)
  const [previousOutput, setPreviousOutput] = useState<{
    threadId: ID
    value: NonNullable<typeof liveOutput.data>
  } | null>(null)
  const [interruptedOutput, setInterruptedOutput] = useState<{
    threadId: string
    seq: number
    at: number
    pending?: boolean
    replyId?: string
  } | null>(null)
  const [preview, setPreview] = useState<{ deviceId: ID; path: string; reply: number | null } | null>(null)
  const timelineRef = useRef<HTMLDivElement | null>(null)
  const workspace = useWorkspace()
  const resumeOperation = useOperation(resumeId)
  const openMessageFile = useCallback((reply: number | null, deviceId: ID, path: string) => {
    setPreview({ deviceId, path, reply })
  }, [])
  const onCancel = useCallback(
    (message: Message) => {
      setError(null)
      cancel(message.id, {
        onError: (cause) => setError(errorText(cause, '无法取消，请重试。')),
      })
    },
    [cancel],
  )

  const thread = threadQuery.data
  const projectArchived = projects.data?.find((item) => item.id === thread?.projectId)?.status === 'archived'
  const canAsk = !!thread?.projectId && projects.isSuccess && !projectArchived
  const device = devices.data?.find((item) => item.id === thread?.deviceId)
  const agent = device?.agents.find((item) => item.kind === thread?.agent)
  const thinking = modelThinking(agent, thread?.model || agent?.defaultModel || '')
  const thinkingKey = JSON.stringify([threadId, thread?.model])
  const selectedThinking = thinkingChoice?.key === thinkingKey ? thinkingChoice.value : thread?.thinking
  const validThinking =
    thinking &&
    selectedThinking?.id === thinking.id &&
    thinking.options.some((option) => option.id === selectedThinking.value)
      ? selectedThinking
      : undefined
  const list = messages.data ?? []
  const currentOutput = liveOutput.data
  const currentOutputMatched =
    currentOutput?.replyId &&
    currentOutput.workerTurnSeq !== undefined &&
    list.some(
      (message) =>
        message.role === 'agent' &&
        message.replyId === currentOutput.replyId &&
        message.workerTurnSeq === currentOutput.workerTurnSeq,
    )
  const savedOutput = previousOutput?.threadId === threadId ? previousOutput.value : undefined
  const savedOutputMatched =
    savedOutput?.replyId &&
    savedOutput.workerTurnSeq !== undefined &&
    list.some(
      (message) =>
        message.role === 'agent' &&
        message.replyId === savedOutput.replyId &&
        message.workerTurnSeq === savedOutput.workerTurnSeq,
    )
  const endedTurn = thread?.timelineTurns?.find((turn) => turn.seq === savedOutput?.workerTurnSeq && turn.ended)
  const interrupted = !!endedTurn && !!savedOutput?.replyId && !endedTurn.replyIds.includes(savedOutput.replyId)
  const currentTurn = thread?.timelineTurns?.find((turn) => turn.seq === currentOutput?.workerTurnSeq && turn.ended)
  const currentInterrupted =
    !!currentTurn && !!currentOutput?.replyId && !currentTurn.replyIds.includes(currentOutput.replyId)
  if (
    thread?.status === 'running' &&
    currentOutput?.replyId &&
    currentOutput.workerTurnSeq !== undefined &&
    (thread.runTurnSeq === undefined || thread.runTurnSeq === currentOutput.workerTurnSeq) &&
    currentOutput.chunks.length > 0 &&
    !thread.timelineTurns?.some((turn) => turn.seq === currentOutput.workerTurnSeq && turn.ended) &&
    !currentOutputMatched &&
    (previousOutput?.threadId !== threadId || previousOutput.value !== currentOutput)
  ) {
    setPreviousOutput({ threadId, value: currentOutput })
  } else if (
    previousOutput &&
    (previousOutput.threadId !== threadId ||
      savedOutputMatched ||
      interrupted ||
      (thread?.status === 'running' &&
        thread.runTurnSeq !== undefined &&
        thread.runTurnSeq !== previousOutput.value.workerTurnSeq))
  ) {
    if (interrupted && endedTurn) setInterruptedOutput({ threadId, seq: endedTurn.seq, at: endedTurn.startedAt })
    else if (
      previousOutput.threadId === threadId &&
      thread?.status === 'running' &&
      thread.runTurnSeq !== undefined &&
      thread.runTurnSeq !== previousOutput.value.workerTurnSeq &&
      previousOutput.value.workerTurnSeq !== undefined &&
      !savedOutputMatched
    )
      setInterruptedOutput({
        threadId,
        seq: previousOutput.value.workerTurnSeq,
        at:
          thread.timelineTurns?.find((turn) => turn.seq === previousOutput.value.workerTurnSeq)?.startedAt ??
          thread.runStartedAt ??
          0,
        pending: true,
        replyId: previousOutput.value.replyId,
      })
    setPreviousOutput(null)
  }
  const pendingTurn =
    interruptedOutput?.pending && interruptedOutput.threadId === threadId
      ? thread?.timelineTurns?.find((turn) => turn.seq === interruptedOutput.seq && turn.ended)
      : undefined
  if (pendingTurn && interruptedOutput) {
    const replyExists = !!interruptedOutput.replyId && pendingTurn.replyIds.includes(interruptedOutput.replyId)
    const replyLoaded = list.some(
      (message) => message.workerTurnSeq === pendingTurn.seq && message.replyId === interruptedOutput.replyId,
    )
    if (!replyExists) setInterruptedOutput({ ...interruptedOutput, pending: false })
    else if (replyLoaded) setInterruptedOutput(null)
  }
  const output =
    interrupted || currentInterrupted
      ? undefined
      : thread?.status === 'running'
        ? currentOutput &&
          currentOutput.chunks.length > 0 &&
          (thread.runTurnSeq === undefined || currentOutput.workerTurnSeq === thread.runTurnSeq)
          ? currentOutput
          : thread.runTurnSeq === undefined || thread.runTurnSeq === savedOutput?.workerTurnSeq
            ? savedOutput
            : undefined
        : !savedOutputMatched && !interrupted
          ? savedOutput
          : undefined
  const liveAt =
    thread?.timelineTurns?.find((turn) => turn.seq === output?.workerTurnSeq)?.startedAt ?? thread?.runStartedAt ?? 0
  const liveReply =
    thread?.agent &&
    output?.replyId &&
    output.workerTurnSeq !== undefined &&
    output.chunks.length > 0 &&
    !list.some(
      (message) =>
        message.role === 'agent' &&
        message.replyId === output.replyId &&
        message.workerTurnSeq === output.workerTurnSeq,
    )
      ? {
          id: `live:${output.workerTurnSeq}:${output.replyId}`,
          threadId,
          role: 'agent' as const,
          sender: 'agent' as const,
          body: output.chunks
            .filter((chunk) => chunk.kind === 'text')
            .map((chunk) => chunk.text)
            .join(''),
          streaming: thread.status === 'running' && !!currentOutput?.replyId && currentOutput.chunks.length > 0,
          replyId: output.replyId,
          workerTurnSeq: output.workerTurnSeq,
          createdAt: liveAt,
          timelineAt: liveAt,
          timelineOrder: Number.MAX_SAFE_INTEGER,
          delivery: 'delivered' as const,
          activity: null,
          attachments: [],
        }
      : null
  const latestReplyId = [...list, ...(liveReply ? [liveReply] : [])].findLast(
    (message) => message.role === 'agent' && !!message.body,
  )?.id
  const view = thread
    ? threadView(thread, device, {
        resume: agent?.abilities.resume,
        unknownDelivery: list.some((item) => item.delivery === 'unknown'),
      })
    : null
  const now = useNow(view?.live ? 1000 : null)

  const {
    awayFromLatest,
    followLatest,
    onScroll: onTimelineScroll,
    scrollToLatest: jumpToLatest,
  } = useChatScroll(timelineRef, { resetKey: threadId, ready: threadQuery.isSuccess })
  useEffect(() => followLatest(), [list.length, followLatest])

  useEffect(() => {
    if (thread?.unread && messages.isSuccess && !messages.isFetching) client.markThreadRead?.(threadId)
  }, [client, threadId, thread?.unread, messages.isSuccess, messages.isFetching])

  if (isAccessError(threadQuery.error) || isAccessError(messages.error)) {
    return (
      <Shell layout={layout} title="未找到对话" onClose={onClose}>
        <p {...stylex.props(text.body, styles.empty)}>对话已删除，或你已无权访问。</p>
      </Shell>
    )
  }
  if (threadQuery.isError && !thread) {
    return (
      <Shell layout={layout} title="对话" onClose={onClose}>
        <div {...stylex.props(styles.empty)}>
          <Banner
            icon="alert"
            title="无法加载对话"
            action={
              <Button small onClick={() => void threadQuery.refetch()}>
                重试
              </Button>
            }
          />
        </div>
      </Shell>
    )
  }
  if (!thread || !view)
    return (
      <Shell
        layout={layout}
        title={queryClient.getQueryData<Thread[]>(keys.threads)?.find((item) => item.id === threadId)?.title ?? '对话'}
        onClose={onClose}
      >
        <p role="status" {...stylex.props(text.caption, styles.empty)}>
          正在加载对话…
        </p>
      </Shell>
    )

  const name = device?.name ?? '设备'
  const agentName = thread.agent ? agentNames[thread.agent] : '命令'
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
      ...shortenExcerpt(value),
    }
    return () => workspace.askProject(projectId, reference)
  }

  let replies = 0
  const interruption: Message | null =
    interruptedOutput?.threadId === threadId
      ? {
          id: `interrupted:${interruptedOutput.seq}`,
          threadId,
          role: 'interrupted',
          sender: 'agent',
          body: interruptedOutput.pending ? '上一条回复的保存状态待确认。' : '回复中断，内容未保存。',
          createdAt: interruptedOutput.at,
          timelineAt: interruptedOutput.at,
          workerTurnSeq: interruptedOutput.seq,
          delivery: 'delivered',
          activity: null,
          traceItemCount: 0,
          attachments: [],
        }
      : null
  const activityTurns = new Set<number>()
  const activityCounts = new Map<number, { count: number; messageId: string }>()
  for (const item of list) {
    if (item.workerTurnSeq !== undefined && (item.traceItemCount ?? 0) > 0)
      activityCounts.set(item.workerTurnSeq, { count: item.traceItemCount!, messageId: item.id })
  }
  const timelineMessages = [
    ...list,
    ...(liveReply ? [liveReply] : []),
    ...(interruption ? [interruption] : []),
  ].flatMap((message) => {
    const seq = message.workerTurnSeq
    const liveTurn = thread.status === 'running' && thread.runTurnSeq === seq
    const count = seq === undefined ? undefined : activityCounts.get(seq)?.count
    const at = message.timelineAt ?? message.createdAt
    const activity =
      message.role !== 'user' && seq !== undefined && !activityTurns.has(seq) && (liveTurn || (count ?? 0) > 0)
    if (activity) activityTurns.add(seq)
    return [
      ...(activity
        ? [
            {
              id: `activity:${seq}`,
              at,
              order: (message.timelineOrder ?? Number.MAX_SAFE_INTEGER) - 0.5,
              message: null,
              liveTurn: seq,
              count,
              active: liveTurn,
            },
          ]
        : []),
      {
        id:
          message.role === 'agent' && message.replyId && seq !== undefined
            ? `reply:${seq}:${message.replyId}`
            : message.id,
        at,
        order: message.timelineOrder ?? Number.MAX_SAFE_INTEGER,
        message,
        liveTurn: null,
        count: undefined,
        active: false,
      },
    ]
  })
  const openFile = (reply: number | null) => (deviceId: ID, path: string) => setPreview({ deviceId, path, reply })
  const deviceList = devices.data ?? []

  const onSend = () => {
    const body = draft.trim()
    if (!body || send.isPending) return
    setError(null)
    send.mutate(
      {
        threadId,
        body,
        clientId: newClientId(),
        mode: running ? mode : 'next',
        ...(validThinking && !(running && mode === 'now') ? { thinking: validThinking } : {}),
      },
      {
        onSuccess: () => setDraft(''),
        onError: (cause) => setError(errorText(cause, '无法发送，请重试。')),
      },
    )
  }

  const onSendNow = () => {
    if (agent?.abilities.steer) {
      setMode('now')
      setError(null)
      return
    }
    setError(`${agentName} 回复时无法读取新消息，消息将在回复结束后发送。`)
  }

  const onModel = (model: string) => {
    setError(null)
    setModel.mutate({ threadId, model }, { onError: (cause) => setError(errorText(cause, '无法更换模型，请重试。')) })
  }

  const onStop = () => {
    stop.mutate(threadId, {
      onSuccess: () => setConfirm(null),
      onError: (cause) => {
        setConfirm(null)
        setError(errorText(cause, '无法停止，请重试。'))
      },
    })
  }

  const onArchive = () => {
    archive.mutate(threadId, {
      onSuccess: () => setConfirm(null),
      onError: (cause) => {
        setConfirm(null)
        setError(errorText(cause, '无法归档，请重试。'))
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
          onError: (cause) => setError(errorText(cause, '无法恢复，请重试。')),
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
  else if (resuming || resume.isPending) status = '正在恢复…'
  else if (thread.pending === 'stop' && view.live) status = '正在停止…'
  else if (running) status = mode === 'now' ? '在当前回复期间发送' : '当前回复结束后发送'

  const menuItems = [
    (running || thread.starting || thread.resumePending) && !thread.pending && (
      <MenuOption key="stop" onSelect={() => setConfirm('stop')}>
        停止当前回复
      </MenuOption>
    ),
    thread.status !== 'archived' && thread.pending !== 'archive' && (
      <MenuOption key="archive" onSelect={() => setConfirm('archive')}>
        归档对话
      </MenuOption>
    ),
  ].filter(Boolean)
  const more = menuItems.length > 0 && (
    <Menu align="end" trigger={<IconButton icon="dots" label="对话操作" />}>
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
        {(threadQuery.isError || (messages.isError && messages.data)) && (
          <div role="status" {...stylex.props(text.caption, styles.syncNotice)}>
            更新失败，显示上次内容。{' '}
            <button
              type="button"
              onClick={() => {
                void threadQuery.refetch()
                void messages.refetch()
              }}
              {...stylex.props(styles.link, focusRing.ring)}
            >
              重试
            </button>
          </div>
        )}
        <div {...stylex.props(styles.timelineFrame)}>
          <div
            ref={timelineRef}
            tabIndex={-1}
            aria-label="消息记录"
            role="region"
            onScroll={onTimelineScroll}
            {...stylex.props(styles.timeline)}
          >
            <SelectionArea
              label={canAsk ? '询问项目助手' : '复制所选内容'}
              icon={canAsk ? 'reply' : 'copy'}
              describe={describeSelection}
              style={[styles.messages, layout === 'panel' && styles.messagesPanel]}
            >
              {messages.isPending && <p {...stylex.props(text.caption, styles.muted)}>正在加载消息…</p>}
              {messages.isError && !messages.data && (
                <Banner
                  icon="alert"
                  title="无法加载消息"
                  action={
                    <Button small onClick={() => void messages.refetch()}>
                      重试
                    </Button>
                  }
                />
              )}
              {[
                ...timelineMessages,
                ...(thread.status === 'running' &&
                thread.runTurnSeq !== undefined &&
                !activityTurns.has(thread.runTurnSeq)
                  ? [
                      {
                        id: `activity:${thread.runTurnSeq}`,
                        at: Number.MAX_SAFE_INTEGER - 1,
                        order: Number.MAX_SAFE_INTEGER,
                        message: null,
                        liveTurn: thread.runTurnSeq,
                        count: undefined,
                        active: true,
                      },
                    ]
                  : []),
              ]
                .sort((a, b) => a.at - b.at || a.order - b.order || a.id.localeCompare(b.id))
                .map(({ message, id, liveTurn, count, active }) => {
                  if (liveTurn !== null)
                    return (
                      <TurnActivityTrace
                        key={id}
                        threadId={threadId}
                        turnSeq={liveTurn}
                        device={device}
                        live={active}
                        count={count}
                        messageId={activityCounts.get(liveTurn)?.messageId}
                        runningSteps={
                          active && liveOutput.data?.workerTurnSeq === liveTurn
                            ? liveOutput.data.runningSteps
                            : undefined
                        }
                        runningStepsTruncated={
                          active && liveOutput.data?.workerTurnSeq === liveTurn
                            ? liveOutput.data.runningStepsTruncated
                            : false
                        }
                      />
                    )
                  if (!message) return null
                  const reply = message.role === 'agent' ? ++replies : null
                  return (
                    <MessageItem
                      key={id}
                      message={message}
                      agent={thread.agent}
                      deviceId={thread.deviceId}
                      device={device}
                      devices={deviceList}
                      reply={reply}
                      command={false}
                      latest={message.id === latestReplyId}
                      outputGap={message === liveReply && output?.chunks.some((chunk) => chunk.kind === 'gap')}
                      traceInMessage={message.workerTurnSeq === undefined || !activityTurns.has(message.workerTurnSeq)}
                      onOpen={openMessageFile}
                      onCancel={onCancel}
                    />
                  )
                })}
              <LiveOutput
                thread={thread}
                device={device}
                live={view.live}
                now={now}
                messages={list}
                onOpenPath={(path) => openFile(null)(thread.deviceId, path)}
                output={output}
                outputError={liveOutput.isError && device?.connection === 'online'}
                onRetryOutput={() => void liveOutput.refetch()}
                showReply={liveReply === null && output?.workerTurnSeq === undefined}
              />
            </SelectionArea>
          </div>
          {awayFromLatest && <JumpToLatest onClick={jumpToLatest} />}
        </div>
        <div {...stylex.props(styles.dock, layout === 'panel' && styles.dockPanel)}>
          <div {...stylex.props(styles.dockContent)}>
            {thread.pendingQuestions?.map((question) => (
              <ThreadQuestionForm
                key={`${thread.id}:${question.request_id}`}
                question={question}
                onAnswer={async (answer) => {
                  await answerQuestion.mutateAsync({ threadId: thread.id, answer })
                }}
              />
            ))}
            {thread.questionAnswers?.[0] && (
              <ThreadQuestionAnswerStatus
                answer={thread.questionAnswers[0]}
                offline={device?.connection !== 'online'}
              />
            )}
            {view.notice && (
              <NoticeCard
                notice={view.notice}
                compact={thread.status === 'idle' && device?.connection !== 'online' && !view.notice.action}
                action={
                  view.notice.action && (
                    <Button small onClick={() => onAction(view.notice!.action!)}>
                      {view.notice.action === 'resume' && thread.retryOpenAllowed
                        ? '重试打开'
                        : actionLabels[view.notice.action]}
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
                placeholder={`给 ${agentName} 发消息…`}
                style={styles.composer}
                chips={
                  <>
                    <ModelMenu thread={thread} agent={agent} onSelect={onModel} />
                    <ThinkingMenu
                      capability={thinking}
                      selection={validThinking}
                      side="top"
                      lockedReason={running && mode === 'now' ? '插话沿用当前回复的思考强度' : undefined}
                      onSelect={(value) => setThinkingChoice({ key: thinkingKey, value })}
                    />
                    {thread.agent && thread.runtimeMode && (
                      <ThreadAccessMenu side="top" mode={thread.runtimeMode} agent={agent} />
                    )}
                  </>
                }
                actions={
                  running && (
                    <>
                      <div role="group" aria-label="发送方式" {...stylex.props(styles.segmented)}>
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
                          下一条发送
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
                          立即发送
                        </button>
                      </div>
                      <IconButton
                        icon="stop"
                        label="停止当前回复"
                        onClick={() => setConfirm('stop')}
                        style={styles.stop}
                      />
                    </>
                  )
                }
              />
            )}
            {status && (
              <span
                role="status"
                {...stylex.props(
                  text.caption,
                  styles.status,
                  (error !== null || resumeFailed !== null) && styles.danger,
                )}
              >
                {status}
              </span>
            )}
            <div {...stylex.props(text.caption, styles.footer)}>
              <span {...stylex.props(styles.footerItem)}>
                <Icon name="laptop" size={12} />
                {device?.name ?? '设备已移除'}
              </span>
              <span {...stylex.props(styles.footerItem)}>
                <Icon name="folder" size={12} />
                <span title={thread.folder} {...stylex.props(text.mono, text.truncate)}>
                  {thread.folder}
                </span>
              </span>
              <LocalThreadActions key={thread.id} thread={thread} />
            </div>
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
        canStop={!!agent?.abilities.stop}
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
        deviceName={name}
        waiting={waiting}
        finalFocus={timelineRef}
      />
    </>
  )

  if (layout === 'page') {
    return (
      <Page title={thread.title} status={statusLabel} actions={more}>
        {body}
        {dialogs}
      </Page>
    )
  }

  return (
    <aside aria-label={thread.title} {...stylex.props(styles.panel, pane.card)}>
      <div {...stylex.props(styles.header)}>
        {onBack && <IconButton icon="chevron-left" label="返回概览" onClick={onBack} />}
        <h2 {...stylex.props(text.bodyMedium, styles.headerTitle, text.truncate)}>{thread.title}</h2>
        {statusLabel}
        <IconButton
          icon="external"
          label="在完整页面打开"
          onClick={() => void navigate({ to: '/threads/$threadId', params: { threadId } })}
        />
        {more}
        {onClose && <IconButton icon="close" label="关闭对话" onClick={onClose} />}
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
    <aside aria-label={title} {...stylex.props(styles.panel, pane.card)}>
      <div {...stylex.props(styles.header)}>
        <h2 {...stylex.props(text.bodyMedium, styles.headerStatus, text.truncate)}>{title}</h2>
        {onClose && <IconButton icon="close" label="关闭对话" onClick={onClose} />}
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
        title={`无法从 Baton 停止 ${agentName}`}
        description={`请在 ${deviceName} 上停止，或等待回复。`}
        finalFocus={finalFocus}
        actions={<DialogClose render={<Button>返回对话</Button>} />}
      />
    )
  }
  const canceled = waiting > 0 ? `将取消 ${waiting} 条待发送消息。` : ''
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title="停止当前回复？"
      description={`${canceled}已完成的更改会保留。`}
      finalFocus={finalFocus}
      actions={
        <>
          <DialogClose render={<Button>继续运行</Button>} />
          <Button variant="dangerSolid" onClick={onConfirm}>
            {submitting ? '正在停止…' : '停止回复'}
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
  deviceName: string
  waiting: number
  finalFocus: FinalFocus
}) {
  const running = thread.status === 'running' || !!thread.starting || !!thread.resumePending
  if (running && !agent?.abilities.stop) {
    return (
      <Dialog
        open={open}
        onOpenChange={(next) => !next && onClose()}
        title="请先停止当前回复"
        description={`请在 ${deviceName} 上停止，或等待回复。`}
        finalFocus={finalFocus}
        actions={<DialogClose render={<Button>返回对话</Button>} />}
      />
    )
  }
  const canceled = waiting > 0 ? `并取消 ${waiting} 条待发送消息` : ''
  const description = running
    ? `停止当前回复${canceled}。回复和文件会保留。`
    : waiting > 0
      ? `将取消 ${waiting} 条待发送消息。回复和文件会保留。`
      : '回复和文件会保留。'
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title="归档此对话？"
      description={description}
      finalFocus={finalFocus}
      actions={
        <>
          <DialogClose render={<Button>保留对话</Button>} />
          <Button variant="dangerSolid" onClick={onConfirm}>
            {submitting ? '正在归档…' : running ? '停止并归档' : '归档对话'}
          </Button>
        </>
      }
    />
  )
}
