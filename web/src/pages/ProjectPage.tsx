import * as stylex from '@stylexjs/stylex'
import { SyncStatus } from '../app/SyncStatus'
import { AttentionCard } from '../app/AttentionCard'
import { InboxFeedback } from '../app/InboxFeedback'
import { ProjectRecovery } from '../app/ProjectRecovery'
import { ProjectMemory } from '../app/ProjectMemory'
import { ArchivedNotice, ProjectSettings } from '../app/ProjectSettings'
import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type UIEvent,
} from 'react'
import { FilePreview } from '../app/FilePreview'
import { MessageBody } from '../app/MessageBody'
import { MessageActions } from '../app/MessageActions'
import { RestrictedMarkdown } from '../app/RestrictedMarkdown'
import { Page } from '../app/Page'
import { ReferenceBlock } from '../app/ReferenceBlock'
import type { ProjectSearch } from '../app/router'
import { statusTextStyle, ThreadDetail, type RecoverAction } from '../app/ThreadDetail'
import { useNow } from '../app/useNow'
import { LocalThreadActions } from '../app/LocalThreadActions'
import { useWorkspace } from '../app/workspace'
import { ClientError, isAccessError } from '../data/client'
import { desktopCapability, useDesktopStatus, useLocalDesktop } from '../data/desktop'
import {
  assistantWait,
  deviceConnectionView,
  pendingInbox,
  projectAgentStatus,
  relativeTime,
  runTimer,
  threadView,
} from '../data/derive'
import {
  newClientId,
  keys,
  useClient,
  useDevices,
  useInbox,
  useProjectEntries,
  useProjectHistory,
  useProjectMemory,
  useProjects,
  useSendProjectMessage,
  useSetProjectStatus,
  useStopProjectRun,
  useThreads,
  useStableThreadOrder,
} from '../data/queries'
import type {
  Delivery,
  Device,
  EntryThreads,
  InboxItem,
  MemoryNote,
  ProcessStep,
  Project,
  ProjectEntry,
  Thread,
} from '../data/types'
import { fonts } from '../theme/base.stylex'
import { text } from '../theme/text'
import { colors, radius, size, space } from '../theme/tokens.stylex'
import { Avatar } from '../ui/Avatar'
import { Banner } from '../ui/Banner'
import { Button, focusRing, IconButton } from '../ui/Button'
import { Composer } from '../ui/Composer'
import { Icon } from '../ui/Icon'
import { Menu, MenuOption, MenuRule } from '../ui/Menu'
import { ResizablePane } from '../ui/ResizablePane'
import { StatusChip, type Tone } from '../ui/Status'
import { Tabs } from '../ui/Tabs'

