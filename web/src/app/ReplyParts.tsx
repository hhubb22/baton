import * as stylex from '@stylexjs/stylex'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { activityLine, baseName, clockTime, fileSize, runTimer, threadStatusTones } from '../data/derive'
import { useClient, useLiveTrace, useTrace } from '../data/queries'
import type { Attachment, Device, LiveOutput as LiveOutputData, Message, Thread } from '../data/types'
import { fonts, fontSize } from '../theme/base.stylex'
import { text } from '../theme/text'
import { semantic } from '../theme/semantic.stylex'
import { radius, space } from '../theme/tokens.stylex'
import { Button, focusRing } from '../ui/Button'
import { Disclosure, DisclosureChevron, DisclosurePanel, DisclosureTrigger } from '../ui/Disclosure'
import { Icon } from '../ui/Icon'
import { StatusDot } from '../ui/Status'
import { copyText } from './SelectionMenu'
import { ActivityStep } from './ActivityStep'
import { MessageBody } from './MessageBody'

const styles = stylex.create({
  trace: {
    minWidth: 0,
  },
  toggle: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space.xs,
    alignSelf: 'flex-start',
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: { default: semantic.mutedForeground, ':hover': semantic.foreground },
  },
  steps: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: space.sm,
    marginTop: '6px',
    marginLeft: '5px',
    paddingLeft: space.md,
    borderLeftWidth: '1px',
    borderLeftStyle: 'solid',
    borderLeftColor: semantic.border,
  },
  muted: { color: semantic.mutedForeground },
  agentText: { color: semantic.agentForeground },
  link: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: semantic.brandForeground,
    textDecoration: { default: 'none', ':hover': 'underline' },
  },
  attachment: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space.md,
    paddingBlock: space.xs,
  },
  attachmentList: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.xs,
    minWidth: 0,
    padding: 0,
    margin: 0,
    listStyle: 'none',
  },
  attachmentIcon: { flexShrink: 0, marginTop: '3px', color: semantic.mutedForeground },
  attachmentBody: { display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 },
  attachmentAction: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '28px',
    height: '28px',
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: 'transparent', ':hover': semantic.muted },
    color: { default: semantic.mutedForeground, ':hover': semantic.foreground },
  },
  live: { display: 'flex', flexDirection: 'column', gap: space.sm },
  liveHead: { display: 'inline-flex', alignItems: 'center', gap: '6px' },
  liveBox: {
    margin: 0,
    maxHeight: '240px',
    overflow: 'auto',
    paddingBlock: space.sm,
    paddingInline: space.md,
    borderLeftWidth: '2px',
    borderLeftStyle: 'solid',
    borderLeftColor: semantic.input,
    borderRadius: radius.sm,
    backgroundColor: semantic.secondary,
    fontFamily: fonts.mono,
    fontSize: fontSize.caption,
    lineHeight: 1.55,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  gap: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    paddingBlock: space.xxs,
    color: semantic.faintForeground,
    fontFamily: fonts.ui,
  },
  liveFoot: { display: 'inline-flex', alignItems: 'center', gap: '6px', color: semantic.faintForeground },
})

