import * as stylex from '@stylexjs/stylex'
import { AttentionCard } from '../app/AttentionCard'
import { InboxFeedback } from '../app/InboxFeedback'
import { ProjectRecovery } from '../app/ProjectRecovery'
import { ProjectMemory } from '../app/ProjectMemory'
import { ProjectSettingsDialog } from '../app/ProjectSettingsDialog'
import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { FilePreview } from '../app/FilePreview'
import { MessageBody } from '../app/MessageBody'
import { Page } from '../app/Page'
import { ReferenceBlock } from '../app/ReferenceBlock'
import type { ProjectSearch } from '../app/router'
import { statusTextStyle, ThreadDetail, type RecoverAction } from '../app/ThreadDetail'
import { useNow } from '../app/useNow'
import { useWorkspace } from '../app/workspace'
import { ClientError } from '../data/client'
import {
  agentNames,
  assistantWait,
  folderName,
  pendingInbox,
  projectAgentStatus,
  relativeTime,
  runTimer,
  threadCardStatus,
  threadView,
  type StatusView,
} from '../data/derive'
import {
  newClientId,
  useDevices,
  useInbox,
  useProjectEntries,
  useProjectMemory,
  useProjects,
  useSendProjectMessage,
  useSetProjectStatus,
  useStopProjectRun,
  useThreads,
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
import { branch } from '../ui/Branch'
import { Composer } from '../ui/Composer'
import { Icon } from '../ui/Icon'
import { Menu, MenuOption, MenuRule } from '../ui/Menu'
import { StatusChip, StatusDot, type Tone } from '../ui/Status'
import { Tabs } from '../ui/Tabs'

const styles = stylex.create({
  layout: { display: 'flex', gap: size.gutter, flexGrow: 1, minWidth: 0, height: '100%' },
  title: { display: 'flex', alignItems: 'center', gap: space.sm },
  headerStatus: { display: 'inline-flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' },
  agentText: { color: colors.agentText },
  muted: { color: colors.muted },
  faint: { color: colors.faint },
  danger: { color: colors.danger },
  main: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
  timeline: { flexGrow: 1, minHeight: 0, overflowY: 'auto', outline: 'none' },
  entries: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.lg,
    width: '100%',
    maxWidth: size.measure,
    marginInline: 'auto',
    padding: space.xl,
  },
  day: { alignSelf: 'center', color: colors.faint },
  userItem: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px' },
  user: {
    maxWidth: '85%',
    paddingBlock: space.sm,
    paddingInline: space.md,
    borderRadius: '14px',
    backgroundColor: colors.subtle,
  },
  withdrawn: { color: colors.muted },
  assistant: { display: 'flex', flexDirection: 'column', gap: space.md },
  processToggle: {
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
    gap: space.sm,
    paddingLeft: space.md,
    borderLeftWidth: '2px',
    borderLeftStyle: 'solid',
    borderLeftColor: colors.borderSoft,
  },
  step: { display: 'flex', flexDirection: 'column', gap: space.xs },
  stepHead: { display: 'flex', alignItems: 'baseline', gap: space.sm, flexWrap: 'wrap' },
  output: {
    margin: 0,
    maxHeight: '200px',
    overflow: 'auto',
    padding: space.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.subtle,
    fontFamily: fonts.mono,
    fontSize: '12px',
    whiteSpace: 'pre-wrap',
  },
  threadGroup: { display: 'flex', flexDirection: 'column', gap: space.xs },
  groupTitle: { flexGrow: 1 },
  threadRow: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    width: '100%',
    minHeight: size.comfortable,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radius.md,
    backgroundColor: { default: 'transparent', ':hover': colors.hover },
    color: colors.text,
    textAlign: 'left',
  },
  threadSelected: { backgroundColor: { default: colors.selected, ':hover': colors.selected } },
  threadTitle: { flexGrow: 1, flexBasis: 0, minWidth: 0 },
  folderTag: { flexShrink: 1, minWidth: 0, color: colors.faint },
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
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: space.sm,
    flexShrink: 0,
    paddingInline: space.xl,
    paddingBottom: space.md,
  },
  chips: { display: 'flex', flexWrap: 'wrap', gap: space.xs, width: '100%', maxWidth: size.measure },
  status: { width: '100%', maxWidth: size.measure, minHeight: '18px', color: colors.muted },
  overview: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.lg,
    flexShrink: 0,
    width: size.overview,
    height: '100%',
    overflowY: 'auto',
    padding: space.lg,
    backgroundColor: colors.glassLift,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.glassEdge,
    borderRadius: radius.lg,
  },
  section: { display: 'flex', flexDirection: 'column', gap: space.xs },
  sectionLabel: { color: colors.faint },
  assistantHead: { display: 'flex', alignItems: 'center', gap: space.sm },
  group: { display: 'flex', flexDirection: 'column' },
  groupLabel: { paddingBlock: space.xs, paddingInline: space.sm, color: colors.faint },
  overviewRow: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    width: '100%',
    minHeight: size.control,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: 'transparent', ':hover': colors.hover },
    color: colors.text,
    textAlign: 'left',
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