const styles = stylex.create({
  layout: {
    position: 'relative',
    display: 'flex',
    gap: size.gutter,
    flexGrow: 1,
    minWidth: 0,
    height: '100%',
    backgroundColor: colors.canvas,
  },
  title: { display: 'flex', alignItems: 'center', gap: space.sm },
  headerStatus: { display: 'inline-flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' },
  agentText: { color: colors.agentText },
  muted: { color: colors.muted },
  faint: { color: colors.faint },
  danger: { color: colors.danger },
  main: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    overflow: 'clip',
  },
  timeline: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: 'auto',
    scrollbarWidth: 'none',
    outline: 'none',
  },
  entries: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.xl,
    width: '100%',
    maxWidth: '688px',
    marginInline: 'auto',
    padding: space.xl,
    paddingBottom: 'calc(var(--project-dock-height, 160px) + 16px)',
  },
  day: { alignSelf: 'center', color: colors.faint },
  userItem: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px' },
  user: {
    maxWidth: '85%',
    paddingBlock: space.sm,
    paddingInline: space.md,
    borderRadius: '24px',
    backgroundColor: colors.subtle,
    fontSize: '16px',
  },
  withdrawn: { color: colors.muted },
  assistant: { display: 'flex', flexDirection: 'column', gap: space.lg, minWidth: 0 },
  assistantBody: { fontSize: '16px', lineHeight: 1.65 },
  process: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.sm,
    minWidth: 0,
    paddingBottom: space.sm,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSoft,
  },
  processToggle: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space.sm,
    alignSelf: 'flex-start',
    paddingBlock: space.xs,
    paddingInline: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: { default: colors.muted, ':hover': colors.text },
  },
  steps: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.xs,
  },
  step: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  stepToggle: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space.sm,
    width: '100%',
    minWidth: 0,
    paddingBlock: space.xs,
    paddingInline: 0,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: 'transparent', ':hover': colors.hover },
    color: colors.muted,
    textAlign: 'left',
  },
  stepIcon: { marginTop: '2px', color: colors.faint },
  stepName: { flexGrow: 1, minWidth: 0, overflowWrap: 'anywhere' },
  stepStatus: { flexShrink: 1, maxWidth: '45%', overflowWrap: 'anywhere', color: colors.faint, textAlign: 'right' },
  stepDetail: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.xs,
    marginLeft: '24px',
    paddingBlock: space.sm,
    paddingInline: 0,
  },
  detailLabel: { color: colors.faint },
  detailText: { margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  noteRow: { display: 'flex', alignItems: 'flex-start', gap: space.sm, paddingBlock: space.xs, color: colors.muted },
  noteBody: { minWidth: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  output: {
    margin: 0,
    maxHeight: '200px',
    overflow: 'auto',
    fontFamily: fonts.mono,
    fontSize: '12px',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  threadGroup: { display: 'flex', flexDirection: 'column', gap: space.sm, minWidth: 0 },
  threadRow: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    width: '100%',
    minHeight: size.comfortable,
    paddingInline: 0,
    borderRadius: radius.md,
    backgroundColor: { default: 'transparent', ':hover': colors.hover },
    borderWidth: 0,
    color: colors.text,
    textAlign: 'left',
  },
  threadSelected: { backgroundColor: { default: colors.selected, ':hover': colors.selected } },
  threadOpen: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    flexGrow: 1,
    minWidth: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: 'inherit',
    textAlign: 'left',
  },
  threadTitle: { flexGrow: 1, flexBasis: 0, minWidth: 0 },
  threadIcon: { flexShrink: 0, color: colors.muted },
  threadMeta: { flexShrink: 0, color: colors.muted, whiteSpace: 'nowrap' },
  note: { alignSelf: 'center', color: colors.faint, textAlign: 'center' },
  activity: { display: 'inline-flex', alignItems: 'center', gap: space.sm, color: colors.agentText },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: space.sm,
    paddingBlock: space.section,
    textAlign: 'center',
  },
  emptyHint: { maxWidth: '420px', color: colors.muted },
  dock: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 1,
    pointerEvents: 'none',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: space.sm,
    paddingTop: '24px',
    backgroundImage: `linear-gradient(to bottom, transparent, color-mix(in srgb, ${colors.canvas} 70%, transparent))`,
    paddingInline: space.xl,
    paddingBottom: space.md,
    opacity: 1,
    transform: 'translateY(0)',
    transition: 'opacity 180ms cubic-bezier(0.23, 1, 0.32, 1), transform 180ms cubic-bezier(0.23, 1, 0.32, 1)',
    '@media (prefers-reduced-motion: reduce)': { transition: 'opacity 120ms ease', transform: 'none' },
  },
  dockHidden: {
    opacity: 0,
    transform: 'translateY(12px)',
    transition: 'opacity 280ms ease, transform 280ms cubic-bezier(0.23, 1, 0.32, 1)',
    '@media (prefers-reduced-motion: reduce)': { transition: 'opacity 120ms ease', transform: 'none' },
  },
  dockInteractive: { pointerEvents: 'auto' },
  dockBanner: { width: '100%', maxWidth: '640px', pointerEvents: 'auto', ':empty': { display: 'none' } },
  chips: { display: 'flex', flexWrap: 'wrap', gap: space.xs, width: '100%', maxWidth: '640px' },
  status: { width: '100%', maxWidth: '640px', minHeight: '18px', color: colors.muted },
  overview: {
    display: 'flex',
    pointerEvents: 'auto',
    flexDirection: 'column',
    gap: space.lg,
    flexShrink: 0,
    width: 'calc(100% - 8px)',
    maxHeight: 'calc(100% - 56px)',
    marginTop: '56px',
    overflowY: 'auto',
    padding: space.lg,
    backgroundColor: colors.surface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.glassEdge,
    borderRadius: radius.lg,
    boxShadow: `0 8px 24px ${colors.shadowSoft}, 0 2px 6px ${colors.shadowNear}`,
  },
  section: { display: 'flex', flexDirection: 'column', gap: space.xs },
  sectionLabel: { color: colors.faint },
  assistantDevice: {
    display: 'flex',
    alignItems: 'center',
    gap: space.md,
    minWidth: 0,
  },
  assistantDeviceText: { display: 'flex', flexDirection: 'column', gap: space.xxs, minWidth: 0 },
  group: { display: 'flex', flexDirection: 'column' },
  groupLabel: { paddingBlock: space.xs, paddingInline: space.sm, color: colors.faint },
  groupHead: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    width: '100%',
    paddingBlock: space.xs,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: 'transparent',
    color: { default: colors.muted, ':hover': colors.text },
    textAlign: 'left',
  },
  groupCount: { color: colors.faint },
  groupChevron: { marginLeft: 'auto', color: colors.faint },
  overviewRow: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    width: '100%',
    minHeight: size.control,
    paddingBlock: '6px',
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: 'transparent', ':hover': colors.hover },
    color: colors.text,
    textAlign: 'left',
  },
  rowTime: {
    color: colors.faint,
    display: {
      default: 'none',
      [stylex.when.ancestor(':hover')]: 'inline',
      [stylex.when.ancestor(':focus-visible')]: 'inline',
    },
  },
  more: {
    alignSelf: 'flex-start',
    padding: 0,
    paddingInline: space.sm,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: colors.accentText,
  },
})

const recentLimit = 5

