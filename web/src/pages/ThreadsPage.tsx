import * as stylex from '@stylexjs/stylex'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { FolderDialog } from '../app/FolderDialog'
import { useLocalDirectoryPicker } from '../app/LocalDirectoryPicker'
import { Page } from '../app/Page'
import type { ThreadsSearch } from '../app/router'
import { ThreadAccessMenu } from '../app/ThreadAccessMenu'
import { ThreadDetail, type RecoverAction } from '../app/ThreadDetail'
import { ThreadModelMenu, type ThreadModelChoice } from '../app/ThreadModelMenu'
import { modelThinking, ThinkingMenu } from '../app/ThinkingMenu'
import { ResizablePane } from '../ui/ResizablePane'
import { useNow } from '../app/useNow'
import { ClientError, isAccessError } from '../data/client'
import {
  agentNames,
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
import {
  newClientId,
  useCreateThread,
  useDevices,
  useProjects,
  useSession,
  useStableThreadOrder,
  useThreads,
} from '../data/queries'
import { SyncStatus } from '../app/SyncStatus'
import type { Device, Project, Thread } from '../data/types'
import { text } from '../theme/text'
import { colors, radius, size, space } from '../theme/tokens.stylex'
import { Avatar } from '../ui/Avatar'
import { UnreadDot } from '../ui/Badge'
import { Banner } from '../ui/Banner'
import { Button, focusRing } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { Composer } from '../ui/Composer'
import { Icon } from '../ui/Icon'
import { Menu, MenuHeading, MenuOption, MenuRule } from '../ui/Menu'

const styles = stylex.create({
  layout: { display: 'flex', gap: size.gutter, flexGrow: 1, minWidth: 0, height: '100%' },
  content: { display: 'flex', flexDirection: 'column', gap: space.lg, padding: '20px' },
  composerArea: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 'clamp(280px, calc(100cqh - 300px), 480px)',
    gap: space.xs,
    paddingBottom: space.xl,
  },
  composerGroup: { width: '100%', maxWidth: '840px' },
  threadList: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.lg,
  },
  composerFrame: { position: 'relative', zIndex: 1 },
  locationBar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '2px',
    marginInline: '12px',
    marginTop: '-8px',
    paddingTop: '12px',
    paddingBottom: '4px',
    paddingInline: '8px',
    borderBottomLeftRadius: '16px',
    borderBottomRightRadius: '16px',
    backgroundColor: colors.subtle,
  },
  status: { width: '100%', maxWidth: '840px', minHeight: '18px', paddingInline: space.xs, color: colors.muted },
  danger: { color: colors.danger },
  filters: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space.xs,
    width: '100%',
    maxWidth: '960px',
    marginInline: 'auto',
    paddingLeft: space.xs,
  },
  count: { marginLeft: 'auto', color: colors.faint },
  group: { display: 'flex', flexDirection: 'column', width: '100%', maxWidth: '960px', marginInline: 'auto' },
  groupLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    minHeight: '36px',
    width: '100%',
    paddingInline: space.md,
    borderWidth: 0,
    borderRadius: radius.md,
    textAlign: 'left',
    color: colors.text,
    backgroundColor: { default: colors.subtle, ':hover': colors.hover, ':active': colors.selected },
  },
  groupChevron: { color: colors.muted },
  groupCount: { color: colors.muted },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: space.md,
    minHeight: '48px',
    paddingInline: space.md,
    paddingLeft: '24px',
    borderRadius: radius.md,
    color: colors.text,
    textDecoration: 'none',
    backgroundColor: { default: 'transparent', ':hover': colors.hover },
  },
  rowSelected: { backgroundColor: { default: colors.selected, ':hover': colors.selected } },
  unreadSlot: { display: 'inline-flex', flexShrink: 0, width: size.dot, height: size.dot },
  rowIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '24px',
    height: '24px',
    color: colors.muted,
  },
  rowIconAttention: { color: colors.attentionText },
  rowIconRunning: { color: colors.agentText },
  title: { display: 'inline-flex', alignItems: 'center', gap: space.xs, flexGrow: 1, flexBasis: 0, minWidth: 0 },
  titleText: { minWidth: 0 },
  project: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, width: '20px' },
  timer: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    flexShrink: 0,
    color: colors.muted,
    whiteSpace: 'nowrap',
    '@media (max-width: 700px)': { display: 'none' },
  },
  time: { flexShrink: 0, width: '72px', textAlign: 'right', color: colors.faint, whiteSpace: 'nowrap' },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: space.sm,
    paddingBlock: space.section,
    textAlign: 'center',
  },
  muted: { color: colors.muted },
  locationPath: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  locationSearch: {
    width: '100%',
    minHeight: '32px',
    paddingInline: space.sm,
    borderWidth: 0,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSoft,
    outline: 'none',
    backgroundColor: 'transparent',
    color: colors.text,
    '::placeholder': { color: colors.faint },
  },
  locationEmpty: { padding: space.sm, color: colors.muted },
})