function plural(count: number, word: string) {
  return `${count} ${count === 1 ? word : `${word}s`}`
}

function dayLabel(at: number, now: number) {
  const day = (value: number) => new Date(value).toDateString()
  if (day(at) === day(now)) return 'Today'
  if (day(at) === day(now - 86_400_000)) return 'Yesterday'
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function deliveryNote(delivery: Delivery, subscription: string, status: Project['status']) {
  switch (delivery) {
    case 'submitted':
      return 'Sending…'
    case 'saved':
      return status === 'paused' ? 'Saved · the assistant reads it when the project resumes' : 'Saved'
    case 'queued':
      return 'Saved · the assistant reads it after this step'
    case 'waitingDevice':
      return `Saved · waiting for a device with ${subscription} signed in`
    case 'withdrawn':
      return 'Not sent · you stopped the run'
    case 'unknown':
      return 'Not sure if the assistant received this'
    case 'delivered':
      return null
  }
}

function processSummary(steps: ProcessStep[]) {
  const commands = steps.filter((step) => step.kind === 'command').length
  const notes = steps.length - commands
  const parts = []
  if (commands > 0) parts.push(`ran ${plural(commands, 'command')}`)
  if (notes > 0) parts.push(`saved ${plural(notes, 'note')}`)
  const line = parts.join(', ')
  return line.charAt(0).toUpperCase() + line.slice(1)
}

const cardTitles: Record<EntryThreads['action'], (count: number) => string> = {
  opened: (count) => `Opened ${plural(count, 'chat')}`,
  messaged: (count) => `Messaged ${plural(count, 'chat')}`,
  replies: (count) => `Replies from ${plural(count, 'chat')}`,
}

function ProcessLine({ steps, devices }: { steps: ProcessStep[]; devices: Device[] }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        {...stylex.props(text.caption, styles.processToggle, focusRing.ring)}
      >
        {processSummary(steps)}
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
      </button>
      {open && (
        <div {...stylex.props(styles.steps)}>
          {steps.map((step, index) =>
            step.kind === 'command' ? (
              <div key={index} {...stylex.props(styles.step)}>
                <div {...stylex.props(styles.stepHead)}>
                  <code {...stylex.props(text.mono)}>{step.command}</code>
                  <span {...stylex.props(text.caption, step.exitCode === 0 ? styles.faint : styles.danger)}>
                    {devices.find((item) => item.id === step.deviceId)?.name ?? 'Removed device'} · exit {step.exitCode}{' '}
                    · {(step.durationMs / 1000).toFixed(1)}s
                  </span>
                </div>
                {step.output && <pre {...stylex.props(styles.output)}>{step.output}</pre>}
              </div>
            ) : (
              <p key={index} {...stylex.props(text.small, styles.muted)}>
                Saved note: {step.body}
              </p>
            ),
          )}
        </div>
      )}
    </>
  )
}