function dayLabel(at: number, now: number) {
  const day = (value: number) => new Date(value).toDateString()
  if (day(at) === day(now)) return '今天'
  if (day(at) === day(now - 86_400_000)) return '昨天'
  return new Date(at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

function deliveryNote(delivery: Delivery) {
  switch (delivery) {
    case 'submitted':
      return '正在发送…'
    case 'saved':
      return '已保存'
    case 'queued':
      return '等待助手'
    case 'waitingDevice':
      return '等待设备'
    case 'withdrawn':
      return '未发送 · 运行已停止'
    case 'unknown':
      return '无法确认助手是否收到'
    case 'delivered':
      return null
  }
}

const cardTitles: Record<EntryThreads['action'], (count: number) => string> = {
  opened: (count) => `已新建 ${count} 个对话`,
  messaged: (count) => `已向 ${count} 个对话发送消息`,
  replies: (count) => `来自 ${count} 个对话的回复`,
}

function ProcessItem({ step, devices }: { step: ProcessStep; devices: Device[] }) {
  const [open, setOpen] = useState(false)
  if (step.kind === 'note') {
    return (
      <div {...stylex.props(text.small, styles.noteRow)}>
        <Icon name="details" size={16} style={styles.stepIcon} />
        <div {...stylex.props(styles.noteBody)}>
          <RestrictedMarkdown body={step.body} muted small />
        </div>
      </div>
    )
  }
  const isCommand = step.kind === 'command'
  const failed = isCommand ? step.exitCode !== 0 : step.status === 'failed'
  const status = isCommand
    ? step.exitCode !== 0
      ? `退出码 ${step.exitCode}`
      : null
    : step.status === 'pending'
      ? '等待结果'
      : step.status === 'failed'
        ? '失败'
        : null
  const isShell = isCommand || step.name === 'nodes.exec'
  const label = isCommand ? step.command : step.name
  return (
    <div {...stylex.props(styles.step)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        {...stylex.props(text.small, styles.stepToggle, focusRing.ring)}
      >
        <Icon name={isShell ? 'terminal' : 'tool'} size={16} style={styles.stepIcon} />
        <span {...stylex.props(styles.stepName, isShell && text.mono)}>{label}</span>
        <span {...stylex.props(text.caption, styles.stepStatus, failed && styles.danger)}>{status}</span>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} style={styles.stepIcon} />
      </button>
      {open && (
        <div {...stylex.props(styles.stepDetail)}>
          {isCommand && (
            <span {...stylex.props(text.caption, styles.detailLabel)}>
              {devices.find((item) => item.id === step.deviceId)?.name ?? '设备已移除'} · 退出码 {step.exitCode} ·{' '}
              {(step.durationMs / 1000).toFixed(1)} 秒
            </span>
          )}
          {!isCommand && (
            <>
              <span {...stylex.props(text.caption, styles.detailLabel)}>输入</span>
              <pre {...stylex.props(text.mono, styles.detailText)}>{step.input}</pre>
            </>
          )}
          {step.output && (
            <>
              <span {...stylex.props(text.caption, styles.detailLabel)}>{isCommand ? '输出' : '结果'}</span>
              <pre {...stylex.props(styles.output)}>{step.output}</pre>
            </>
          )}
          {!step.output && (
            <span {...stylex.props(text.caption, styles.faint)}>
              {!isCommand && step.status === 'pending' ? '等待结果' : '没有输出'}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function ProcessLine({ steps, devices, children }: { steps: ProcessStep[]; devices: Device[]; children?: ReactNode }) {
  const [open, setOpen] = useState(false)
  const awaiting = steps.filter((step) => step.kind === 'tool' && step.status === 'pending').length
  return (
    <div data-live-activity={awaiting > 0 ? '' : undefined} {...stylex.props(styles.process)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        {...stylex.props(text.caption, styles.processToggle, focusRing.ring)}
      >
        {awaiting > 0 ? '正在处理' : '执行过程'}
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
      </button>
      {open && (
        <div {...stylex.props(styles.steps)}>
          {steps.map((step, index) => (
            <ProcessItem key={index} step={step} devices={devices} />
          ))}
          {children}
        </div>
      )}
    </div>
  )
}

function ThreadButton({
  thread,
  device,
  selected,
  onOpen,
}: {
  thread: Thread
  device: Device | undefined
  selected: boolean
  onOpen: () => void
}) {
  const view = threadView(thread, device)
  const now = useNow(view.live ? 1000 : 60_000)
  const timer = view.live && thread.runStartedAt !== null ? runTimer(thread.runStartedAt, now) : null
  const desktop = useLocalDesktop(thread.deviceId, 'open-local')
  const local = !!desktop.bridge?.openLocal
  const status =
    view.group === 'idle' ? null : (
      <span {...stylex.props(text.caption, styles.threadMeta, statusTextStyle(view.status.tone))}>
        {timer ? `${view.status.label} · ${timer}` : view.status.label}
      </span>
    )
  const button = (
    <button
      type="button"
      aria-current={selected || undefined}
      onClick={onOpen}
      {...stylex.props(
        text.small,
        local ? styles.threadOpen : styles.threadRow,
        !local && selected && styles.threadSelected,
        focusRing.ring,
      )}
    >
      <Icon name="threads" size={16} style={styles.threadIcon} />
      <span {...stylex.props(styles.threadTitle, text.truncate)}>{thread.title}</span>
      {!local && status}
    </button>
  )
  return local ? (
    <div {...stylex.props(text.small, styles.threadRow, selected && styles.threadSelected)}>
      {button}
      <LocalThreadActions thread={thread} />
      {status}
    </div>
  ) : (
    button
  )
}

function ThreadCard({
  threads: info,
  all,
  devices,
  openThread,
  onOpen,
}: {
  threads: EntryThreads
  all: Thread[]
  devices: Device[]
  openThread: string | undefined
  onOpen: (threadId: string) => void
}) {
  const threads = info.threadIds.flatMap((id) => all.filter((item) => item.id === id))
  if (threads.length === 0) return null
  return (
    <section aria-label={cardTitles[info.action](threads.length)} {...stylex.props(styles.threadGroup)}>
      <div>
        {threads.map((thread) => (
          <ThreadButton
            key={thread.id}
            thread={thread}
            device={devices.find((item) => item.id === thread.deviceId)}
            selected={thread.id === openThread}
            onOpen={() => onOpen(thread.id)}
          />
        ))}
      </div>
    </section>
  )
}

const Entry = memo(function Entry({
  entry,
  threads,
  devices,
  openThread,
  onOpenThread,
  onOpenPath,
  streaming = false,
}: {
  entry: ProjectEntry
  threads: Thread[]
  devices: Device[]
  openThread: string | undefined
  onOpenThread: (threadId: string) => void
  onOpenPath: (path: string) => void
  streaming?: boolean
}) {
  switch (entry.kind) {
    case 'user': {
      const note = deliveryNote(entry.delivery)
      return (
        <div {...stylex.props(styles.userItem)}>
          <div {...stylex.props(text.body, styles.user, entry.delivery === 'withdrawn' && styles.withdrawn)}>
            {entry.reference && <ReferenceBlock reference={entry.reference} />}
            <MessageBody body={entry.body} onOpenPath={onOpenPath} />
          </div>
          {note && <span {...stylex.props(text.caption, styles.faint)}>{note}</span>}
        </div>
      )
    }
    case 'assistant':
      return (
        <article aria-label={streaming ? '项目助手正在回复' : '项目助手'} {...stylex.props(styles.assistant)}>
          {(entry.process.length > 0 || entry.threads) && (
            <ProcessLine steps={entry.process} devices={devices}>
              {entry.threads && (
                <ThreadCard
                  threads={entry.threads}
                  all={threads}
                  devices={devices}
                  openThread={openThread}
                  onOpen={onOpenThread}
                />
              )}
            </ProcessLine>
          )}
          {entry.body && (
            <div {...stylex.props(text.body, styles.assistantBody)}>
              <MessageBody body={entry.body} onOpenPath={onOpenPath} streaming={streaming} />
            </div>
          )}
          {entry.body && <MessageActions body={entry.body} />}
        </article>
      )
    case 'note':
      return <p {...stylex.props(text.caption, styles.note)}>{entry.body}</p>
  }
})

// 主对话没有内容时的引导。
function EmptyConversation({ project }: { project: Project }) {
  return (
    <div {...stylex.props(styles.empty)}>
      <Avatar name={project.name} hue={project.hue} emoji={project.emoji} large />
      <span {...stylex.props(text.title)}>{project.name}</span>
      {project.goal && <span {...stylex.props(text.small, styles.emptyHint)}>{project.goal}</span>}
    </div>
  )
}

function assistantLine(project: Project, devices: Device[]) {
  const device = project.sourceNodeId ? devices.find((item) => item.id === project.sourceNodeId) : undefined
  const connection = device?.modelConnections?.find((item) => `api-${item.id}` === project.subscription)
  const source = project.sourceNodeId
    ? connection
      ? `${connection.name} · ${device!.name}`
      : 'API 连接不可用'
    : project.subscription
  switch (project.agent.state) {
    case 'blocked':
      return project.agent.reason ?? '需要处理'
    case 'waitingDevice':
      return assistantWait(project, devices).overview
    case 'stopping':
      return '正在停止…'
    case 'stopped':
      return project.agent.reason ?? `${source} · ${project.model}`
    default:
      return `${source} · ${project.model}`
  }
}

function Overview({
  project,
  devices,
  threads,
  pending,
  memory,
  onOpenThread,
  onOpenInbox,
  tab,
  onTabChange,
}: {
  project: Project
  devices: Device[]
  threads: Thread[]
  pending: InboxItem[]
  memory: MemoryNote[] | undefined
  onOpenThread: (threadId: string) => void
  onOpenInbox: () => void
  tab: 'threads' | 'memory'
  onTabChange: (tab: 'threads' | 'memory') => void
}) {
  const [showAll, setShowAll] = useState(false)
  const [folded, setFolded] = useState<string[]>([])
  const desktop = useDesktopStatus()
  const localNode = desktopCapability('open-local')?.openLocal && desktop.data?.registered ? desktop.data.node_id : null
  const now = useNow(60_000)
  const device = devices.find((item) => item.id === project.agent.deviceId)
  const deviceStatus = device ? deviceConnectionView(device, [], now) : null
  const live = threads.filter((item) => item.status !== 'archived')
  const views = new Map(
    live.map((thread) => [
      thread.id,
      threadView(
        thread,
        devices.find((item) => item.id === thread.deviceId),
      ),
    ]),
  )
  const inGroup = (...groups: string[]) => live.filter((thread) => groups.includes(views.get(thread.id)!.group))
  const recent = inGroup('idle')
  const groups = [
    { label: '需要处理', threads: inGroup('attention') },
    { label: '运行中', threads: inGroup('running', 'stopping') },
    { label: '等待设备', threads: inGroup('waiting', 'stopRequested') },
    { label: '最近', threads: showAll ? recent : recent.slice(0, recentLimit) },
  ].map((group) => ({ ...group, count: group.label === '最近' ? recent.length : group.threads.length }))

  const row = (thread: Thread) => {
    const view = views.get(thread.id)!
    const lead = (
      <>
        <Icon name="message" size={16} style={styles.muted} />
        <span {...stylex.props(styles.threadTitle, text.truncate)}>{thread.title}</span>
        <span {...stylex.props(text.caption, statusTextStyle(view.status.tone))}>{view.status.label}</span>
        <span {...stylex.props(text.caption, styles.rowTime)}>{relativeTime(thread.updatedAt, now)}</span>
      </>
    )
    return localNode === thread.deviceId ? (
      <div key={thread.id} {...stylex.props(stylex.defaultMarker(), text.small, styles.overviewRow)}>
        <button
          type="button"
          title={thread.title}
          onClick={() => onOpenThread(thread.id)}
          {...stylex.props(text.small, styles.threadOpen, focusRing.ring)}
        >
          {lead}
        </button>
        <LocalThreadActions thread={thread} />
      </div>
    ) : (
      <button
        key={thread.id}
        type="button"
        title={thread.title}
        onClick={() => onOpenThread(thread.id)}
        {...stylex.props(stylex.defaultMarker(), text.small, styles.overviewRow, focusRing.ring)}
      >
        {lead}
      </button>
    )
  }

  return (
    <aside aria-label="概览" {...stylex.props(styles.overview)}>
      <section aria-label="项目助手" {...stylex.props(styles.assistantDevice)}>
        <Icon name="laptop" size={24} style={styles.muted} />
        <div {...stylex.props(styles.assistantDeviceText)}>
          <span {...stylex.props(text.small, text.truncate)}>
            {device?.name ?? '暂无设备'}
            {deviceStatus && ` · ${deviceStatus.label}`}
          </span>
          <span {...stylex.props(text.caption, styles.muted)}>{assistantLine(project, devices)}</span>
        </div>
      </section>
      {project.goal && (
        <section {...stylex.props(styles.section)}>
          <h3 {...stylex.props(text.captionMedium, styles.sectionLabel)}>目标</h3>
          <p {...stylex.props(text.small)}>{project.goal}</p>
        </section>
      )}
      <Tabs
        label="概览列表"
        value={tab}
        onChange={onTabChange}
        options={[
          { value: 'threads', label: '对话', count: live.length },
          { value: 'memory', label: '记忆', count: memory?.length ?? 0 },
        ]}
      />
      {tab === 'threads' && (
        <>
          {live.length === 0 && pending.length === 0 && <p {...stylex.props(text.small, styles.faint)}>暂无对话</p>}
          {pending.length > 0 && (
            <section aria-label="待决定" {...stylex.props(styles.group)}>
              <h3 {...stylex.props(text.captionMedium, styles.groupLabel)}>待决定</h3>
              {pending.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={onOpenInbox}
                  {...stylex.props(text.small, styles.overviewRow, focusRing.ring)}
                >
                  <span {...stylex.props(styles.threadTitle, text.truncate)}>{item.title}</span>
                </button>
              ))}
            </section>
          )}
          {groups
            .filter((group) => group.threads.length > 0)
            .map((group) => (
              <section key={group.label} aria-label={group.label} {...stylex.props(styles.group)}>
                <h3>
                  <button
                    type="button"
                    aria-expanded={!folded.includes(group.label)}
                    onClick={() =>
                      setFolded(
                        folded.includes(group.label)
                          ? folded.filter((label) => label !== group.label)
                          : [...folded, group.label],
                      )
                    }
                    {...stylex.props(text.captionMedium, styles.groupHead, focusRing.ring)}
                  >
                    {group.label}
                    <span {...stylex.props(styles.groupCount)}>{group.count}</span>
                    <Icon
                      name={folded.includes(group.label) ? 'chevron-right' : 'chevron-down'}
                      size={12}
                      style={styles.groupChevron}
                    />
                  </button>
                </h3>
                {!folded.includes(group.label) && group.threads.map(row)}
              </section>
            ))}
          {!showAll && recent.length > recentLimit && !folded.includes('最近') && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              {...stylex.props(text.caption, styles.more, focusRing.ring)}
            >
              再显示 {recent.length - recentLimit} 条
            </button>
          )}
        </>
      )}
      {tab === 'memory' && <ProjectMemory key={project.id} project={project} />}
    </aside>
  )
}

function DockBanner({
  project,
  devices,
  threads,
  onViewDevices,
  onResume,
  resuming,
}: {
  project: Project
  devices: Device[]
  threads: Thread[]
  onViewDevices: () => void
  onResume: () => void
  resuming: boolean
}) {
  if (project.status === 'archived') return <ArchivedNotice project={project} threads={threads} devices={devices} />
  if (project.status === 'paused') {
    return (
      <Banner
        icon="pause"
        title="项目已暂停"
        detail="新消息将在恢复后处理。"
        action={
          <Button small onClick={onResume}>
            {resuming ? '正在恢复…' : '恢复项目'}
          </Button>
        }
      />
    )
  }
  switch (project.agent.state) {
    case 'blocked':
      return <ProjectRecovery project={project} />
    case 'waitingDevice': {
      const wait = assistantWait(project, devices)
      return (
        <Banner
          icon="offline"
          title={wait.title}
          detail={wait.detail}
          action={
            <Button small onClick={onViewDevices}>
              查看设备
            </Button>
          }
        />
      )
    }
    case 'stopping':
      return (
        <Banner
          icon="stop"
          title={`等待 ${devices.find((item) => item.id === project.agent.deviceId)?.name ?? '设备'} 停止助手`}
          detail="对话会继续运行。"
        />
      )
    case 'stopped':
      if (!project.agent.reason) return null
      return <Banner icon="alert" title="项目助手已停止" detail={`${project.agent.reason}。发送消息可重新启动。`} />
    default:
      return null
  }
}

function threadCounts(threads: Thread[], devices: Device[]) {
  const groups = threads
    .filter((item) => item.status !== 'archived')
    .map(
      (thread) =>
        threadView(
          thread,
          devices.find((item) => item.id === thread.deviceId),
        ).group,
    )
  return {
    running: groups.filter((group) => group === 'running' || group === 'stopping').length,
    waiting: groups.filter((group) => group === 'waiting' || group === 'stopRequested').length,
  }
}

function headerTone(tone: Tone) {
  return tone === 'agent' ? styles.agentText : statusTextStyle(tone)
}

export function ProjectPage() {
  const client = useClient()
  const queryClient = useQueryClient()
  const { projectId } = useParams({ from: '/workspace/projects/$projectId' })
  const search: ProjectSearch = useSearch({ from: '/workspace/projects/$projectId' })
  const navigate = useNavigate()
  const projects = useProjects()
  const devices = useDevices()
  const threads = useThreads()
  const inbox = useInbox()
  const entries = useProjectEntries(projectId)
  const history = useProjectHistory(projectId)
  const memory = useProjectMemory(projectId)
  const send = useSendProjectMessage()
  const stop = useStopProjectRun()
  const changeStatus = useSetProjectStatus()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  const scrollAnchor = useRef(0)
  const atLiveEdge = useRef(true)
  const scrollProject = useRef(projectId)
  const [dockState, setDockState] = useState({ projectId, hidden: false })
  if (dockState.projectId !== projectId) setDockState({ projectId, hidden: false })
  const dockHidden = dockState.projectId === projectId && dockState.hidden
  const setDockHidden = (hidden: boolean) =>
    setDockState((current) =>
      current.projectId === projectId && current.hidden === hidden ? current : { projectId, hidden },
    )
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  // 发送失败后正文没改就沿用同一个 clientId，重试不会多出一条消息。
  const [failed, setFailed] = useState<{ body: string; clientId: string } | null>(null)
  const [overviewState, setOverviewState] = useState({ projectId, open: search.view === 'memory' })
  const onOpenThread = useCallback(
    (threadId: string) => {
      setOverviewState({ projectId, open: true })
      void navigate({
        to: '/projects/$projectId',
        params: { projectId },
        search: (prev: ProjectSearch) => ({ ...prev, thread: threadId }),
      })
    },
    [navigate, projectId],
  )
  if (overviewState.projectId !== projectId) setOverviewState({ projectId, open: search.view === 'memory' })
  const overviewOpen = overviewState.projectId === projectId ? overviewState.open : search.view === 'memory'
  const setOverviewOpen = (open: boolean) => setOverviewState({ projectId, open })
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const workspace = useWorkspace()
  const reference = workspace.references[projectId] ?? null

  const allDevices = isAccessError(devices.error) ? [] : (devices.data ?? [])
  const orderedThreads = useStableThreadOrder(isAccessError(threads.error) ? [] : (threads.data ?? []))
  const projectThreads = useMemo(
    () => orderedThreads.filter((item) => item.projectId === projectId),
    [orderedThreads, projectId],
  )
  const now = useNow(60_000)
  const list = entries.data ?? []
  const project = projects.data?.find((item) => item.id === projectId)
  const preview = project?.agent.preview
  const [previousPreview, setPreviousPreview] = useState<{
    projectId: string
    value: NonNullable<Project['agent']['preview']>
    runId?: string
  } | null>(null)
  const [interruptedPreview, setInterruptedPreview] = useState<{
    projectId: string
    afterSeq: number
    pending: boolean
  } | null>(null)
  const [confirmationFailed, setConfirmationFailed] = useState(false)
  const [confirmationAttempt, setConfirmationAttempt] = useState(0)
  if (
    preview &&
    !list.some(
      (entry) =>
        entry.kind === 'assistant' &&
        entry.streamAnchor === preview.afterSeq &&
        (!project?.agent.runId || entry.runId === project.agent.runId),
    ) &&
    (!previousPreview ||
      previousPreview.projectId !== projectId ||
      previousPreview.value.afterSeq !== preview.afterSeq ||
      previousPreview.value.text !== preview.text ||
      previousPreview.value.truncated !== preview.truncated)
  ) {
    if (
      previousPreview &&
      previousPreview.projectId === projectId &&
      previousPreview.runId &&
      project?.agent.runId &&
      previousPreview.runId !== project.agent.runId
    )
      setInterruptedPreview({ projectId, afterSeq: previousPreview.value.afterSeq, pending: true })
    setPreviousPreview({ projectId, value: preview, runId: project?.agent.runId })
    if (confirmationFailed) setConfirmationFailed(false)
  } else if (
    previousPreview &&
    previousPreview.projectId === projectId &&
    previousPreview.runId &&
    project?.agent.runId &&
    previousPreview.runId !== project.agent.runId
  ) {
    setInterruptedPreview({ projectId, afterSeq: previousPreview.value.afterSeq, pending: true })
    setPreviousPreview(null)
    if (confirmationFailed) setConfirmationFailed(false)
  }
  const candidatePreview =
    preview ?? (previousPreview && previousPreview.projectId === projectId ? previousPreview.value : null)
  const previewRunId = preview ? project?.agent.runId : previousPreview?.runId
  const matchedPreview =
    candidatePreview &&
    list.some(
      (entry) =>
        entry.kind === 'assistant' &&
        entry.streamAnchor === candidatePreview.afterSeq &&
        (!previewRunId || entry.runId === previewRunId),
    )
  const livePreview =
    entries.data &&
    candidatePreview &&
    !matchedPreview &&
    (!previewRunId || !project?.agent.runId || previewRunId === project.agent.runId)
      ? candidatePreview
      : null
  if (matchedPreview && previousPreview && previousPreview.projectId === projectId) {
    setPreviousPreview(null)
    if (confirmationFailed) setConfirmationFailed(false)
  }
  const runId = project?.agent.runId
  const runState = project?.agent.runState
  const lastSeq = project?.agent.lastSeq
  useEffect(() => {
    const saved = previousPreview
    if (
      !saved ||
      saved.projectId !== projectId ||
      !saved.runId ||
      runId !== saved.runId ||
      !['finished', 'lost', 'failed'].includes(runState ?? '') ||
      lastSeq === undefined ||
      !client.readProjectTimeline
    )
      return
    let cancelled = false
    void client
      .readProjectTimeline(projectId)
      .then((data) => {
        if (cancelled) return
        if (data.lastSeq < lastSeq) {
          setConfirmationFailed(true)
          return
        }
        queryClient.setQueryData<typeof data>(keys.projectEntries(projectId), (current) =>
          !current || current.lastSeq < data.lastSeq ? data : current,
        )
        const matched = data.entries.some(
          (entry) =>
            entry.kind === 'assistant' && entry.streamAnchor === saved.value.afterSeq && entry.runId === saved.runId,
        )
        if (!matched) setInterruptedPreview({ projectId, afterSeq: saved.value.afterSeq, pending: false })
        setConfirmationFailed(false)
        setPreviousPreview((current) => (current === saved ? null : current))
      })
      .catch(() => {
        if (!cancelled) setConfirmationFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [previousPreview, projectId, runId, runState, lastSeq, client, queryClient, confirmationAttempt])

  // 新内容只在用户停留在底部时跟随；切换项目时回到最新内容。
  useEffect(() => {
    const timeline = timelineRef.current
    if (scrollProject.current !== projectId) {
      scrollProject.current = projectId
      atLiveEdge.current = true
    }
    if (timeline && atLiveEdge.current) {
      timeline.scrollTop = timeline.scrollHeight
      scrollAnchor.current = timeline.scrollTop
    }
  }, [entries.data, livePreview?.text, projectId])

  useLayoutEffect(() => {
    const timeline = timelineRef.current
    const content = timeline?.firstElementChild
    if (!timeline || !content || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (!atLiveEdge.current) return
      timeline.scrollTop = timeline.scrollHeight
      scrollAnchor.current = timeline.scrollTop
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [projectId, projects.isSuccess])

  // 从别处选中内容带过来时，把焦点放到输入区。
  useEffect(() => {
    if (reference) inputRef.current?.focus()
  }, [reference])

  function onTimelineScroll(event: UIEvent<HTMLDivElement>) {
    const timeline = event.currentTarget
    const top = timeline.scrollTop
    atLiveEdge.current = timeline.scrollHeight - timeline.clientHeight - top <= 32
    const delta = top - scrollAnchor.current
    if (timeline.scrollHeight - timeline.clientHeight - top <= 2) {
      scrollAnchor.current = top
      setDockHidden(false)
    } else if (Math.abs(delta) >= 12) {
      scrollAnchor.current = top
      if (delta > 0) setDockHidden(false)
      else if (
        project?.status === 'active' &&
        !['blocked', 'waitingDevice', 'stopping', 'stopped'].includes(project.agent.state) &&
        !error &&
        !dockRef.current?.contains(document.activeElement)
      )
        setDockHidden(true)
    }
  }
  useLayoutEffect(() => {
    const dock = dockRef.current
    const main = dock?.parentElement
    if (!dock || !main) return
    const update = () => main.style.setProperty('--project-dock-height', `${dock.offsetHeight}px`)
    update()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(dock)
    return () => {
      observer?.disconnect()
      main.style.removeProperty('--project-dock-height')
    }
  }, [project?.id, search.settings])
  if (isAccessError(projects.error) || isAccessError(entries.error) || (projects.data && !project)) {
    return (
      <Page title="未找到项目">
        <div {...stylex.props(styles.entries)}>
          <p {...stylex.props(text.body, text.muted)}>项目已删除，或你已无权访问。</p>
        </div>
      </Page>
    )
  }
  if (!project)
    return (
      <Page title="项目">
        <div {...stylex.props(styles.entries)}>
          {projects.isError ? (
            <Banner
              icon="alert"
              title="无法加载项目"
              action={
                <Button small onClick={() => void projects.refetch()}>
                  重试项目
                </Button>
              }
            />
          ) : (
            <p role="status" {...stylex.props(text.small, text.muted)}>
              正在加载项目…
            </p>
          )}
        </div>
      </Page>
    )

  const setThread = (thread: string | undefined) =>
    void navigate({
      to: '/projects/$projectId',
      params: { projectId },
      search: (prev: ProjectSearch) => ({ ...prev, thread }),
    })

  const onRecover = (action: RecoverAction, thread: Thread) =>
    void navigate({
      to: '/threads',
      search: { compose: action === 'chooseFolder' ? 'folder' : 'focus', from: thread.id },
    })

  const onSend = () => {
    const body = draft.trim()
    if (!body || send.isPending) return
    const clientId = failed && failed.body === body ? failed.clientId : newClientId()
    setError(null)
    send.mutate(
      { projectId, body, clientId, reference },
      {
        onSuccess: () => {
          setDraft('')
          setFailed(null)
          workspace.clearReference(projectId)
        },
        onError: (cause) => {
          setFailed({ body, clientId })
          setError(cause instanceof ClientError && cause.code === 'invalid' ? cause.message : '无法发送，请重试。')
        },
      },
    )
  }

  const onStop = () => {
    if (stop.isPending) return
    setError(null)
    stop.mutate(projectId, {
      onError: (cause) => setError(cause instanceof ClientError ? cause.message : '无法停止助手，请重试。'),
    })
  }

  const onStatus = (next: 'active' | 'paused') => {
    if (changeStatus.isPending) return
    setError(null)
    changeStatus.mutate(
      { projectId, status: next },
      { onError: () => setError(`无法${next === 'active' ? '恢复' : '暂停'}项目，请重试。`) },
    )
  }
  const settings = (open: boolean, archive = false) =>
    void navigate({
      to: '/projects/$projectId',
      params: { projectId },
      search: (prev: ProjectSearch) => ({
        ...prev,
        settings: open ? true : undefined,
        archive: open && archive ? true : undefined,
      }),
    })
  const status = projectAgentStatus(project, allDevices)
  const pending = pendingInbox(inbox.data ?? [], project.id)
  const waitingMessages = list.filter(
    (entry) => entry.kind === 'user' && (entry.delivery === 'waitingDevice' || entry.delivery === 'saved'),
  ).length
  const counts = threadCounts(projectThreads, allDevices)
  const running = project.status === 'active' && project.agent.state === 'running'
  const stopping = project.agent.state === 'stopping'
  const showPanel = overviewOpen || search.thread !== undefined
  const hideDock =
    dockHidden &&
    project.status === 'active' &&
    !['blocked', 'waitingDevice', 'stopping', 'stopped'].includes(project.agent.state) &&
    !error
  const statusLine =
    error ??
    (send.isPending ? '正在发送…' : stop.isPending ? '正在停止…' : changeStatus.isPending ? '正在保存项目状态…' : null)
  const previewDevice = project.agent.deviceId ?? projectThreads[0]?.deviceId

  if (search.settings)
    return (
      <div {...stylex.props(styles.layout)}>
        <ProjectSettings
          key={project.id}
          project={project}
          initialArchive={search.archive}
          onBack={() => settings(false)}
        />
      </div>
    )

  let conversation
  if (entries.isPending) {
    conversation = <p {...stylex.props(text.caption, styles.muted)}>正在加载对话…</p>
  } else if (entries.isError && !entries.data) {
    conversation = (
      <Banner
        icon="alert"
        title="无法加载对话"
        action={
          <Button small onClick={() => void entries.refetch()}>
            重试
          </Button>
        }
      />
    )
  } else if (
    !livePreview &&
    interruptedPreview?.projectId !== projectId &&
    list.length === 0 &&
    !(inbox.data ?? []).some((item) => item.projectId === projectId)
  ) {
    conversation = <EmptyConversation project={project} />
  } else {
    const anchorAt = (seq: number) =>
      (seq === 0
        ? project.createdAt
        : (history.data?.anchors[seq] ?? list.find((entry) => entry.sourceSeq === seq)?.createdAt)) ?? project.createdAt
    const previewAt = livePreview ? anchorAt(livePreview.afterSeq) + 0.1 : project.createdAt
    const timeline = [
      ...list.map((entry) => ({
        id: entry.kind === 'assistant' && entry.streamAnchor !== undefined ? `stream-${entry.streamAnchor}` : entry.id,
        at:
          entry.kind === 'assistant' && entry.streamAnchor !== undefined
            ? anchorAt(entry.streamAnchor) + 0.1
            : entry.createdAt,
        entry,
        item: null,
        streaming: false,
      })),
      ...(inbox.data ?? [])
        .filter((item) => item.projectId === projectId)
        .map((item) => ({ id: item.id, at: item.createdAt, entry: null, item, streaming: false })),
      ...(livePreview
        ? [
            {
              id: `stream-${livePreview.afterSeq}`,
              at: previewAt,
              entry: {
                id: `preview-${livePreview.afterSeq}`,
                projectId,
                kind: 'assistant' as const,
                body: livePreview.text,
                process: [],
                threads: null,
                createdAt: previewAt,
              },
              item: null,
              streaming: !!preview,
            },
          ]
        : []),
      ...(interruptedPreview && interruptedPreview.projectId === projectId
        ? [
            {
              id: `interrupted-${interruptedPreview.afterSeq}`,
              at: anchorAt(interruptedPreview.afterSeq) + 0.1,
              entry: {
                id: `interrupted-${interruptedPreview.afterSeq}`,
                projectId,
                kind: 'note' as const,
                body: interruptedPreview.pending ? '上一条回复的保存状态待确认。' : '回复中断，内容未保存。',
                createdAt: anchorAt(interruptedPreview.afterSeq),
              },
              item: null,
              streaming: false,
            },
          ]
        : []),
    ].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    conversation = timeline.map(({ id, at, entry, item, streaming }, index) => {
      const previous = timeline[index - 1]
      const day = dayLabel(at, now)
      return (
        <div key={id} {...stylex.props(styles.assistant)}>
          {(!previous || dayLabel(previous.at, now) !== day) && (
            <span {...stylex.props(text.caption, styles.day)}>{day}</span>
          )}
          {item ? (
            <AttentionCard item={item} inProject />
          ) : (
            entry && (
              <Entry
                entry={entry}
                threads={projectThreads}
                devices={allDevices}
                openThread={search.thread}
                onOpenThread={onOpenThread}
                onOpenPath={setPreviewPath}
                streaming={streaming}
              />
            )
          )}
          {streaming && livePreview?.truncated && (
            <span {...stylex.props(text.caption, styles.faint)}>预览已截断，正在等待完整回复。</span>
          )}
        </div>
      )
    })
  }

  return (
    <div {...stylex.props(styles.layout)}>
      <Page
        embedded
        title={
          <span {...stylex.props(styles.title)}>
            <Avatar name={project.name} hue={project.hue} emoji={project.emoji} />
            {project.name}
          </span>
        }
        status={
          <>
            {(status.label !== '空闲' || waitingMessages > 0) && (
              <span {...stylex.props(text.caption, styles.headerStatus, headerTone(status.tone))}>
                {status.label}
                {waitingMessages > 0 && ` · ${waitingMessages} 条消息待发送`}
              </span>
            )}
            {running && (
              <Button variant="ghost" small icon="stop" onClick={onStop}>
                停止运行
              </Button>
            )}
            {stopping && <span {...stylex.props(text.caption, styles.muted)}>已请求停止</span>}
            {confirmationFailed && (
              <span role="status" {...stylex.props(text.caption, styles.muted)}>
                无法确认回复是否保存{' '}
                <Button
                  small
                  variant="ghost"
                  onClick={() => {
                    setConfirmationFailed(false)
                    setConfirmationAttempt((value) => value + 1)
                  }}
                >
                  重试确认
                </Button>
              </span>
            )}
            {((entries.isError && entries.data) ||
              (projects.isError && projects.data) ||
              (threads.isError && threads.data) ||
              (devices.isError && devices.data)) && (
              <SyncStatus
                retry={() => {
                  void entries.refetch()
                  void projects.refetch()
                  void threads.refetch()
                  void devices.refetch()
                }}
              />
            )}
          </>
        }
        actions={
          <>
            <Menu narrow align="end" trigger={<IconButton icon="dots" label="项目操作" />}>
              <MenuOption onSelect={() => settings(true)}>设置</MenuOption>
              <MenuOption
                onSelect={() => {
                  setOverviewOpen(true)
                  void navigate({ to: '/projects/$projectId', params: { projectId }, search: { view: 'memory' } })
                }}
              >
                记忆
              </MenuOption>
              {project.status !== 'archived' && (
                <>
                  <MenuRule />
                  <MenuOption onSelect={() => onStatus(project.status === 'paused' ? 'active' : 'paused')}>
                    {project.status === 'paused' ? '恢复项目' : '暂停项目'}
                  </MenuOption>
                  <MenuOption onSelect={() => settings(true, true)}>归档项目</MenuOption>
                </>
              )}
            </Menu>
            <IconButton
              icon="details"
              label={showPanel ? '隐藏概览' : '显示概览'}
              active={showPanel}
              aria-expanded={showPanel}
              onClick={() => {
                if (showPanel) setThread(undefined)
                setOverviewOpen(!showPanel)
              }}
            />
          </>
        }
      >
        <div {...stylex.props(styles.main)}>
          <div
            ref={timelineRef}
            role="region"
            aria-label="对话"
            onScroll={onTimelineScroll}
            {...stylex.props(styles.timeline)}
          >
            <div {...stylex.props(styles.entries)}>
              <InboxFeedback />
              {conversation}
              {(running || stopping) && project.agent.activity && (
                <span role="status" {...stylex.props(text.small, styles.activity)}>
                  {project.agent.activity}
                </span>
              )}
            </div>
          </div>
          <div
            ref={dockRef}
            inert={hideDock || undefined}
            aria-hidden={hideDock || undefined}
            {...stylex.props(styles.dock, hideDock && styles.dockHidden)}
          >
            <div {...stylex.props(styles.dockBanner)}>
              <DockBanner
                project={project}
                devices={allDevices}
                threads={projectThreads}
                onViewDevices={() => void navigate({ to: '/devices' })}
                onResume={() => onStatus('active')}
                resuming={changeStatus.isPending}
              />
            </div>
            {search.thread && (counts.running > 0 || counts.waiting > 0 || pending.length > 0) && (
              <div aria-label="项目对话" {...stylex.props(styles.chips)}>
                {counts.running > 0 && <StatusChip tone="info" label="运行中" count={counts.running} />}
                {counts.waiting > 0 && <StatusChip tone="hollow" label="等待设备" count={counts.waiting} />}
                {pending.length > 0 && <StatusChip tone="attention" label="待决定" count={pending.length} />}
              </div>
            )}
            {project.status !== 'archived' && (
              <Composer
                project
                label="给项目助手发消息"
                style={styles.dockInteractive}
                inputRef={inputRef}
                header={
                  reference && (
                    <ReferenceBlock
                      reference={reference}
                      onRemove={() => {
                        workspace.clearReference(projectId)
                        inputRef.current?.focus()
                      }}
                    />
                  )
                }
                value={draft}
                onChange={setDraft}
                onSend={onSend}
                placeholder={list.length === 0 ? '描述你想完成或验证的事…' : '给项目助手发消息…'}
              />
            )}
            <span role="status" {...stylex.props(text.caption, styles.status, error !== null && styles.danger)}>
              {statusLine}
            </span>
          </div>
        </div>
      </Page>
      {
        <ResizablePane
          key={search.thread ? 'thread' : 'overview'}
          label="调整项目面板宽度"
          storageKey="baton.width.project-panel"
          defaultWidth={search.thread ? 440 : 320}
          min={280}
          max={800}
          reserve={400}
          edge="left"
          floating={!search.thread}
          open={Boolean(search.thread) || overviewOpen}
        >
          {search.thread ? (
            <ThreadDetail
              key={search.thread}
              threadId={search.thread}
              layout="panel"
              onBack={() => setThread(undefined)}
              onClose={() => {
                setOverviewOpen(false)
                setThread(undefined)
              }}
              onRecover={onRecover}
            />
          ) : (
            <Overview
              project={project}
              devices={allDevices}
              threads={projectThreads}
              pending={pending}
              memory={memory.data}
              onOpenThread={onOpenThread}
              onOpenInbox={() => void navigate({ to: '/inbox' })}
              tab={search.view === 'memory' ? 'memory' : 'threads'}
              onTabChange={(tab) =>
                void navigate({
                  to: '/projects/$projectId',
                  params: { projectId },
                  search: (prev: ProjectSearch) => ({ ...prev, view: tab === 'memory' ? 'memory' : undefined }),
                })
              }
            />
          )}
        </ResizablePane>
      }
      {previewPath && previewDevice && (
        <FilePreview
          key={previewPath}
          deviceId={previewDevice}
          path={previewPath}
          onClose={() => setPreviewPath(null)}
          projectId={projectId}
          source={null}
        />
      )}
    </div>
  )
}
