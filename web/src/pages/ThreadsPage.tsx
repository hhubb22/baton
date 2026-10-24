import * as stylex from '@stylexjs/stylex'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { FolderDialog } from '../app/FolderDialog'
import { Page } from '../app/Page'
import type { ThreadsSearch } from '../app/router'
import { statusTextStyle, ThreadDetail, type RecoverAction } from '../app/ThreadDetail'
import { useNow } from '../app/useNow'
import { ClientError } from '../data/client'
import {
  agentNames,
  agentUnavailableReason,
  canCreateAgent,
  defaultLocation,
  folderName,
  recentLocations,
  relativeTime,
  runTimer,
  threadGroups,
  threadView,
  usableAgents,
  type Location,
  type ThreadGroup,
} from '../data/derive'
import { newClientId, useCreateThread, useDevices, useProjects, useSession, useThreads } from '../data/queries'
import type { AgentKind, Device, Project, Thread } from '../data/types'
import { text } from '../theme/text'
import { colors, radius, size, space } from '../theme/tokens.stylex'
import { Avatar } from '../ui/Avatar'
import { UnreadDot } from '../ui/Badge'
import { Banner } from '../ui/Banner'
import { Button, focusRing } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { Composer } from '../ui/Composer'
import { Menu, MenuHeading, MenuOption, MenuRule } from '../ui/Menu'
import { StatusDot } from '../ui/Status'

const styles = stylex.create({
  layout: { display: 'flex', flexGrow: 1, minWidth: 0, height: '100%' },
  content: { display: 'flex', flexDirection: 'column', gap: space.lg, padding: '20px' },
  composerArea: { display: 'flex', flexDirection: 'column', gap: space.xs },
  status: { minHeight: '18px', paddingInline: space.xs, color: colors.muted },
  danger: { color: colors.danger },
  filters: { display: 'flex', alignItems: 'center', gap: space.xs },
  count: { marginLeft: 'auto', color: colors.faint },
  group: { display: 'flex', flexDirection: 'column' },
  groupLabel: { paddingBlock: space.xs, paddingInline: space.md, color: colors.faint },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: space.md,
    minHeight: size.comfortable,
    paddingInline: space.md,
    borderRadius: radius.md,
    color: colors.text,
    textDecoration: 'none',
    backgroundColor: { default: 'transparent', ':hover': colors.hover },
  },
  rowSelected: { backgroundColor: { default: colors.selected, ':hover': colors.selected } },
  title: { display: 'inline-flex', alignItems: 'center', gap: space.xs, flexGrow: 1, flexBasis: 0, minWidth: 0 },
  titleText: { minWidth: 0 },
  project: { display: 'inline-flex', alignItems: 'center', gap: '6px', flexShrink: 0, width: '140px', minWidth: 0 },
  where: { flexShrink: 0, width: '170px', color: colors.muted },
  folder: { flexShrink: 0, width: '150px', color: colors.faint },
  rowStatus: { flexShrink: 0, width: '96px', whiteSpace: 'nowrap' },
  time: { flexShrink: 0, width: '72px', textAlign: 'right', color: colors.faint, whiteSpace: 'nowrap' },
  none: { color: colors.faint },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: space.sm,
    paddingBlock: space.section,
    textAlign: 'center',
  },
  muted: { color: colors.muted },
})

interface AgentChoice {
  agent: AgentKind
  model: string
}

// 所选 Agent 在这台设备上不能用时，换成第一个能用的；所选模型不在列表里时用 Agent 的默认模型。
function resolveAgent(device: Device | undefined, choice: AgentChoice | null): AgentChoice | null {
  const agents = usableAgents(device)
  const agent = agents.find((item) => item.kind === choice?.agent) ?? agents[0]
  if (!agent) return null
  const model =
    choice && agent.models.includes(choice.model) ? choice.model : (agent.defaultModel ?? agent.models[0] ?? '')
  return { agent: agent.kind, model }
}

