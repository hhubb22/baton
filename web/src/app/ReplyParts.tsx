import * as stylex from '@stylexjs/stylex'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { activityLine, baseName, clockTime, fileSize, runTimer } from '../data/derive'
import { useLiveOutput, useTrace } from '../data/queries'
import type { Attachment, Device, Message, Thread } from '../data/types'
import { fonts } from '../theme/base.stylex'
import { text } from '../theme/text'
import { colors, radius, space } from '../theme/tokens.stylex'
import { branch } from '../ui/Branch'
import { Button, focusRing } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { StatusDot } from '../ui/Status'
import { copyText } from './SelectionMenu'
import { ActivityStep } from './ActivityStep'
import { MessageBody } from './MessageBody'

const styles = stylex.create({
  toggle: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space.xs,
    alignSelf: 'flex-start',
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: { default: colors.muted, ':hover': colors.text },
  },
  steps: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: space.sm,
    marginTop: '6px',
    marginLeft: '5px',
    paddingLeft: space.md,
    borderLeftWidth: '2px',
    borderLeftStyle: 'solid',
    borderLeftColor: colors.borderSoft,
  },
  muted: { color: colors.muted },
  info: { color: colors.accentText },
  link: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: colors.accentText,
    textDecoration: { default: 'none', ':hover': 'underline' },
  },
  attachment: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space.md,
    paddingBlock: space.xs,
    paddingInline: space.sm,
  },
  attachmentIcon: { flexShrink: 0, marginTop: '3px', color: colors.muted },
  attachmentBody: { display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 },
  sha: { overflowWrap: 'anywhere' },
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
    borderLeftColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.subtle,
    fontFamily: fonts.mono,
    fontSize: '12px',
    lineHeight: 1.55,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  gap: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    paddingBlock: space.xxs,
    color: colors.faint,
    fontFamily: fonts.ui,
  },
  liveFoot: { display: 'inline-flex', alignItems: 'center', gap: '6px', color: colors.faint },
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
    content = <p {...stylex.props(text.small, styles.muted)}>Loading activity…</p>
  } else if (trace.isError && !trace.data) {
    content = (
      <>
        <p role="status" {...stylex.props(text.small, styles.muted)}>
          Couldn't load activity
        </p>
        <Button small onClick={() => void trace.refetch()}>
          Retry
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
        {steps.length === 0 && <p {...stylex.props(text.small, styles.muted)}>No saved activity for this reply.</p>}
        {trace.isError && (
          <p role="status" {...stylex.props(text.small, styles.muted)}>
            Couldn't load {trace.isFetchNextPageError ? 'more activity' : 'this activity'}.
          </p>
        )}
        {trace.hasNextPage && (
          <Button
            small
            onClick={() => {
              if (!trace.isFetching) void trace.fetchNextPage()
            }}
          >
            {trace.isFetchingNextPage
              ? 'Loading more…'
              : trace.isFetchNextPageError
                ? 'Retry loading more'
                : 'Load more activity'}
          </Button>
        )}
        {trace.isError && !trace.isFetchNextPageError && (
          <Button small onClick={() => void trace.refetch()}>
            Retry
          </Button>
        )}
      </>
    )
  }

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        {...stylex.props(text.small, styles.toggle, focusRing.ring)}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
        {message.activity
          ? activityLine(message.activity)
          : command
            ? 'Command output'
            : `Activity · ${message.traceItemCount} ${message.traceItemCount === 1 ? 'step' : 'steps'}`}
      </button>
      {open && <div {...stylex.props(styles.steps)}>{content}</div>}
    </div>
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
    <ul aria-label="Attachments" {...stylex.props(branch.line)}>
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
  let detail = `${device?.name ?? 'Removed device'} · `
  if (!device) detail += 'unavailable'
  else if (device.connection === 'online') detail += fileSize(item.size)
  else if (device.connection === 'syncing') detail += 'reconnecting, unavailable'
  else detail += 'offline, unavailable'
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
          aria-label={`View ${name}`}
          onClick={() => onOpen(item.deviceId, item.path)}
          {...stylex.props(text.small, styles.link, focusRing.ring)}
        >
          View
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
        <code {...stylex.props(text.mono, styles.sha)}>{item.sha}</code>
        <span title={item.subject} {...stylex.props(text.caption, styles.muted, text.truncate)}>
          {item.repo} · {item.subject}
        </span>
        {copied === false && (
          <span role="status" {...stylex.props(text.caption, text.danger)}>
            Clipboard blocked. Copy it manually.
          </span>
        )}
      </div>
      <button
        type="button"
        aria-label={copied ? 'Copied commit SHA' : 'Copy commit SHA'}
        onClick={() => void copy()}
        {...stylex.props(text.small, styles.link, focusRing.ring)}
      >
        {copied ? 'Copied' : 'Copy'}
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
}: {
  thread: Thread
  device: Device | undefined
  live: boolean
  now: number
  messages: Message[]
  onOpenPath: (path: string) => void
}) {
  const running = thread.status === 'running' && thread.runStartedAt !== null
  const output = useLiveOutput(thread.id, running)
  const boxRef = useRef<HTMLPreElement | null>(null)
  const chunks = output.data?.chunks ?? []
  const replyId = output.data?.replyId
  const isReply = thread.agent !== null && replyId !== undefined
  const saved =
    isReply &&
    output.data?.workerTurnSeq !== undefined &&
    messages.some(
      (message) =>
        message.role === 'agent' && message.replyId === replyId && message.workerTurnSeq === output.data?.workerTurnSeq,
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
        <span {...stylex.props(text.small, styles.liveHead, styles.info)}>
          <StatusDot tone="info" />
          {thread.pending ? 'Stopping' : 'Running'} ·{' '}
          <span {...stylex.props(text.mono)}>{runTimer(thread.runStartedAt!, now)}</span>
        </span>
      ) : (
        <span {...stylex.props(text.small, styles.liveHead, styles.muted)}>
          <StatusDot tone="hollow" />
          No report since {device ? clockTime(device.lastSeenAt) : 'the device was removed'}
        </span>
      )}
      {isReply && !saved && chunks.length > 0 && (
        <div>
          {chunks.some((chunk) => chunk.kind === 'gap') && (
            <span {...stylex.props(text.caption, styles.gap)}>Earlier output not kept</span>
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
        <pre ref={boxRef} aria-label="Live output" tabIndex={0} {...stylex.props(styles.liveBox, focusRing.ring)}>
          {chunks.map((chunk, index) =>
            chunk.kind === 'text' ? (
              <span key={index}>{chunk.text}</span>
            ) : (
              <span key={index} {...stylex.props(text.caption, styles.gap)}>
                <Icon name="dots" size={12} />
                Earlier output not kept
              </span>
            ),
          )}
        </pre>
      )}
      {!live && (
        <span {...stylex.props(text.caption, styles.liveFoot)}>
          <Icon name="offline" size={12} />
          Connection lost
        </span>
      )}
    </div>
  )
}