// 回复上方的一行过程摘要，展开后分页读取中心保存的步骤。
export function ActivityTrace({
  message,
  device,
  command = false,
}: {
  message: Message
  device: Device | undefined
  command?: boolean
}) {
  const [open, setOpen] = useState(false)
  const trace = useTrace(message.id, open)
  if (message.traceItemCount === 0 || (!message.traceItemCount && !message.activity && !command)) return null

  let content: ReactNode
  if (trace.isPending) {
    content = <p {...stylex.props(text.small, styles.muted)}>正在加载执行过程…</p>
  } else if (trace.isError && !trace.data) {
    content = (
      <>
        <p role="status" {...stylex.props(text.small, styles.muted)}>
          无法加载执行过程
        </p>
        <Button small onClick={() => void trace.refetch()}>
          重试
        </Button>
      </>
    )
  } else {
    const pages = trace.data?.pages ?? []
    const steps = pages.flatMap((page) => (page.state === 'ready' ? page.steps : []))
    content = (
      <>
        {steps.map((step) => (
          <ActivityStep key={step.item_id} step={step} threadId={message.threadId} device={device} />
        ))}
        {steps.length === 0 && <p {...stylex.props(text.small, styles.muted)}>这条回复没有保存执行过程。</p>}
        {trace.isError && (
          <p role="status" {...stylex.props(text.small, styles.muted)}>
            无法加载{trace.isFetchNextPageError ? '更多执行记录' : '此执行记录'}。
          </p>
        )}
        {trace.hasNextPage && (
          <Button
            small
            onClick={() => {
              if (!trace.isFetching) void trace.fetchNextPage()
            }}
          >
            {trace.isFetchingNextPage ? '正在加载…' : trace.isFetchNextPageError ? '重试加载' : '加载更多执行记录'}
          </Button>
        )}
        {trace.isError && !trace.isFetchNextPageError && (
          <Button small onClick={() => void trace.refetch()}>
            重试
          </Button>
        )}
      </>
    )
  }

  return (
    <Disclosure open={open} onOpenChange={setOpen} {...stylex.props(styles.trace)}>
      <DisclosureTrigger {...stylex.props(text.caption, styles.toggle, focusRing.ring)}>
        <DisclosureChevron open={open} />
        {message.activity
          ? activityLine(message.activity)
          : command
            ? '命令输出'
            : `执行过程 · ${message.traceItemCount} 个步骤`}
      </DisclosureTrigger>
      <DisclosurePanel>
        <div {...stylex.props(styles.steps)}>{content}</div>
      </DisclosurePanel>
    </Disclosure>
  )
}

export function TurnActivityTrace({
  threadId,
  turnSeq,
  device,
  live = true,
  count,
  messageId,
  runningSteps = [],
  runningStepsTruncated = false,
}: {
  threadId: string
  turnSeq: number
  device: Device | undefined
  live?: boolean
  count?: number
  messageId?: string
  runningSteps?: import('../data/types').TraceStep[]
  runningStepsTruncated?: boolean
}) {
  const [open, setOpen] = useState(live)
  // 运行中默认展开，这一轮结束后自动收起；用户动过开关后以用户的选择为准。
  const [touched, setTouched] = useState(false)
  const [settling, setSettling] = useState(false)
  const [previousLive, setPreviousLive] = useState(live)
  if (previousLive !== live) {
    setPreviousLive(live)
    if (!touched) {
      setOpen(live)
      setSettling(!live)
    }
  }
  const client = useClient()
  const turnTrace = useLiveTrace(threadId, turnSeq, (live || open) && !!client.readTurnTrace, live)
  const savedTrace = useTrace(messageId ?? '', !client.readTurnTrace && open && !!messageId)
  const trace = client.readTurnTrace ? turnTrace : savedTrace
  const refetch = trace.refetch
  const wasLive = useRef(live)
  useEffect(() => {
    if (wasLive.current && !live) void refetch()
    wasLive.current = live
  }, [live, refetch])
  const steps = trace.data?.pages.flatMap((page) => (page.state === 'ready' ? page.steps : [])) ?? []
  const completedIds = new Set(steps.map((step) => step.item_id))
  const activeSteps = runningSteps
    .filter((step) => !completedIds.has(step.item_id))
    .sort((a, b) => a.ordinal - b.ordinal)
  if (steps.length === 0 && activeSteps.length === 0 && !(count && count > 0)) return null
  return (
    <Disclosure
      open={open}
      onOpenChange={(next) => {
        setTouched(true)
        setSettling(false)
        setOpen(next)
      }}
      {...stylex.props(styles.trace)}
    >
      <DisclosureTrigger {...stylex.props(text.caption, styles.toggle, focusRing.ring)}>
        <DisclosureChevron open={open} />
        执行过程 · {count ?? steps.length + activeSteps.length} 个步骤
      </DisclosureTrigger>
      <DisclosurePanel settling={settling}>
        <div {...stylex.props(styles.steps)}>
          {/* 同一个列表：步骤从进行中变为已保存时不重新挂载，保留展开状态。 */}
          {[...steps, ...activeSteps].map((step) => (
            <ActivityStep key={step.item_id} step={step} threadId={threadId} device={device} />
          ))}
          {runningStepsTruncated && <p {...stylex.props(text.caption, styles.muted)}>部分进行中的步骤未完整显示。</p>}
          {trace.isPending && <p {...stylex.props(text.small, styles.muted)}>正在加载执行过程…</p>}
          {trace.hasNextPage && (
            <Button
              small
              onClick={() => {
                if (!trace.isFetching) void trace.fetchNextPage()
              }}
            >
              加载更多活动
            </Button>
          )}
          {trace.isError && (
            <>
              <p role="status" {...stylex.props(text.small, styles.muted)}>
                无法加载执行过程。
              </p>
              <Button small onClick={() => void trace.refetch()}>
                重试
              </Button>
            </>
          )}
        </div>
      </DisclosurePanel>
    </Disclosure>
  )
}