function sameLocation(a: Location | null, b: Location) {
  return a !== null && a.deviceId === b.deviceId && a.folder === b.folder
}

function LocationMenu({
  location,
  threads,
  devices,
  onSelect,
  onBrowse,
}: {
  location: Location | null
  threads: Thread[]
  devices: Device[]
  onSelect: (location: Location) => void
  onBrowse: () => void
}) {
  const device = devices.find((item) => item.id === location?.deviceId)
  const recent = recentLocations(threads, devices)
  const label = location && device ? `${folderName(location.folder)} · ${device.name}` : 'Choose folder'
  return (
    <Menu side="bottom" trigger={<Chip icon="folder">{label}</Chip>}>
      {recent.length > 0 && <MenuHeading>Recent</MenuHeading>}
      {recent.map((item) => (
        <MenuOption
          key={`recent:${item.deviceId}:${item.folder}`}
          note={devices.find((entry) => entry.id === item.deviceId)?.name}
          selected={sameLocation(location, item)}
          onSelect={() => onSelect(item)}
        >
          {folderName(item.folder)}
        </MenuOption>
      ))}
      {devices.map((entry) => (
        <div key={entry.id}>
          <MenuHeading>
            {entry.name}
            {entry.connection === 'offline' && ' · Offline'}
          </MenuHeading>
          {entry.repos.map((folder) => (
            <MenuOption
              key={folder}
              note={folder}
              selected={sameLocation(location, { deviceId: entry.id, folder })}
              onSelect={() => onSelect({ deviceId: entry.id, folder })}
            >
              {folderName(folder)}
            </MenuOption>
          ))}
        </div>
      ))}
      <MenuRule />
      <MenuOption onSelect={onBrowse}>Choose another folder…</MenuOption>
    </Menu>
  )
}

function ModelMenu({
  device,
  choice,
  onSelect,
  onUnavailable,
}: {
  device: Device | undefined
  choice: AgentChoice | null
  onSelect: (choice: AgentChoice) => void
  onUnavailable: (message: string) => void
}) {
  const label = choice ? `${agentNames[choice.agent]} · ${choice.model || 'Default model'}` : 'No agent'
  return (
    <Menu side="bottom" trigger={<Chip icon="sparkle">{label}</Chip>}>
      {(device?.agents ?? []).map((agent) => (
        <div key={agent.kind}>
          <MenuHeading>{agentNames[agent.kind]}</MenuHeading>
          {!canCreateAgent(agent) ? (
            <MenuOption
              note={agentUnavailableReason(agent)}
              onSelect={() => onUnavailable(agentUnavailableReason(agent))}
            >
              {agentNames[agent.kind]}
            </MenuOption>
          ) : (
            (agent.models.length ? agent.models : ['']).map((model) => (
              <MenuOption
                key={model}
                selected={choice?.agent === agent.kind && choice.model === model}
                onSelect={() => onSelect({ agent: agent.kind, model })}
              >
                {model || 'Default model'}
              </MenuOption>
            ))
          )}
        </div>
      ))}
    </Menu>
  )
}