type AgentChoice = ThreadModelChoice

// 所选 Agent 在这台设备上不能用时，换成第一个能用的；同一 Agent 保留手填的模型 ID。
function resolveAgent(device: Device | undefined, choice: AgentChoice | null): AgentChoice | null {
  const agents = usableAgents(device)
  const agent = agents.find((item) => item.kind === choice?.agent) ?? agents[0]
  if (!agent) return null
  const model = choice?.agent === agent.kind ? choice.model : (agent.defaultModel ?? agent.models[0] ?? '')
  return { agent: agent.kind, model }
}

function sameLocation(a: Location | null, b: Location) {
  return a !== null && a.deviceId === b.deviceId && a.folder === b.folder
}

function LocationMenus({
  location,
  threads,
  devices,
  onSelect,
  onBrowse,
  onError,
}: {
  location: Location | null
  threads: Thread[]
  devices: Device[]
  onSelect: (location: Location) => void
  onBrowse: () => void
  onError: (error: string | null) => void
}) {
  const local = useLocalDirectoryPicker({ nodeId: location?.deviceId ?? null, onSelect, onError })
  const device = devices.find((item) => item.id === location?.deviceId)
  const [search, setSearch] = useState('')
  const recent = device
    ? recentLocations(
        threads.filter((item) => item.deviceId === device.id),
        devices,
      )
    : []
  const folders = [
    ...new Set([
      ...recent.map((item) => item.folder),
      ...(location?.folder ? [location.folder] : []),
      ...(device?.repos ?? []),
    ]),
  ].filter((folder) => folder.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
  return (
    <>
      <Menu
        side="bottom"
        trigger={
          <Chip icon="device" composer aria-label={device ? `设备：${device.name}` : '选择设备'}>
            {device?.name ?? '选择设备'}
          </Chip>
        }
      >
        <MenuHeading>设备</MenuHeading>
        {devices.map((entry) => (
          <MenuOption
            key={entry.id}
            note={entry.connection === 'offline' ? '离线' : entry.connection === 'syncing' ? '正在同步' : undefined}
            selected={entry.id === device?.id}
            onSelect={() => {
              if (entry.id === location?.deviceId) return
              const next = defaultLocation(threads, devices, entry.id)
              if (next) onSelect(next)
            }}
          >
            {entry.name}
          </MenuOption>
        ))}
      </Menu>
      <Menu
        side="bottom"
        onOpenChange={(open) => {
          if (!open) setSearch('')
        }}
        trigger={
          <Chip
            icon="folder"
            composer
            aria-label={location?.folder ? `文件夹：${folderName(location.folder)}` : '选择文件夹'}
          >
            {location?.folder ? folderName(location.folder) : '选择文件夹'}
          </Chip>
        }
      >
        <input
          autoFocus
          aria-label="搜索文件夹"
          placeholder="搜索文件夹…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (!['Escape', 'Tab', 'ArrowDown'].includes(event.key)) event.stopPropagation()
          }}
          {...stylex.props(text.small, styles.locationSearch)}
        />
        {folders.length === 0 && <p {...stylex.props(text.caption, styles.locationEmpty)}>没有匹配的文件夹</p>}
        {folders.map((folder) => (
          <MenuOption
            key={folder}
            detail={
              <span title={folder} {...stylex.props(styles.locationPath)}>
                {folder}
              </span>
            }
            selected={device !== undefined && sameLocation(location, { deviceId: device.id, folder })}
            onSelect={() => {
              if (device) onSelect({ deviceId: device.id, folder })
            }}
          >
            {folderName(folder)}
          </MenuOption>
        ))}
        <MenuRule />
        {local.available && <MenuOption onSelect={() => void local.pick()}>{local.label}</MenuOption>}
        <MenuOption onSelect={onBrowse}>选择其他文件夹…</MenuOption>
      </Menu>
    </>
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
  const label = choice ? choice.model || '默认模型' : '没有可用的助手'
  return (
    <ThreadModelMenu
      agents={device?.agents ?? []}
      choice={choice}
      label={label}
      accessibleLabel={choice ? `${agentNames[choice.agent]} · ${label}` : label}
      onSelect={onSelect}
      onUnavailable={onUnavailable}
    />
  )
}