// 回复附带的文件和提交。文件能否打开看它所在设备的状态；提交的完整 SHA 可以复制。
export function Attachments({
  attachments,
  devices,
  onOpen,
}: {
  attachments: Attachment[]
  devices: Device[]
  onOpen: (deviceId: string, path: string) => void
}) {
  if (attachments.length === 0) return null
  return (
    <ul aria-label="附件" {...stylex.props(styles.attachmentList)}>
      {attachments.map((item) =>
        item.kind === 'file' ? (
          <FileRow
            key={`${item.deviceId}:${item.path}`}
            item={item}
            device={devices.find((device) => device.id === item.deviceId)}
            onOpen={onOpen}
          />
        ) : (
          <CommitRow key={item.sha} item={item} />
        ),
      )}
    </ul>
  )
}

function FileRow({
  item,
  device,
  onOpen,
}: {
  item: Extract<Attachment, { kind: 'file' }>
  device: Device | undefined
  onOpen: (deviceId: string, path: string) => void
}) {
  let detail = `${device?.name ?? '设备已移除'} · `
  if (!device) detail += 'unavailable'
  else if (device.connection === 'online') detail += fileSize(item.size)
  else if (device.connection === 'syncing') detail += '正在重连，暂不可用'
  else detail += '离线，不可用'
  const name = baseName(item.path)
  return (
    <li {...stylex.props(styles.attachment)}>
      <span {...stylex.props(styles.attachmentIcon)}>
        <Icon name="file" size={14} />
      </span>
      <div {...stylex.props(styles.attachmentBody)}>
        <span title={item.path} {...stylex.props(text.small, text.truncate)}>
          {name}
        </span>
        <span {...stylex.props(text.caption, styles.muted)}>{detail}</span>
      </div>
      {device?.connection === 'online' && (
        <button
          type="button"
          aria-label={`查看 ${name}`}
          onClick={() => onOpen(item.deviceId, item.path)}
          {...stylex.props(text.small, styles.link, focusRing.ring)}
        >
          查看
        </button>
      )}
    </li>
  )
}

function CommitRow({ item }: { item: Extract<Attachment, { kind: 'commit' }> }) {
  const [copied, setCopied] = useState<boolean | null>(null)
  const copy = () =>
    copyText(item.sha).then(
      () => setCopied(true),
      () => setCopied(false),
    )
  return (
    <li {...stylex.props(styles.attachment)}>
      <span {...stylex.props(styles.attachmentIcon)}>
        <Icon name="commit" size={14} />
      </span>
      <div {...stylex.props(styles.attachmentBody)}>
        <code title={item.sha} aria-label={item.sha} {...stylex.props(text.mono, text.truncate)}>
          {item.sha.length > 12 ? `${item.sha.slice(0, 12)}…` : item.sha}
        </code>
        <span title={item.subject} {...stylex.props(text.caption, styles.muted, text.truncate)}>
          {item.repo} · {item.subject}
        </span>
        {copied === false && (
          <span role="status" {...stylex.props(text.caption, text.danger)}>
            无法访问剪贴板，请手动复制。
          </span>
        )}
      </div>
      <button
        type="button"
        aria-label={copied ? '已复制提交 SHA' : '复制提交 SHA'}
        title={copied ? '已复制提交 SHA' : '复制提交 SHA'}
        onClick={() => void copy()}
        {...stylex.props(styles.attachmentAction, focusRing.ring)}
      >
        <Icon name={copied ? 'check' : 'copy'} size={14} />
      </button>
    </li>
  )
}

