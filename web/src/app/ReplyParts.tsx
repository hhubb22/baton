import * as stylex from '@stylexjs/stylex'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { activityLine, baseName, clockTime, fileSize, runTimer } from '../data/derive'
import { useLiveOutput, useTrace, type EarlierHistory } from '../data/queries'
import type { Attachment, Device, Message, Thread, TraceStep } from '../data/types'
import { fonts } from '../theme/base.stylex'
import { text } from '../theme/text'
import { colors, radius, space } from '../theme/tokens.stylex'
import { Button, focusRing } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { StatusDot } from '../ui/Status'
import { copyText } from './SelectionMenu'

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
  step: { display: 'flex', flexDirection: 'column', gap: space.xs, alignSelf: 'stretch', minWidth: 0 },
  stepHead: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, color: colors.muted },
  output: {
    margin: 0,
    maxHeight: '200px',
    overflow: 'auto',
    padding: space.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.subtle,
    fontFamily: fonts.mono,
    fontSize: '12px',
    lineHeight: 1.55,
    whiteSpace: 'pre-wrap',
  },
  muted: { color: colors.muted },
  info: { color: colors.info },
  link: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: colors.link,
    textDecoration: { default: 'none', ':hover': 'underline' },
  },
  attachments: {
    display: 'flex',
    flexDirection: 'column',

    paddingBlock: space.xs,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSoft,
    borderRadius: radius.lg,
  },
  attachment: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space.md,
    paddingBlock: space.sm,
    paddingInline: space.lg,
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
  history: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', textAlign: 'center' },
})

// 回复上方的一行过程摘要，展开后从设备读取完整过程。
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
  const name = device?.name ?? 'This device'
  if (!message.activity && !command) return null

  let content: ReactNode
  if (trace.isPending) {
    content = <p {...stylex.props(text.small, styles.muted)}>Loading activity from {name}…</p>
  } else if (trace.isError) {
    content = (
      <>
        <p {...stylex.props(text.small, styles.muted)}>{name} did not return this activity. Retry to read it again.</p>
        <Button small onClick={() => void trace.refetch()}>
          Retry
        </Button>
      </>
    )
  } else if (trace.data.state === 'unavailable') {
    content = (
      <p {...stylex.props(text.small, styles.muted)}>
        {trace.data.reason === 'offline'
          ? `${name} is offline · activity unavailable`
          : 'Past chat history was deleted on this computer'}
      </p>
    )
  } else {
    content = trace.data.steps.map((step, index) => <Step key={index} step={step} />)
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
        {message.activity ? activityLine(message.activity) : 'Command output'}
      </button>
      {open && <div {...stylex.props(styles.steps)}>{content}</div>}
    </div>
  )
}

const fileActions = { wrote: 'Wrote', edited: 'Edited', deleted: 'Deleted' }

function Step({ step }: { step: TraceStep }) {
  switch (step.kind) {
    case 'command':
      return (
        <div {...stylex.props(styles.step)}>
          <div {...stylex.props(styles.stepHead)}>
            <Icon name="terminal" size={12} />
            <code {...stylex.props(text.mono, text.truncate)}>{step.command}</code>
          </div>
          {step.output && <pre {...stylex.props(styles.output)}>{step.output}</pre>}
        </div>
      )
    case 'tool':
      return (
        <div {...stylex.props(text.small, styles.stepHead)}>
          <Icon name="settings" size={12} />
          <span>
            {step.name} · {step.detail}
          </span>
        </div>
      )
    case 'file':
      return (
        <div {...stylex.props(text.small, styles.stepHead)}>
          <Icon name="file" size={12} />
          <span title={step.path}>
            {fileActions[step.action]} {baseName(step.path)}
          </span>
        </div>
      )
  }
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
    <ul aria-label="Attachments" {...stylex.props(styles.attachments)}>
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
            Could not copy. Select the SHA and copy it.
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
}: {
  thread: Thread
  device: Device | undefined
  live: boolean
  now: number
}) {
  const running = thread.status === 'running' && thread.runStartedAt !== null
  const output = useLiveOutput(thread.id, running)
  const boxRef = useRef<HTMLPreElement | null>(null)
  const chunks = output.data?.chunks ?? []

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
      {chunks.length > 0 && (
        <pre ref={boxRef} aria-label="Live output" tabIndex={0} {...stylex.props(styles.liveBox, focusRing.ring)}>
          {chunks.map((chunk, index) =>
            chunk.kind === 'text' ? (
              <span key={index}>{chunk.text}</span>
            ) : (
              <span key={index} {...stylex.props(text.caption, styles.gap)}>
                <Icon name="dots" size={12} />
                Earlier output is no longer available on this computer
              </span>
            ),
          )}
        </pre>
      )}
      {!live && (
        <span {...stylex.props(text.caption, styles.liveFoot)}>
          <Icon name="offline" size={12} />
          Connection lost · output resumes when reconnected
        </span>
      )}
    </div>
  )
}

// 时间线顶部读取更早的对话。某页读不到时已显示的消息保留。
export function HistoryPager({ history, device }: { history: EarlierHistory; device: Device | undefined }) {
  const name = device?.name ?? 'This device'
  let action = null
  let detail: string | null = null
  switch (history.status) {
    case 'idle':
      action = (
        <Button small onClick={history.load}>
          Load earlier history
        </Button>
      )
      detail = history.messages.length > 0 ? null : 'Showing recent activity'
      break
    case 'loading':
      action = (
        <Button small disabled>
          Loading earlier history…
        </Button>
      )
      break
    case 'failed':
      action = (
        <Button small onClick={history.load}>
          Retry earlier history
        </Button>
      )
      detail = `${name} did not return the earlier history. Loaded replies are still available.`
      break
    case 'unavailable':
      if (history.reason === 'offline') {
        action = (
          <Button small onClick={history.load}>
            Retry earlier history
          </Button>
        )
        detail = `${name} is offline · earlier history unavailable`
      } else {
        detail = 'Past chat history was deleted on this computer'
      }
      break
    case 'done':
      detail = 'Start of chat history'
      break
  }
  return (
    <div {...stylex.props(styles.history)}>
      {action}
      {history.gap && (
        <span role="status" {...stylex.props(text.caption, styles.muted)}>
          Some history entries are truncated or missing.
        </span>
      )}
      {detail && (
        <span role="status" {...stylex.props(text.caption, styles.muted)}>
          {detail}
        </span>
      )}
    </div>
  )
}