function ThreadListRow({
  thread,
  project,
  group,
  selected,
  now,
}: {
  thread: Thread
  project: Project | undefined
  group: ReturnType<typeof threadView>
  selected: boolean
  now: number
}) {
  const timer = group.live && thread.runStartedAt !== null ? runTimer(thread.runStartedAt, now) : null
  const statusIcon =
    group.group === 'attention'
      ? thread.status === 'stopped'
        ? 'stop'
        : 'alert'
      : group.group === 'waiting' || group.group === 'stopRequested'
        ? 'offline'
        : group.group === 'archived'
          ? 'archive'
          : 'message'
  return (
    <Link
      to="/threads"
      search={(prev: ThreadsSearch) => ({ ...prev, thread: thread.id })}
      aria-current={selected ? 'true' : undefined}
      aria-label={`${thread.title}, ${group.status.label}, ${project?.name ?? '无项目'}${thread.unread ? '，未读' : ''}${timer ? `，运行时间 ${timer}` : ''}，最近活动 ${relativeTime(thread.updatedAt, now)}`}
      {...stylex.props(text.small, styles.row, selected && styles.rowSelected, focusRing.ring)}
    >
      <span {...stylex.props(styles.unreadSlot)}>{thread.unread && <UnreadDot />}</span>
      <span
        title={group.status.label}
        {...stylex.props(
          styles.rowIcon,
          group.group === 'attention' && thread.status !== 'stopped' && styles.rowIconAttention,
          group.group === 'running' && styles.rowIconRunning,
        )}
      >
        <Icon name={statusIcon} size={16} />
      </span>
      <span {...stylex.props(styles.title)}>
        <span {...stylex.props(styles.titleText, text.truncate)}>{thread.title}</span>
        {timer && (
          <span title={`运行时间：${timer}`} {...stylex.props(text.caption, styles.timer)}>
            <Icon name="clock" size={12} />
            {timer}
          </span>
        )}
      </span>
      <span title={project?.name} {...stylex.props(styles.project)}>
        {project && <Avatar name={project.name} hue={project.hue} emoji={project.emoji} />}
      </span>
      <span title="最近活动" {...stylex.props(text.caption, styles.time)}>
        {relativeTime(thread.updatedAt, now)}
      </span>
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
  const [thinkingChoice, setThinkingChoice] = useState<{
    key: string
    value: import('@baton/protocol').ThinkingSelection | null
  } | null>(null)
  const [browseDevice, setBrowseDevice] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<ThreadGroup[]>([])

  const allThreads = useStableThreadOrder(isAccessError(threads.error) ? [] : (threads.data ?? []))
  const allDevices = isAccessError(devices.error) ? [] : (devices.data ?? [])
  const current = location ?? defaultLocation(allThreads, allDevices, session.data?.defaultDeviceId ?? null)
  const device = allDevices.find((item) => item.id === current?.deviceId)
  const choice = resolveAgent(device, agentChoice)
  const chosenAgent = device?.agents.find((agent) => agent.kind === choice?.agent)
  const model = choice?.model || chosenAgent?.defaultModel || ''
  const thinking = modelThinking(chosenAgent, model)
  const thinkingKey = JSON.stringify([device?.id, choice?.agent, model])
  const selectedThinking = thinkingChoice?.key === thinkingKey ? thinkingChoice.value : null
  const validThinking =
    thinking &&
    selectedThinking?.id === thinking.id &&
    thinking.options.some((option) => option.id === selectedThinking.value)
      ? selectedThinking
      : undefined
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

  // 侧栏的 New thread 和单独页面上的恢复办法通过地址带过来，处理一次后从地址里去掉。
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
    if (!current?.folder || !device) {
      setError('请先选择文件夹。')
      return
    }
    if (!choice) {
      setError(`${device.name} 上没有可用的助手。请在设备上设置，或选择其他文件夹。`)
      return
    }
    setError(null)
    create.mutate(
      {
        deviceId: current.deviceId,
        folder: current.folder,
        agent: choice.agent,
        model: choice.model,
        ...(validThinking ? { thinking: validThinking } : {}),
        body,
        clientId: newClientId(),
      },
      {
        onSuccess: (operation) => {
          setDraft('')
          setSearch({ thread: operation.targetId, archived: undefined })
        },
        onError: (cause) => setError(cause instanceof ClientError ? cause.message : '无法开始对话，请重试。'),
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
      threads: filtered.filter((thread) => views.get(thread.id)?.group === (group.id satisfies ThreadGroup)),
    }))
    .filter((group) => group.threads.length > 0)

  const filterDevice = allDevices.find((item) => item.id === search.device)
  const filterProject = projects.data?.find((item) => item.id === search.project)
  const filtering = search.device !== undefined || search.project !== undefined || archived
  const statusLine = error ?? (create.isPending ? '正在保存对话…' : null)

  let list
  if (threads.isPending) {
    list = <p {...stylex.props(text.caption, styles.muted)}>正在加载对话…</p>
  } else if (threads.isError && (!threads.data || isAccessError(threads.error))) {
    list = (
      <Banner
        icon="alert"
        title="无法加载对话"
        action={
          <Button small onClick={() => void threads.refetch()}>
            重试
          </Button>
        }
      />
    )
  } else if (allThreads.length === 0) {
    list = (
      <div {...stylex.props(styles.empty)}>
        <span {...stylex.props(text.bodyMedium)}>暂无对话</span>
        <Button small onClick={() => inputRef.current?.focus()}>
          发送第一条消息
        </Button>
      </div>
    )
  } else if (groups.length === 0) {
    list = (
      <div {...stylex.props(styles.empty)}>
        <span {...stylex.props(text.bodyMedium)}>没有匹配的对话</span>
        <Button small onClick={() => setSearch({ device: undefined, project: undefined, archived: undefined })}>
          清除筛选
        </Button>
      </div>
    )
  } else {
    list = groups.map((group) => (
      <section key={group.id} aria-label={group.label} {...stylex.props(styles.group)}>
        <h2>
          <button
            type="button"
            aria-expanded={!collapsedGroups.includes(group.id)}
            onClick={() =>
              setCollapsedGroups((current) =>
                current.includes(group.id) ? current.filter((id) => id !== group.id) : [...current, group.id],
              )
            }
            {...stylex.props(text.captionMedium, styles.groupLabel, focusRing.ring)}
          >
            <Icon
              name={collapsedGroups.includes(group.id) ? 'chevron-right' : 'chevron-down'}
              size={12}
              style={styles.groupChevron}
            />
            {group.label} <span {...stylex.props(styles.groupCount)}>{group.threads.length}</span>
          </button>
        </h2>
        {!collapsedGroups.includes(group.id) &&
          group.threads.map((thread) => (
            <ThreadListRow
              key={thread.id}
              thread={thread}
              project={projects.data?.find((item) => item.id === thread.projectId)}
              group={views.get(thread.id)!}
              selected={thread.id === search.thread}
              now={now}
            />
          ))}
      </section>
    ))
  }

  return (
    <div {...stylex.props(styles.layout)}>
      <Page
        title="对话"
        sizedBody
        bottomFade
        status={
          (threads.isError && threads.data) ||
          (devices.isError && devices.data) ||
          (projects.isError && projects.data) ? (
            <SyncStatus
              retry={() => {
                void threads.refetch()
                void devices.refetch()
                void projects.refetch()
              }}
            />
          ) : undefined
        }
      >
        <div {...stylex.props(styles.content)}>
          {devices.isError && (!devices.data || isAccessError(devices.error)) ? (
            <Banner
              icon="alert"
              title="无法加载设备"
              action={
                <Button small onClick={() => void devices.refetch()}>
                  重试
                </Button>
              }
            />
          ) : devices.data && allDevices.length === 0 ? (
            <Banner
              icon="device"
              title="请先连接设备"
              detail="对话在你的设备上运行。连接设备后即可开始。"
              action={
                <Button
                  small
                  variant="primary"
                  onClick={() => void navigate({ to: '/devices', search: { connect: true } })}
                >
                  连接设备
                </Button>
              }
            />
          ) : (
            <div {...stylex.props(styles.composerArea)}>
              <div {...stylex.props(styles.composerGroup)}>
                <div {...stylex.props(styles.composerFrame)}>
                  <Composer
                    roomy
                    label="新对话消息"
                    inputRef={inputRef}
                    value={draft}
                    onChange={setDraft}
                    onSend={onSend}
                    placeholder={choice && device ? `给 ${agentNames[choice.agent]} 发消息…` : '选择文件夹和模型后开始'}
                    chips={
                      <>
                        <ModelMenu
                          device={device}
                          choice={choice}
                          onSelect={(next) => {
                            setError(null)
                            setAgentChoice(next)
                          }}
                          onUnavailable={setError}
                        />
                        <ThinkingMenu
                          capability={thinking}
                          selection={validThinking}
                          onSelect={(value) => setThinkingChoice({ key: thinkingKey, value })}
                        />
                        {choice && device && <ThreadAccessMenu agent={choice.agent} user={device.commandAccess.user} />}
                      </>
                    }
                  />
                </div>
                <div {...stylex.props(styles.locationBar)}>
                  <LocationMenus
                    location={current}
                    threads={allThreads}
                    devices={allDevices}
                    onSelect={(next) => {
                      setError(null)
                      setLocation(next)
                    }}
                    onBrowse={() => setBrowseDevice(current?.deviceId ?? allDevices[0]?.id ?? null)}
                    onError={setError}
                  />
                </div>
              </div>
              <span role="status" {...stylex.props(text.caption, styles.status, error !== null && styles.danger)}>
                {statusLine}
              </span>
            </div>
          )}
          <div {...stylex.props(styles.threadList)}>
            <div {...stylex.props(styles.filters)}>
              <Menu trigger={<Chip icon="laptop">{filterDevice?.name ?? '所有设备'}</Chip>}>
                <MenuOption selected={!search.device} onSelect={() => setSearch({ device: undefined })}>
                  所有设备
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
              {projects.isError && (!projects.data || isAccessError(projects.error)) ? (
                <span {...stylex.props(text.caption, styles.muted)}>无法加载项目</span>
              ) : (
                <Menu
                  trigger={
                    <Chip icon="projects">
                      {search.project === 'none' ? '未关联项目' : (filterProject?.name ?? '所有项目')}
                    </Chip>
                  }
                >
                  <MenuOption selected={!search.project} onSelect={() => setSearch({ project: undefined })}>
                    所有项目
                  </MenuOption>
                  <MenuOption selected={search.project === 'none'} onSelect={() => setSearch({ project: 'none' })}>
                    未关联项目
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
              <Menu trigger={<Chip icon="archive">{archived ? '已归档' : '进行中'}</Chip>}>
                <MenuOption selected={!archived} onSelect={() => setSearch({ archived: undefined })}>
                  进行中
                </MenuOption>
                <MenuOption selected={archived} onSelect={() => setSearch({ archived: true })}>
                  已归档
                </MenuOption>
              </Menu>
              {threads.data && (
                <span {...stylex.props(text.caption, styles.count)}>
                  {filtering ? `显示 ${filtered.length} 条对话` : `${filtered.length} 条对话`}
                </span>
              )}
            </div>
            {list}
          </div>
        </div>
      </Page>
      {search.thread && (
        <ResizablePane
          label="调整对话面板宽度"
          storageKey="baton.width.thread-panel"
          defaultWidth={440}
          min={280}
          max={800}
          reserve={400}
          edge="left"
        >
          <ThreadDetail
            key={search.thread}
            threadId={search.thread}
            layout="panel"
            onClose={() => setSearch({ thread: undefined })}
            onRecover={onRecover}
          />
        </ResizablePane>
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