// 执行中的一轮的实时输出。设备离线时停在最后收到的内容，重连后继续；设备丢掉的一段标出缺口。
export function LiveOutput({
  thread,
  device,
  live,
  now,
  messages,
  onOpenPath,
  output,
  outputError = false,
  onRetryOutput,
  showReply = true,
}: {
  thread: Thread
  device: Device | undefined
  live: boolean
  now: number
  messages: Message[]
  onOpenPath: (path: string) => void
  output?: LiveOutputData
  outputError?: boolean
  onRetryOutput?: () => void
  showReply?: boolean
}) {
  const running = thread.status === 'running' && thread.runStartedAt !== null
  const boxRef = useRef<HTMLPreElement | null>(null)
  const chunks = output?.chunks ?? []
  const replyId = output?.replyId
  const isReply = thread.agent !== null && replyId !== undefined
  const saved =
    isReply &&
    output?.workerTurnSeq !== undefined &&
    messages.some(
      (message) =>
        message.role === 'agent' && message.replyId === replyId && message.workerTurnSeq === output?.workerTurnSeq,
    )

  // 新输出到达时滚到最后。
  useEffect(() => {
    const node = boxRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [chunks.length])

  if (!running) return null
  return (
    <div {...stylex.props(styles.live)}>
      {live ? (
        <span {...stylex.props(text.small, styles.liveHead, thread.pending ? styles.muted : styles.agentText)}>
          <StatusDot tone={thread.pending ? threadStatusTones.waiting : threadStatusTones.running} />
          {thread.pending ? '正在停止' : '运行中'} ·{' '}
          <span {...stylex.props(text.mono)}>{runTimer(thread.runStartedAt!, now)}</span>
        </span>
      ) : (
        <span {...stylex.props(text.small, styles.liveHead, styles.muted)}>
          <StatusDot tone="hollow" />
          {device ? `${clockTime(device.lastSeenAt)} 后没有新报告` : '设备已移除'}
        </span>
      )}
      {showReply && isReply && !saved && chunks.length > 0 && (
        <div>
          {chunks.some((chunk) => chunk.kind === 'gap') && (
            <span {...stylex.props(text.caption, styles.gap)}>较早的输出未保留</span>
          )}
          <MessageBody
            body={chunks
              .filter((chunk) => chunk.kind === 'text')
              .map((chunk) => chunk.text)
              .join('')}
            onOpenPath={onOpenPath}
            streaming
          />
        </div>
      )}
      {!isReply && chunks.length > 0 && (
        <pre ref={boxRef} aria-label="实时输出" tabIndex={0} {...stylex.props(styles.liveBox, focusRing.ring)}>
          {chunks.map((chunk, index) =>
            chunk.kind === 'text' ? (
              <span key={index}>{chunk.text}</span>
            ) : (
              <span key={index} {...stylex.props(text.caption, styles.gap)}>
                <Icon name="dots" size={12} />
                较早的输出未保留
              </span>
            ),
          )}
        </pre>
      )}
      {!live && (
        <span {...stylex.props(text.caption, styles.liveFoot)}>
          <Icon name="offline" size={12} />
          连接已断开
        </span>
      )}
      {outputError && (
        <span role="status" {...stylex.props(text.caption, styles.liveFoot)}>
          无法读取实时输出{' '}
          <button type="button" onClick={onRetryOutput} {...stylex.props(styles.link, focusRing.ring)}>
            重试
          </button>
        </span>
      )}
    </div>
  )
}