function ThreadButton({
  thread,
  device,
  selected,
  now,
  onOpen,
}: {
  thread: Thread
  device: Device | undefined
  selected: boolean
  now: number
  onOpen: () => void
}) {
  const view = threadView(thread, device)
  const timer = view.live && thread.runStartedAt !== null ? runTimer(thread.runStartedAt, now) : null
  return (
    <button
      type="button"
      aria-current={selected || undefined}
      onClick={onOpen}
      {...stylex.props(text.small, styles.threadRow, selected && styles.threadSelected, focusRing.ring)}
    >
      <StatusDot tone={view.status.tone} />
      <span {...stylex.props(styles.threadTitle, text.truncate)}>{thread.title}</span>
      <span {...stylex.props(text.mono, styles.folderTag, text.truncate)}>{folderName(thread.folder)}</span>
      <span {...stylex.props(text.caption, styles.threadMeta)}>
        {device?.name ?? 'Removed device'} · {thread.agent ? agentNames[thread.agent] : 'Command'}
      </span>
      <span {...stylex.props(text.caption, styles.threadMeta, statusTextStyle(view.status.tone))}>
        {timer ?? view.status.label}
      </span>
    </button>
  )
}

function ThreadCard({
  threads: info,
  all,
  devices,
  openThread,
  now,
  onOpen,
}: {
  threads: EntryThreads
  all: Thread[]
  devices: Device[]
  openThread: string | undefined
  now: number
  onOpen: (threadId: string) => void
}) {
  const threads = info.threadIds.flatMap((id) => all.filter((item) => item.id === id))
  if (threads.length === 0) return null
  const status = threadCardStatus(threads)
  return (
    <section aria-label={cardTitles[info.action](threads.length)} {...stylex.props(styles.threadGroup)}>
      <div {...stylex.props(text.small, branch.title)}>
        <span {...stylex.props(styles.groupTitle)}>{cardTitles[info.action](threads.length)}</span>
        <span {...stylex.props(text.caption, styles.headerStatus, statusTextStyle(status.tone))}>
          <StatusDot tone={status.tone} />
          {status.label}
        </span>
      </div>
      <div {...stylex.props(branch.line)}>
        {threads.map((thread) => (
          <ThreadButton
            key={thread.id}
            thread={thread}
            device={devices.find((item) => item.id === thread.deviceId)}
            selected={thread.id === openThread}
            now={now}
            onOpen={() => onOpen(thread.id)}
          />
        ))}
      </div>
    </section>
  )
}

function Entry({
  entry,
  project,
  threads,
  devices,
  openThread,
  now,
  onOpenThread,
  onOpenPath,
}: {
  entry: ProjectEntry
  project: Project
  threads: Thread[]
  devices: Device[]
  openThread: string | undefined
  now: number
  onOpenThread: (threadId: string) => void
  onOpenPath: (path: string) => void
}) {
  switch (entry.kind) {
    case 'user': {
      const note = deliveryNote(entry.delivery, project.subscription, project.status)
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
        <article aria-label="Project assistant" {...stylex.props(styles.assistant)}>
          {entry.process.length > 0 && <ProcessLine steps={entry.process} devices={devices} />}
          {entry.threads && (
            <ThreadCard
              threads={entry.threads}
              all={threads}
              devices={devices}
              openThread={openThread}
              now={now}
              onOpen={onOpenThread}
            />
          )}
          {entry.body && (
            <div {...stylex.props(text.body)}>
              <MessageBody body={entry.body} onOpenPath={onOpenPath} />
            </div>
          )}
        </article>
      )
    case 'note':
      return <p {...stylex.props(text.caption, styles.note)}>{entry.body}</p>
  }
}

// 主对话没有内容时的引导。
function EmptyConversation({ project }: { project: Project }) {
  return (
    <div {...stylex.props(styles.empty)}>
      <Avatar name={project.name} hue={project.hue} large />
      <span {...stylex.props(text.title)}>{project.name}</span>
      {project.goal && <span {...stylex.props(text.small, styles.emptyHint)}>{project.goal}</span>}
      <span {...stylex.props(text.small, styles.emptyHint)}>
        Ask the assistant to run tests, fix bugs, or check logs on your connected computers.
      </span>
    </div>
  )
}