function ThreadListRow({
  thread,
  device,
  project,
  group,
  selected,
  split,
  now,
}: {
  thread: Thread
  device: Device | undefined
  project: Project | undefined
  group: ReturnType<typeof threadView>
  selected: boolean
  split: boolean
  now: number
}) {
  const timer = group.live && thread.runStartedAt !== null ? runTimer(thread.runStartedAt, now) : null
  return (
    <Link
      to="/threads"
      search={(prev: ThreadsSearch) => ({ ...prev, thread: thread.id })}
      aria-current={selected ? 'true' : undefined}
      {...stylex.props(text.small, styles.row, selected && styles.rowSelected, focusRing.ring)}
    >
      <StatusDot tone={group.status.tone} />
      <span {...stylex.props(styles.title)}>
        <span {...stylex.props(styles.titleText, text.truncate)}>{thread.title}</span>
        {thread.unread && <UnreadDot />}
      </span>
      {!split && (
        <span {...stylex.props(styles.project)}>
          {project ? (
            <>
              <Avatar name={project.name} hue={project.hue} />
              <span {...stylex.props(text.truncate)}>{project.name}</span>
            </>
          ) : (
            <span {...stylex.props(styles.none)}>No project</span>
          )}
        </span>
      )}
      <span {...stylex.props(text.caption, styles.where, text.truncate)}>
        {device?.name ?? 'Removed device'} · {thread.agent ? agentNames[thread.agent] : 'Command'}
      </span>
      {!split && (
        <span title={thread.folder} {...stylex.props(text.mono, styles.folder, text.truncate)}>
          {thread.folder}
        </span>
      )}
      <span {...stylex.props(text.caption, styles.rowStatus, statusTextStyle(group.status.tone))}>
        {timer ? <span {...stylex.props(text.mono)}>{timer}</span> : group.status.label}
      </span>
      <span {...stylex.props(text.caption, styles.time)}>{relativeTime(thread.updatedAt, now)}</span>
    </Link>
  )
}