function assistantLine(project: Project, devices: Device[]) {
  switch (project.agent.state) {
    case 'blocked':
      return project.agent.reason ?? 'Needs attention'
    case 'waitingDevice':
      return assistantWait(project, devices).overview
    case 'stopping':
      return 'Stop requested. Threads continue on their devices.'
    case 'stopped':
      return project.agent.reason ?? `${project.subscription} · ${project.model}`
    default:
      return `${project.subscription} · ${project.model}`
  }
}

function Overview({
  project,
  status,
  devices,
  threads,
  pending,
  memory,
  onOpenThread,
  onOpenInbox,
  onSettings,
  tab,
  onTabChange,
}: {
  project: Project
  status: StatusView
  devices: Device[]
  threads: Thread[]
  pending: InboxItem[]
  memory: MemoryNote[] | undefined
  onOpenThread: (threadId: string) => void
  onOpenInbox: () => void
  onSettings: () => void
  tab: 'threads' | 'memory'
  onTabChange: (tab: 'threads' | 'memory') => void
}) {
  const [showAll, setShowAll] = useState(false)
  const now = useNow(60_000)
  const device = devices.find((item) => item.id === project.agent.deviceId)
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
  const inGroup = (...groups: string[]) =>
    live.filter((thread) => groups.includes(views.get(thread.id)!.group)).sort((a, b) => b.updatedAt - a.updatedAt)
  const recent = inGroup('idle')
  const groups = [
    { label: 'Needs attention', threads: inGroup('attention') },
    { label: 'Running', threads: inGroup('running', 'stopping') },
    { label: 'Waiting for device', threads: inGroup('waiting', 'stopRequested') },
    { label: 'Recent', threads: showAll ? recent : recent.slice(0, recentLimit) },
  ]

  const row = (thread: Thread) => {
    const view = views.get(thread.id)!
    return (
      <button
        key={thread.id}
        type="button"
        onClick={() => onOpenThread(thread.id)}
        {...stylex.props(text.small, styles.overviewRow, focusRing.ring)}
      >
        <StatusDot tone={view.status.tone} />
        <span {...stylex.props(styles.threadTitle, text.truncate)}>{thread.title}</span>
        <span {...stylex.props(text.caption, styles.threadMeta, statusTextStyle(view.status.tone))}>
          {view.group === 'idle' ? relativeTime(thread.updatedAt, now) : view.status.label}
        </span>
      </button>
    )
  }

  return (
    <aside aria-label="Overview" {...stylex.props(styles.overview)}>
      <div {...stylex.props(styles.assistantHead)}>
        <h2 {...stylex.props(text.bodyMedium)}>Overview</h2>
        <IconButton icon="settings" label="Project settings" onClick={onSettings} />
      </div>
      {project.goal && (
        <section {...stylex.props(styles.section)}>
          <h3 {...stylex.props(text.captionMedium, styles.sectionLabel)}>Goal</h3>
          <p {...stylex.props(text.small)}>{project.goal}</p>
        </section>
      )}
      <section aria-label="Project assistant" {...stylex.props(styles.section)}>
        <h3 {...stylex.props(text.captionMedium, styles.sectionLabel)}>Project assistant</h3>
        <div {...stylex.props(styles.assistantHead)}>
          <Icon name="laptop" size={14} style={styles.muted} />
          <span {...stylex.props(text.label, text.truncate)}>{device?.name ?? 'No device yet'}</span>
        </div>
        <span
          {...stylex.props(
            text.caption,
            styles.headerStatus,
            status.tone === 'agent' ? styles.agentText : statusTextStyle(status.tone),
          )}
        >
          <StatusDot tone={status.tone} />
          {project.agent.state === 'stopping' ? 'Stopping' : status.label.replace(/ on .*$/, '')}
        </span>
        <span {...stylex.props(text.caption, styles.muted)}>{assistantLine(project, devices)}</span>
      </section>
      <Tabs
        label="Overview lists"
        value={tab}
        onChange={onTabChange}
        options={[
          { value: 'threads', label: 'Threads', count: live.length },
          { value: 'memory', label: 'Memory', count: memory?.length ?? 0 },
        ]}
      />
      {tab === 'threads' && (
        <>
          {live.length === 0 && pending.length === 0 && (
            <p {...stylex.props(text.small, styles.faint)}>
              No chats in this project yet. Ask the assistant to start work.
            </p>
          )}
          {pending.length > 0 && (
            <section aria-label="Decisions" {...stylex.props(styles.group)}>
              <h3 {...stylex.props(text.captionMedium, styles.groupLabel)}>Needs decision</h3>
              {pending.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={onOpenInbox}
                  {...stylex.props(text.small, styles.overviewRow, focusRing.ring)}
                >
                  <StatusDot tone="attention" />
                  <span {...stylex.props(styles.threadTitle, text.truncate)}>{item.title}</span>
                </button>
              ))}
            </section>
          )}
          {groups
            .filter((group) => group.threads.length > 0)
            .map((group) => (
              <section key={group.label} aria-label={group.label} {...stylex.props(styles.group)}>
                <h3 {...stylex.props(text.captionMedium, styles.groupLabel)}>{group.label}</h3>
                {group.threads.map(row)}
              </section>
            ))}
          {!showAll && recent.length > recentLimit && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              {...stylex.props(text.caption, styles.more, focusRing.ring)}
            >
              Show {recent.length - recentLimit} more
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
  onViewDevices,
  onResume,
  resuming,
}: {
  project: Project
  devices: Device[]
  onViewDevices: () => void
  onResume: () => void
  resuming: boolean
}) {
  if (project.status === 'archived')
    return (
      <Banner
        icon="archive"
        title="This project is archived"
        detail="Chats and memory are kept. Existing threads can still be used."
      />
    )
  if (project.status === 'paused') {
    return (
      <Banner
        icon="pause"
        title="This project is paused"
        detail="Messages and replies are saved until you resume. Threads and questions remain available."
        action={
          <Button small onClick={onResume}>
            {resuming ? 'Resuming…' : 'Resume project'}
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
              View devices
            </Button>
          }
        />
      )
    }
    case 'stopping':
      return (
        <Banner
          icon="stop"
          title="Waiting for the project assistant to stop"
          detail="Existing threads keep running. This does not undo file changes or commands already run."
        />
      )
    case 'stopped':
      if (!project.agent.reason) return null
      return (
        <Banner
          icon="alert"
          title="The project assistant stopped"
          detail={`${project.agent.reason}. Send a message to start it again.`}
        />
      )
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
  const { projectId } = useParams({ from: '/workspace/projects/$projectId' })
  const search: ProjectSearch = useSearch({ from: '/workspace/projects/$projectId' })
  const navigate = useNavigate()
  const projects = useProjects()
  const devices = useDevices()
  const threads = useThreads()
  const inbox = useInbox()
  const entries = useProjectEntries(projectId)
  const memory = useProjectMemory(projectId)
  const send = useSendProjectMessage()
  const stop = useStopProjectRun()
  const changeStatus = useSetProjectStatus()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  // 发送失败后正文没改就沿用同一个 clientId，重试不会多出一条消息。
  const [failed, setFailed] = useState<{ body: string; clientId: string } | null>(null)
  const [overviewOpen, setOverviewOpen] = useState(true)
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const workspace = useWorkspace()
  const reference = workspace.references[projectId] ?? null

  const allDevices = devices.data ?? []
  const projectThreads = (threads.data ?? []).filter((item) => item.projectId === projectId)
  const now = useNow(projectThreads.some((item) => item.status === 'running') ? 1000 : 60_000)
  const list = entries.data ?? []

  // 新记录到达时滚到底部。
  useEffect(() => {
    const timeline = timelineRef.current
    if (timeline) timeline.scrollTop = timeline.scrollHeight
  }, [list.length, projectId])

  // 从别处选中内容带过来时，把焦点放到输入区。
  useEffect(() => {
    if (reference) inputRef.current?.focus()
  }, [reference])

  const project = projects.data?.find((item) => item.id === projectId)
  if (projects.data && !project) {
    return (
      <Page title="Project not found">
        <div {...stylex.props(styles.entries)}>
          <p {...stylex.props(text.body, text.muted)}>This project was deleted or you no longer have access.</p>
        </div>
      </Page>
    )
  }
  if (!project)
    return (
      <Page title="Project">
        <div {...stylex.props(styles.entries)}>
          {projects.isError ? (
            <Banner
              icon="alert"
              title="Could not load project"
              detail="Your project and conversation are kept. Try again."
              action={
                <Button small onClick={() => void projects.refetch()}>
                  Retry project
                </Button>
              }
            />
          ) : (
            <p role="status" {...stylex.props(text.small, text.muted)}>
              Loading project…
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

  const onOpenThread = (threadId: string) => {
    setOverviewOpen(true)
    setThread(threadId)
  }

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
          setError(
            cause instanceof ClientError && cause.code === 'invalid'
              ? cause.message
              : 'Could not send. Your message is kept here. Try again.',
          )
        },
      },
    )
  }

  const onStop = () => {
    if (stop.isPending) return
    setError(null)
    stop.mutate(projectId, {
      onError: (cause) => setError(cause instanceof ClientError ? cause.message : 'Could not stop the run. Try again.'),
    })
  }

  const onStatus = (next: 'active' | 'paused') => {
    if (changeStatus.isPending) return
    setError(null)
    changeStatus.mutate(
      { projectId, status: next },
      { onError: () => setError(`Could not ${next === 'active' ? 'resume' : 'pause'} this project. Try again.`) },
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
  const statusLine =
    error ??
    (send.isPending
      ? 'Sending…'
      : stop.isPending
        ? 'Stopping…'
        : changeStatus.isPending
          ? 'Saving project status…'
          : null)
  const previewDevice = project.agent.deviceId ?? projectThreads[0]?.deviceId

  let conversation
  if (entries.isPending) {
    conversation = <p {...stylex.props(text.caption, styles.muted)}>Loading conversation…</p>
  } else if (entries.isError) {
    conversation = (
      <Banner
        icon="alert"
        title="Could not load the conversation"
        action={
          <Button small onClick={() => void entries.refetch()}>
            Retry
          </Button>
        }
      />
    )
  } else if (list.length === 0 && !(inbox.data ?? []).some((item) => item.projectId === projectId)) {
    conversation = <EmptyConversation project={project} />
  } else {
    const timeline = [
      ...list.map((entry) => ({ id: entry.id, at: entry.createdAt, entry, item: null })),
      ...(inbox.data ?? [])
        .filter((item) => item.projectId === projectId)
        .map((item) => ({ id: item.id, at: item.createdAt, entry: null, item })),
    ].sort((a, b) => a.at - b.at)
    conversation = timeline.map(({ id, at, entry, item }, index) => {
      const previous = timeline[index - 1]
      const day = dayLabel(at, now)
      return (
        <div key={id} {...stylex.props(styles.assistant)}>
          {(!previous || dayLabel(previous.at, now) !== day) && (
            <span {...stylex.props(text.caption, styles.day)}>{day}</span>
          )}
          {item ? (
            <AttentionCard item={item} />
          ) : (
            entry && (
              <Entry
                entry={entry}
                project={project}
                threads={projectThreads}
                devices={allDevices}
                openThread={search.thread}
                now={now}
                onOpenThread={onOpenThread}
                onOpenPath={setPreviewPath}
              />
            )
          )}
        </div>
      )
    })
  }

  return (
    <div {...stylex.props(styles.layout)}>
      <Page
        title={
          <span {...stylex.props(styles.title)}>
            <Avatar name={project.name} hue={project.hue} />
            {project.name}
          </span>
        }
        actions={
          <>
            <span {...stylex.props(text.caption, styles.headerStatus, headerTone(status.tone))}>
              <StatusDot tone={status.tone} />
              {status.label}
              {waitingMessages > 0 && ` · ${plural(waitingMessages, 'message')} waiting`}
            </span>
            {running && (
              <Button variant="ghost" small icon="stop" onClick={onStop}>
                Stop run
              </Button>
            )}
            {stopping && <span {...stylex.props(text.caption, styles.muted)}>Stop requested</span>}
            <Menu narrow align="end" trigger={<IconButton icon="dots" label="Project actions" />}>
              <MenuOption onSelect={() => settings(true)}>Settings</MenuOption>
              <MenuOption
                onSelect={() => {
                  setOverviewOpen(true)
                  void navigate({ to: '/projects/$projectId', params: { projectId }, search: { view: 'memory' } })
                }}
              >
                Memory
              </MenuOption>
              {project.status !== 'archived' && (
                <>
                  <MenuRule />
                  <MenuOption onSelect={() => onStatus(project.status === 'paused' ? 'active' : 'paused')}>
                    {project.status === 'paused' ? 'Resume project' : 'Pause project'}
                  </MenuOption>
                  <MenuOption onSelect={() => settings(true, true)}>Archive project</MenuOption>
                </>
              )}
            </Menu>
            <IconButton
              icon="panel-right"
              label={showPanel ? 'Hide overview' : 'Show overview'}
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
          <div ref={timelineRef} role="region" aria-label="Conversation" {...stylex.props(styles.timeline)}>
            <div {...stylex.props(styles.entries)}>
              <InboxFeedback />
              {conversation}
              {(running || stopping) && project.agent.activity && (
                <span role="status" {...stylex.props(text.small, styles.activity)}>
                  <StatusDot tone="agent" />
                  {project.agent.activity}
                </span>
              )}
            </div>
          </div>
          <div {...stylex.props(styles.dock)}>
            <DockBanner
              project={project}
              devices={allDevices}
              onViewDevices={() => void navigate({ to: '/devices' })}
              onResume={() => onStatus('active')}
              resuming={changeStatus.isPending}
            />
            {search.thread && (counts.running > 0 || counts.waiting > 0 || pending.length > 0) && (
              <div aria-label="Project threads" {...stylex.props(styles.chips)}>
                {counts.running > 0 && <StatusChip tone="info" label="Running" count={counts.running} />}
                {counts.waiting > 0 && <StatusChip tone="hollow" label="Waiting for device" count={counts.waiting} />}
                {pending.length > 0 && <StatusChip tone="attention" label="Needs decision" count={pending.length} />}
              </div>
            )}
            {project.status !== 'archived' && (
              <Composer
                label="Message the project assistant"
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
                placeholder={
                  list.length === 0 ? 'Describe what you want to build or verify…' : 'Ask the project assistant…'
                }
              />
            )}
            <span role="status" {...stylex.props(text.caption, styles.status, error !== null && styles.danger)}>
              {statusLine}
            </span>
          </div>
        </div>
      </Page>
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
        showPanel && (
          <Overview
            project={project}
            status={status}
            devices={allDevices}
            threads={projectThreads}
            pending={pending}
            memory={memory.data}
            onOpenThread={onOpenThread}
            onOpenInbox={() => void navigate({ to: '/inbox' })}
            onSettings={() => settings(true)}
            tab={search.view === 'memory' ? 'memory' : 'threads'}
            onTabChange={(tab) =>
              void navigate({
                to: '/projects/$projectId',
                params: { projectId },
                search: (prev: ProjectSearch) => ({ ...prev, view: tab === 'memory' ? 'memory' : undefined }),
              })
            }
          />
        )
      )}
      {search.settings && (
        <ProjectSettingsDialog
          key={project.id}
          project={project}
          initialArchive={search.archive}
          onClose={() => settings(false)}
        />
      )}
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