// Threads：顶部新对话输入区、筛选和分组列表；选中的对话在右侧打开。
export function ThreadsPage() {
  const search = useSearch({ from: '/workspace/threads' })
  const navigate = useNavigate()
  const session = useSession()
  const threads = useThreads()
  const devices = useDevices()
  const projects = useProjects()
  const create = useCreateThread()
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [location, setLocation] = useState<Location | null>(null)
  const [agentChoice, setAgentChoice] = useState<AgentChoice | null>(null)
  const [browseDevice, setBrowseDevice] = useState<string | null>(null)

  const allThreads = threads.data ?? []
  const allDevices = devices.data ?? []
  const current = location ?? defaultLocation(allThreads, allDevices, session.data?.defaultDeviceId ?? null)
  const device = allDevices.find((item) => item.id === current?.deviceId)
  const choice = resolveAgent(device, agentChoice)
  const now = useNow(allThreads.some((item) => item.status === 'running') ? 1000 : 60_000)

  const setSearch = (patch: Partial<ThreadsSearch>, replace = false) =>
    void navigate({ to: '/threads', search: (prev: ThreadsSearch) => ({ ...prev, ...patch }), replace })

  // 用一个 Thread 的设备、目录和 Agent 预填新对话。
  const prefill = (action: RecoverAction | 'focus', thread: Thread | undefined) => {
    setError(null)
    if (thread) {
      setLocation({ deviceId: thread.deviceId, folder: thread.folder })
      setAgentChoice(thread.agent ? { agent: thread.agent, model: thread.model } : null)
    }
    if (action === 'chooseFolder') setBrowseDevice(thread?.deviceId ?? current?.deviceId ?? null)
  }

  // 侧栏的 New chat 和单独页面上的恢复办法通过地址带过来，处理一次后从地址里去掉。
  const request = search.compose && threads.data ? `${search.compose}:${search.from ?? ''}` : null
  const [handled, setHandled] = useState<string | null>(null)
  if (request !== handled) {
    setHandled(request)
    if (request) {
      prefill(
        search.compose === 'folder' ? 'chooseFolder' : 'focus',
        allThreads.find((item) => item.id === search.from),
      )
    }
  }
  useEffect(() => {
    if (!request) return
    if (!request.startsWith('folder')) inputRef.current?.focus()
    void navigate({
      to: '/threads',
      search: (prev: ThreadsSearch) => ({ ...prev, compose: undefined, from: undefined }),
      replace: true,
    })
  }, [request, navigate])

  const onRecover = (action: RecoverAction, thread: Thread) => {
    prefill(action, thread)
    if (action === 'newChat') inputRef.current?.focus()
  }

  const onSend = () => {
    const body = draft.trim()
    if (!body || create.isPending) return
    if (!current || !device) {
      setError('Choose a folder first.')
      return
    }
    if (!choice) {
      setError(`No agent is ready on ${device.name}. Set one up on the device, or choose another folder.`)
      return
    }
    setError(null)
    create.mutate(
      {
        deviceId: current.deviceId,
        folder: current.folder,
        agent: choice.agent,
        model: choice.model,
        body,
        clientId: newClientId(),
      },
      {
        onSuccess: (operation) => {
          setDraft('')
          setSearch({ thread: operation.targetId, archived: undefined })
        },
        onError: (cause) =>
          setError(cause instanceof ClientError ? cause.message : 'Could not start the chat. Try again.'),
      },
    )
  }

  const archived = search.archived === true
  const filtered = allThreads.filter(
    (thread) =>
      (archived ? thread.status === 'archived' : thread.status !== 'archived') &&
      (!search.device || thread.deviceId === search.device) &&
      (!search.project ||
        (search.project === 'none' ? thread.projectId === null : thread.projectId === search.project)),
  )
  const views = new Map(
    filtered.map((thread) => {
      const threadDevice = allDevices.find((item) => item.id === thread.deviceId)
      const agent = threadDevice?.agents.find((item) => item.kind === thread.agent)
      return [thread.id, threadView(thread, threadDevice, { resume: agent?.abilities.resume })]
    }),
  )
  const groups = threadGroups
    .map((group) => ({
      ...group,
      threads: filtered
        .filter((thread) => views.get(thread.id)?.group === (group.id satisfies ThreadGroup))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    }))
    .filter((group) => group.threads.length > 0)

  const split = search.thread !== undefined
  const filterDevice = allDevices.find((item) => item.id === search.device)
  const filterProject = projects.data?.find((item) => item.id === search.project)
  const filtering = search.device !== undefined || search.project !== undefined || archived
  const statusLine = error ?? (create.isPending ? 'Saving chat…' : null)

  let list
  if (threads.isPending) {
    list = <p {...stylex.props(text.caption, styles.muted)}>Loading chats…</p>
  } else if (threads.isError) {
    list = (
      <Banner
        icon="alert"
        title="Could not load chats"
        action={
          <Button small onClick={() => void threads.refetch()}>
            Retry
          </Button>
        }
      />
    )
  } else if (allThreads.length === 0) {
    list = (
      <div {...stylex.props(styles.empty)}>
        <span {...stylex.props(text.bodyMedium)}>No chats yet</span>
        <span {...stylex.props(text.small, styles.muted)}>
          Choose a folder and model above, then send your first message.
        </span>
        <Button small onClick={() => inputRef.current?.focus()}>
          Write first message
        </Button>
      </div>
    )
  } else if (groups.length === 0) {
    list = (
      <div {...stylex.props(styles.empty)}>
        <span {...stylex.props(text.bodyMedium)}>No chats match these filters</span>
        <Button small onClick={() => setSearch({ device: undefined, project: undefined, archived: undefined })}>
          Clear filters
        </Button>
      </div>
    )
  } else {
    list = groups.map((group) => (
      <section key={group.id} aria-label={group.label} {...stylex.props(styles.group)}>
        <h2 {...stylex.props(text.captionMedium, styles.groupLabel)}>{group.label}</h2>
        {group.threads.map((thread) => (
          <ThreadListRow
            key={thread.id}
            thread={thread}
            device={allDevices.find((item) => item.id === thread.deviceId)}
            project={projects.data?.find((item) => item.id === thread.projectId)}
            group={views.get(thread.id)!}
            selected={thread.id === search.thread}
            split={split}
            now={now}
          />
        ))}
      </section>
    ))
  }

  return (
    <div {...stylex.props(styles.layout)}>
      <Page title="Threads">
        <div {...stylex.props(styles.content)}>
          {devices.isError ? (
            <Banner
              icon="alert"
              title="Could not load devices"
              action={
                <Button small onClick={() => void devices.refetch()}>
                  Retry
                </Button>
              }
            />
          ) : devices.data && allDevices.length === 0 ? (
            <Banner
              icon="device"
              title="Connect a device first"
              detail="Chats run on one of your devices. Connect one to start."
              action={
                <Button
                  small
                  variant="primary"
                  onClick={() => void navigate({ to: '/devices', search: { connect: true } })}
                >
                  Connect device
                </Button>
              }
            />
          ) : (
            <div {...stylex.props(styles.composerArea)}>
              <Composer
                label="New chat message"
                inputRef={inputRef}
                value={draft}
                onChange={setDraft}
                onSend={onSend}
                placeholder={
                  choice && device
                    ? `Message ${agentNames[choice.agent]} on ${device.name}…`
                    : 'Choose a folder and model to start'
                }
                chips={
                  <>
                    <LocationMenu
                      location={current}
                      threads={allThreads}
                      devices={allDevices}
                      onSelect={(next) => {
                        setError(null)
                        setLocation(next)
                      }}
                      onBrowse={() => setBrowseDevice(current?.deviceId ?? allDevices[0]?.id ?? null)}
                    />
                    <ModelMenu
                      device={device}
                      choice={choice}
                      onSelect={(next) => {
                        setError(null)
                        setAgentChoice(next)
                      }}
                      onUnavailable={setError}
                    />
                  </>
                }
              />
              <span role="status" {...stylex.props(text.caption, styles.status, error !== null && styles.danger)}>
                {statusLine}
              </span>
            </div>
          )}
          <div {...stylex.props(styles.filters)}>
            <Menu trigger={<Chip icon="laptop">{filterDevice?.name ?? 'All devices'}</Chip>}>
              <MenuOption selected={!search.device} onSelect={() => setSearch({ device: undefined })}>
                All devices
              </MenuOption>
              {allDevices.map((item) => (
                <MenuOption
                  key={item.id}
                  selected={search.device === item.id}
                  onSelect={() => setSearch({ device: item.id })}
                >
                  {item.name}
                </MenuOption>
              ))}
            </Menu>
            {projects.isError ? (
              <span {...stylex.props(text.caption, styles.muted)}>Projects unavailable</span>
            ) : (
              <Menu
                trigger={
                  <Chip icon="tasks">
                    {search.project === 'none' ? 'No project' : (filterProject?.name ?? 'All projects')}
                  </Chip>
                }
              >
                <MenuOption selected={!search.project} onSelect={() => setSearch({ project: undefined })}>
                  All projects
                </MenuOption>
                <MenuOption selected={search.project === 'none'} onSelect={() => setSearch({ project: 'none' })}>
                  No project
                </MenuOption>
                {projects.data?.map((item) => (
                  <MenuOption
                    key={item.id}
                    selected={search.project === item.id}
                    onSelect={() => setSearch({ project: item.id })}
                  >
                    {item.name}
                  </MenuOption>
                ))}
              </Menu>
            )}
            <Menu trigger={<Chip icon="archive">{archived ? 'Archived' : 'Active'}</Chip>}>
              <MenuOption selected={!archived} onSelect={() => setSearch({ archived: undefined })}>
                Active
              </MenuOption>
              <MenuOption selected={archived} onSelect={() => setSearch({ archived: true })}>
                Archived
              </MenuOption>
            </Menu>
            {threads.data && (
              <span {...stylex.props(text.caption, styles.count)}>
                {filtered.length === 1 ? '1 thread' : `${filtered.length} threads`}
                {filtering && ' shown'}
              </span>
            )}
          </div>
          {list}
        </div>
      </Page>
      {search.thread && (
        <ThreadDetail
          key={search.thread}
          threadId={search.thread}
          layout="panel"
          onClose={() => setSearch({ thread: undefined })}
          onRecover={onRecover}
        />
      )}
      {browseDevice && (
        <FolderDialog
          deviceId={browseDevice}
          onClose={() => setBrowseDevice(null)}
          onSelect={(next) => {
            setBrowseDevice(null)
            setLocation(next)
            setError(null)
            inputRef.current?.focus()
          }}
        />
      )}
    </div>
  )
}
