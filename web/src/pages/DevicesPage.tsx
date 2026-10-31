import * as stylex from '@stylexjs/stylex'
import { isAccessError } from '../data/client'
import { SyncStatus } from '../app/SyncStatus'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { EnrollDialog } from '../app/EnrollDialog'
import { LocalDeviceDiagnostics } from '../app/LocalDeviceDiagnostics'
import { SubscriptionLoginDialog } from '../app/SubscriptionLoginDialog'
import { ModelConnectionEditor } from '../app/ModelConnectionEditor'
import { Page } from '../app/Page'
import { useNow } from '../app/useNow'
import { agentSummary, capabilityLines, deviceConnectionView, devicesHeading, systemName } from '../data/derive'
import {
  useDevices,
  useClient,
  useDownloads,
  useDeviceFolders,
  useProjects,
  useRemoveDevice,
  useRemoveDeviceFolder,
  useSession,
  useSetCommandAccess,
  useSetDefaultDevice,
} from '../data/queries'
import type { Device, ID, ModelConnection } from '../data/types'
import { desktopStatusLabel, desktopStatusReason, needsDesktopReauth, useDesktopStatus } from '../data/desktop'
import { text } from '../theme/text'
import { semantic } from '../theme/semantic.stylex'
import { radius, space } from '../theme/tokens.stylex'
import { Button, focusRing } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Icon } from '../ui/Icon'
import { Menu, MenuOption } from '../ui/Menu'
import { StatusDot } from '../ui/Status'
import { Toggle } from '../ui/Toggle'

const styles = stylex.create({
  column: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.lg,
    width: '100%',
    maxWidth: '800px',
    marginInline: 'auto',
    paddingBlock: space.xxl,
    paddingInline: space.xl,
  },
  intro: { display: 'flex', alignItems: 'center', gap: space.xl, paddingInline: space.lg },
  heading: { flexGrow: 1, outline: 'none' },
  desktopLink: { color: semantic.brandForeground, whiteSpace: 'nowrap' },
  notice: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.sm,
    paddingBlock: '14px',
    paddingInline: space.lg,
    backgroundColor: semantic.sidebar,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: semantic.border,
    borderRadius: radius.lg,
    outline: 'none',
  },
  noticeActions: { display: 'flex', alignItems: 'center', gap: space.md },
  // 整页的行，不画外框，靠 borderSoft 分隔线分开。
  list: {
    display: 'flex',
    flexDirection: 'column',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: semantic.border,
  },
  item: {
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: semantic.border,
  },
  rowOpen: { backgroundColor: { default: semantic.accent, ':hover': semantic.accent } },
  row: {
    display: 'grid',
    gridTemplateColumns: '32px minmax(0, 1fr) 200px 170px 16px',
    alignItems: 'center',
    gap: space.md,
    width: '100%',
    paddingBlock: space.md,
    paddingInline: space.lg,
    borderWidth: 0,
    backgroundColor: { default: 'transparent', ':hover': semantic.muted },
    color: semantic.foreground,
    textAlign: 'left',
  },
  tile: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '32px',
    height: '32px',
    color: semantic.mutedForeground,
  },
  identity: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  nameLine: { display: 'flex', alignItems: 'center', gap: space.sm, minWidth: 0 },
  status: { display: 'flex', alignItems: 'center', gap: space.sm, minWidth: 0 },
  agentStatus: { color: semantic.agentForeground },
  attention: { color: semantic.warningForeground },
  chevron: { color: semantic.faintForeground },
  details: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.lg,
    paddingLeft: '60px',
    paddingRight: space.lg,
  },
  group: { display: 'flex', flexDirection: 'column', gap: space.sm, minWidth: 0 },
  sourceHeading: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  sourceRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    paddingBlock: space.xs,
  },
  sourceInfo: { display: 'flex', flexDirection: 'column', gap: space.xxs, minWidth: 0 },
  capability: { display: 'flex', alignItems: 'baseline', gap: space.sm },
  logins: { display: 'flex', flexWrap: 'wrap', gap: space.sm },
  permission: { display: 'flex', alignItems: 'flex-start', gap: space.lg },
  permissionText: { display: 'flex', flexDirection: 'column', gap: space.xxs, flexGrow: 1 },
  actions: { display: 'flex', alignItems: 'center', gap: space.sm },
  disconnect: { marginInlineStart: 'auto' },
  folders: { display: 'flex', flexDirection: 'column' },
  folder: {
    display: 'flex',
    alignItems: 'center',
    gap: space.md,
    paddingBlock: space.md,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: { default: semantic.border, ':last-child': 'transparent' },
  },
  folderPath: { flexGrow: 1, overflowWrap: 'anywhere', minWidth: 0 },
  textButton: {
    paddingBlock: space.xs,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: 'transparent', ':hover': semantic.muted },
    color: semantic.destructiveForeground,
  },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: space.md,
    paddingBlock: space.section,
    paddingInline: space.xl,
    textAlign: 'center',
    backgroundColor: semantic.card,
    borderWidth: '1px',
    borderStyle: 'dashed',
    borderColor: semantic.input,
    borderRadius: radius.lg,
  },
})

interface Notice {
  title: string
  detail?: string
  action?: { label: string; run: () => void }
}

const unreachableNotice: Notice = { title: '无法保存默认设备', detail: '请重试。' }
const upgradeLabels: Record<NonNullable<Device['updateRequest']>['phase'], string> = {
  requested: '等待设备处理',
  downloading: '正在下载',
  verifying: '正在校验',
  draining: '等待工作结束',
  ready: '准备就绪',
  migrating: '正在迁移',
  syncing: '正在同步',
  completed: '更新完成',
  cancelled: '已取消',
  failed: '更新失败',
}
const connectionProtocol = {
  'openai-responses': 'OpenAI Responses',
  'openai-completions': 'OpenAI Chat Completions',
  'anthropic-messages': 'Anthropic Messages',
} as const
function connectionHost(value: string) {
  try {
    return new URL(value).host
  } catch {
    return value
  }
}

// 操作后的提示。移除默认设备后要等用户选出替代设备，替代设备按当前列表现算。
type Feedback = { kind: 'notice'; notice: Notice } | { kind: 'chooseDefault'; removed: string }

type PermissionState = { deviceId: ID; phase: 'saving' | 'saved' | 'failed'; enabled: boolean }

type Disconnect = { device: Device; wasDefault: boolean; phase: 'confirm' | 'pending' | 'failed' }

function DeviceRow({
  device,
  isDefault,
  open,
  status,
  onToggle,
}: {
  device: Device
  isDefault: boolean
  open: boolean
  status: { tone: Parameters<typeof StatusDot>[0]['tone']; label: string }
  onToggle: () => void
}) {
  const agents = agentSummary(device)
  return (
    <button
      type="button"
      id={`device-row-${device.id}`}
      aria-expanded={open}
      aria-controls={`device-${device.id}`}
      onClick={onToggle}
      {...stylex.props(styles.row, open && styles.rowOpen, focusRing.ring)}
    >
      <span {...stylex.props(styles.tile)}>
        <Icon name="laptop" size={16} />
      </span>
      <span {...stylex.props(styles.identity)}>
        <span {...stylex.props(styles.nameLine)}>
          <span {...stylex.props(text.label, text.truncate)}>{device.name}</span>
          {isDefault && <span {...stylex.props(text.caption, text.faint)}>默认</span>}
        </span>
        <span
          title={`${device.system} · Baton ${device.batondVersion}`}
          {...stylex.props(text.caption, text.muted, text.truncate)}
        >
          {systemName(device.system)}
        </span>
      </span>
      <span {...stylex.props(styles.status, text.caption, status.tone === 'agent' ? styles.agentStatus : text.muted)}>
        <StatusDot tone={status.tone} />
        <span {...stylex.props(text.truncate)}>{status.label}</span>
      </span>
      <span {...stylex.props(text.caption, text.truncate, agents.attention ? styles.attention : text.muted)}>
        {agents.label}
      </span>
      <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} style={styles.chevron} />
    </button>
  )
}

function CommandPermission({
  state,
  enabled,
  onChange,
}: {
  state: PermissionState | undefined
  enabled: boolean
  onChange: (enabled: boolean) => void
}) {
  let line: { text: string; warning?: boolean } | null = null
  if (state?.phase === 'saving') line = { text: '正在保存命令权限…' }
  else if (state?.phase === 'saved') line = { text: '已保存' }
  else if (state?.phase === 'failed') {
    line = {
      warning: true,
      text: state.enabled ? '保存失败，命令执行仍处于关闭状态。' : '保存失败，命令执行仍处于允许状态。',
    }
  }
  return (
    <section aria-label="命令权限" {...stylex.props(styles.permission)}>
      <div {...stylex.props(styles.permissionText)}>
        <span {...stylex.props(text.label)}>允许项目助手运行命令</span>
        <span {...stylex.props(text.caption, text.muted)}>项目助手自行运行的 Shell 命令。对话单独设置访问权限。</span>
        {line && (
          <span role="status" {...stylex.props(text.caption, line.warning ? styles.attention : text.muted)}>
            {line.text}
          </span>
        )}
      </div>
      <Toggle
        label="允许项目助手运行命令"
        checked={enabled}
        onChange={(next) => {
          if (state?.phase !== 'saving') onChange(next)
        }}
      />
    </section>
  )
}

function DeviceDetails({
  device,
  isDefault,
  savingDefault,
  permission,
  onPermission,
  onDefault,
  onFolders,
  onReconnect,
  onDisconnect,
}: {
  device: Device
  isDefault: boolean
  savingDefault: boolean
  permission: PermissionState | undefined
  onPermission: (enabled: boolean) => void
  onDefault: () => void
  onFolders: () => void
  onReconnect: () => void
  onDisconnect: () => void
}) {
  const [loginProvider, setLoginProvider] = useState<{ provider: string; localOnly: boolean } | null>(null)
  const now = useNow(30_000)
  const client = useClient()
  const [editing, setEditing] = useState<ModelConnection | 'new' | null>(null)
  const [logoutError, setLogoutError] = useState(false)
  const [updateState, setUpdateState] = useState<'idle' | 'sending' | 'accepted' | 'failed'>('idle')
  // 离线或同步中的设备只显示操作，Agent 信息要等设备同步完才准确。
  const connected = device.connection === 'online'
  // 一切正常时不列 Agent，只列需要处理的问题。
  const problems = connected ? capabilityLines(device).filter((line) => !line.ok) : []
  if (editing)
    return (
      <div {...stylex.props(styles.details)}>
        <ModelConnectionEditor
          device={device}
          initial={editing === 'new' ? undefined : editing}
          onBack={() => setEditing(null)}
        />
      </div>
    )
  return (
    <div id={`device-${device.id}`} {...stylex.props(styles.details)}>
      <LocalDeviceDiagnostics nodeId={device.id} />
      <div {...stylex.props(styles.group)}>
        <span {...stylex.props(text.label)}>订阅</span>
        {device.subscriptions.map((sub) => (
          <div key={sub.provider} {...stylex.props(styles.sourceRow)}>
            <div {...stylex.props(styles.sourceInfo)}>
              <span {...stylex.props(text.small)}>{sub.provider}</span>
              <span {...stylex.props(text.caption, text.muted)}>{sub.signedIn ? '已登录' : '需要登录'}</span>
            </div>
            {connected && (
              <Menu
                align="end"
                trigger={
                  <Button small aria-label={`管理 ${sub.provider}`}>
                    管理…
                  </Button>
                }
              >
                {sub.loginMethods?.includes('oauth') && (
                  <MenuOption onSelect={() => setLoginProvider({ provider: sub.provider, localOnly: false })}>
                    {sub.signedIn ? '重新登录' : '登录'}
                  </MenuOption>
                )}
                {sub.signedIn && (
                  <MenuOption
                    onSelect={() => {
                      setLogoutError(false)
                      void client
                        .logoutSubscription({ deviceId: device.id, provider: sub.providerId ?? sub.provider })
                        .catch(() => setLogoutError(true))
                    }}
                  >
                    退出登录
                  </MenuOption>
                )}
              </Menu>
            )}
          </div>
        ))}
        {logoutError && (
          <p role="alert" {...stylex.props(text.small, styles.attention)}>
            无法退出登录，请重试。
          </p>
        )}
      </div>
      <div {...stylex.props(styles.group)}>
        <div {...stylex.props(styles.sourceHeading)}>
          <span {...stylex.props(text.label)}>API 连接</span>
          <Button small onClick={() => setEditing('new')}>
            添加连接
          </Button>
        </div>
        {(device.modelConnections ?? []).map((connection) => (
          <div key={connection.id} {...stylex.props(styles.sourceRow)}>
            <div {...stylex.props(styles.sourceInfo)}>
              <span {...stylex.props(text.small)}>{connection.name}</span>
              <span {...stylex.props(text.caption, text.muted)}>
                {connectionProtocol[connection.protocol]} · {connectionHost(connection.base_url)}
                {connection.keyNeeded ? ' · 需要密钥' : ''}
              </span>
            </div>
            <Button small aria-label={`编辑 ${connection.name}`} onClick={() => setEditing(connection)}>
              编辑
            </Button>
          </div>
        ))}
      </div>
      {loginProvider && (
        <SubscriptionLoginDialog
          device={device}
          provider={loginProvider.provider}
          localOnly={loginProvider.localOnly}
          onClose={() => setLoginProvider(null)}
        />
      )}
      {device.updateRequest && (
        <span {...stylex.props(text.small, text.muted)}>
          {device.upgradeState?.operationId === device.updateRequest.operationId &&
            `${device.upgradeState.targetVersion} · `}
          {upgradeLabels[device.updateRequest.phase]}
          {device.updateRequest.reason && ` · ${device.updateRequest.reason}`}
        </span>
      )}
      {!device.updateRequest && device.upgradeState && (
        <span {...stylex.props(text.small, text.muted)}>
          {device.upgradeState.targetVersion} · {upgradeLabels[device.upgradeState.phase]}
        </span>
      )}
      {device.updateProtocol === 1 && device.updateManagementLastSeen !== undefined && (
        <span {...stylex.props(text.caption, text.muted)}>
          {now - device.updateManagementLastSeen < 60_000 ? '更新管理通道可用' : '更新管理通道未连接'}
        </span>
      )}
      {device.updateAvailability && (
        <span {...stylex.props(text.caption, text.muted)}>
          {device.updateAvailability.status === 'current'
            ? '已是最新版本'
            : `有新版本 ${device.updateAvailability.version}`}
          {' · 检查时间 '}
          {new Date(device.updateAvailability.checkedAt).toLocaleString('zh-CN')}
        </span>
      )}
      {updateState === 'accepted' && !device.updateRequest && <span role="status">更新请求已保存，等待设备处理。</span>}
      {updateState === 'failed' && <span role="alert">无法提交更新请求，请重试。</span>}
      {device.credentialState === 'idle_expired' && (
        <span {...stylex.props(text.small, styles.attention)}>需要登录</span>
      )}
      {device.connection === 'offline' && device.credentialState !== 'idle_expired' && (
        <span {...stylex.props(text.small, text.muted)}>新对话将等待设备就绪。</span>
      )}
      {problems.length > 0 && (
        <div {...stylex.props(styles.group)}>
          {problems.length > 0 && (
            <>
              <span {...stylex.props(text.caption, text.muted)}>助手与订阅</span>
              {problems.map((line) => (
                <span key={line.name} {...stylex.props(styles.capability)}>
                  <span {...stylex.props(text.small)}>{line.name}</span>
                  <span {...stylex.props(text.caption, styles.attention)}>{line.detail}</span>
                </span>
              ))}
            </>
          )}
        </div>
      )}
      {connected && device.hasRuntime && (
        <CommandPermission state={permission} enabled={device.commandAccess.enabled} onChange={onPermission} />
      )}
      <div {...stylex.props(styles.actions)}>
        {device.updateProtocol === 1 ? (
          <Button
            small
            disabled={updateState === 'sending'}
            onClick={() => {
              setUpdateState('sending')
              void client.updateDevice(device.id).then(
                () => setUpdateState('accepted'),
                () => setUpdateState('failed'),
              )
            }}
          >
            {updateState === 'sending' ? '正在提交…' : '更新设备'}
          </Button>
        ) : (
          <span {...stylex.props(text.caption, text.muted)}>请在设备上安装新版并完成一次本机初始化。</span>
        )}
        {device.credentialState === 'idle_expired' && (
          <Button small onClick={onReconnect}>
            重新连接设备
          </Button>
        )}
        {!isDefault && (
          <Button small onClick={onDefault}>
            {savingDefault ? '正在保存…' : '设为默认'}
          </Button>
        )}
        {device.connection !== 'offline' && (
          <Button small onClick={onFolders}>
            文件夹…
          </Button>
        )}
        <Button small variant="danger" style={styles.disconnect} onClick={onDisconnect}>
          断开设备
        </Button>
      </div>
    </div>
  )
}

function NoticeBox({ notice, children }: { notice: Notice; children?: ReactNode }) {
  return (
    <div role="status" {...stylex.props(styles.notice)}>
      <span {...stylex.props(text.label)}>{notice.title}</span>
      {notice.detail && <span {...stylex.props(text.small, text.muted)}>{notice.detail}</span>}
      {(notice.action || children) && (
        <div {...stylex.props(styles.noticeActions)}>
          {notice.action && (
            <Button small onClick={notice.action.run}>
              {notice.action.label}
            </Button>
          )}
          {children}
        </div>
      )}
    </div>
  )
}

export function DevicesPage() {
  const devices = useDevices()
  const downloads = useDownloads()
  const desktop = useDesktopStatus()
  const inDesktop = desktop.bridge !== null
  const projects = useProjects()
  const session = useSession()
  const setDefault = useSetDefaultDevice()
  const setCommandAccess = useSetCommandAccess()
  const removeDevice = useRemoveDevice()
  const search = useSearch({ from: '/workspace/devices' })
  const navigate = useNavigate()

  const expanded = search.device ?? null
  const setExpanded = (device: ID | null) => {
    void navigate({ to: '/devices', search: { ...search, device: device ?? undefined }, replace: true })
  }
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const notify = (notice: Notice) => setFeedback({ kind: 'notice', notice })
  // 首页的「Connect a device」带 connect 参数打开这里，直接弹出接入窗口。
  const [enrolling, setEnrolling] = useState<Device | true | null>(() => (search.connect ? true : null))
  const [disconnect, setDisconnect] = useState<Disconnect | null>(null)
  const [permission, setPermission] = useState<PermissionState | null>(null)
  // 打开命令权限前先确认；关闭直接保存。
  const [allowing, setAllowing] = useState<Device | null>(null)
  const [offlineDefault, setOfflineDefault] = useState<Device | null>(null)
  const [folders, setFolders] = useState<Device | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const removed = useRef(false)

  useEffect(() => {
    if (search.connect) void navigate({ to: '/devices', search: {}, replace: true })
  }, [search.connect, navigate])

  const list = devices.data ?? []
  const local = desktop.data
  const localReauth = local && needsDesktopReauth(local, list)
  const connectLabel = inDesktop
    ? local && (!local.registered || localReauth)
      ? local.registered
        ? '重新连接此电脑'
        : '连接此电脑'
      : null
    : '连接设备'
  const defaultId = session.data?.defaultDeviceId ?? null
  // 最后联系时间按分钟显示，每分钟刷新一次。
  const now = useNow(60_000)

  // 默认标签原地移动，不再另给提示。
  const saveDefault = (device: Device) => {
    setFeedback(null)
    setDefault.mutate(device.id, { onError: () => notify(unreachableNotice) })
  }

  const chooseDefault = (device: Device) => {
    if (device.id === defaultId || setDefault.isPending) return
    if (device.connection === 'offline') setOfflineDefault(device)
    else saveDefault(device)
  }

  const savePermission = (device: Device, enabled: boolean) => {
    setPermission({ deviceId: device.id, phase: 'saving', enabled })
    setCommandAccess.mutate(
      { deviceId: device.id, enabled },
      {
        onSuccess: () => setPermission({ deviceId: device.id, phase: 'saved', enabled }),
        onError: () => setPermission({ deviceId: device.id, phase: 'failed', enabled }),
      },
    )
  }

  const changePermission = (device: Device, enabled: boolean) => {
    if (enabled) setAllowing(device)
    else savePermission(device, false)
  }

  const startDisconnect = (device: Device) => {
    removed.current = false
    setDisconnect({ device, wasDefault: device.id === defaultId, phase: 'confirm' })
  }

  const confirmDisconnect = () => {
    if (!disconnect) return
    const { device, wasDefault } = disconnect
    setDisconnect({ ...disconnect, phase: 'pending' })
    removeDevice.mutate(device.id, {
      onSuccess: () => {
        removed.current = true
        setExpanded(null)
        setPermission(null)
        setDisconnect(null)
        if (wasDefault) setFeedback({ kind: 'chooseDefault', removed: device.name })
        else notify({ title: `${device.name} 已断开连接`, detail: '此设备上的助手可能仍在本机运行。' })
      },
      onError: () => setDisconnect({ device, wasDefault, phase: 'failed' }),
    })
  }

  // 默认设备被移除后，提示里给出替代设备：优先在线的，没有就用第一台。已在别处选好默认设备时不再提示。
  let shownFeedback: Notice | null = null
  if (feedback?.kind === 'notice') shownFeedback = feedback.notice
  else if (feedback?.kind === 'chooseDefault' && !defaultId) {
    const replacement = list.find((item) => item.connection === 'online') ?? list[0]
    shownFeedback = {
      title: '选择新的默认设备',
      action: replacement && {
        label: `将 ${replacement.name} 设为默认`,
        run: () => saveDefault(replacement),
      },
    }
  }

  let body
  if (devices.isPending) {
    body = <p {...stylex.props(text.small, text.muted)}>正在加载设备…</p>
  } else if (devices.isError && (!devices.data || isAccessError(devices.error))) {
    body = (
      <NoticeBox notice={{ title: '无法加载设备' }}>
        <Button small icon="refresh" onClick={() => void devices.refetch()}>
          重试
        </Button>
      </NoticeBox>
    )
  } else if (list.length === 0) {
    body = (
      <div {...stylex.props(styles.empty)}>
        <span {...stylex.props(text.heading)}>暂无设备</span>
        {connectLabel && (
          <Button variant="primary" icon="plus" onClick={() => setEnrolling(true)}>
            {connectLabel}
          </Button>
        )}
      </div>
    )
  } else {
    body = (
      <div {...stylex.props(styles.list)}>
        {list.map((device) => {
          const open = device.id === expanded
          return (
            <div key={device.id} {...stylex.props(styles.item)}>
              <DeviceRow
                device={device}
                isDefault={device.id === defaultId}
                open={open}
                status={deviceConnectionView(device, projects.data ?? [], now)}
                onToggle={() => setExpanded(open ? null : device.id)}
              />
              {open && (
                <DeviceDetails
                  device={device}
                  isDefault={device.id === defaultId}
                  savingDefault={setDefault.isPending && setDefault.variables === device.id}
                  permission={permission?.deviceId === device.id ? permission : undefined}
                  onPermission={(enabled) => changePermission(device, enabled)}
                  onDefault={() => chooseDefault(device)}
                  onFolders={() => setFolders(device)}
                  onReconnect={() => setEnrolling(device)}
                  onDisconnect={() => startDisconnect(device)}
                />
              )}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <Page
      title="设备"
      status={devices.isError && devices.data ? <SyncStatus retry={() => void devices.refetch()} /> : undefined}
    >
      <div {...stylex.props(styles.column)}>
        <div {...stylex.props(styles.intro)}>
          <h2 ref={headingRef} tabIndex={-1} {...stylex.props(text.title, styles.heading)}>
            {devicesHeading(list)}
          </h2>
          {!inDesktop && downloads.data?.enabled && downloads.data.connect_url && (
            <a href={downloads.data.connect_url} {...stylex.props(text.small, styles.desktopLink, focusRing.ring)}>
              在桌面客户端打开
            </a>
          )}
          {list.length > 0 && connectLabel && (
            <Button icon="plus" onClick={() => setEnrolling(true)}>
              {connectLabel}
            </Button>
          )}
        </div>
        {inDesktop && !enrolling && (
          <section aria-label="此电脑" {...stylex.props(styles.group)}>
            <span role="status" {...stylex.props(text.small, text.muted, styles.status)}>
              <StatusDot
                tone={local?.state === 'online' ? 'success' : local?.state === 'rejected' ? 'attention' : 'hollow'}
              />
              此电脑 · {local ? desktopStatusLabel(local) : '正在检查…'}
            </span>
            {local && desktopStatusReason(local) && (
              <p {...stylex.props(text.small, text.muted)}>{desktopStatusReason(local)}</p>
            )}
            {desktop.isError && (
              <>
                <p role="alert" {...stylex.props(text.small, text.muted)}>
                  无法读取此电脑的状态。
                </p>
                <Button small onClick={() => void desktop.refetch()}>
                  重试
                </Button>
              </>
            )}
          </section>
        )}
        {shownFeedback && <NoticeBox notice={shownFeedback} />}
        {body}
      </div>

      {enrolling && (
        <EnrollDialog
          device={enrolling === true ? undefined : enrolling}
          onClose={() => setEnrolling(null)}
          // 空列表里的接入按钮在设备连上后就不在了，焦点回到标题。
          finalFocus={() => headingRef.current}
        />
      )}

      {folders && <FoldersDialog device={folders} onClose={() => setFolders(null)} />}

      <Dialog
        open={allowing !== null}
        onOpenChange={(open) => {
          if (!open) setAllowing(null)
        }}
        title={`允许项目助手在 ${allowing?.name ?? ''} 上运行命令？`}
        description={`命令以 ${allowing?.commandAccess.user || '当前用户'} 的身份直接运行，可以访问所选文件夹以外的文件。`}
        actions={
          <>
            <Button onClick={() => setAllowing(null)}>取消</Button>
            <Button
              variant="primary"
              onClick={() => {
                if (allowing) savePermission(allowing, true)
                setAllowing(null)
              }}
            >
              允许执行命令
            </Button>
          </>
        }
      />

      <Dialog
        open={offlineDefault !== null}
        onOpenChange={(open) => {
          if (!open) setOfflineDefault(null)
        }}
        title={`将 ${offlineDefault?.name ?? ''} 设为默认？`}
        description="设备已离线，在此设备上新建的对话将在设备上线后开始。"
        actions={
          <>
            <Button onClick={() => setOfflineDefault(null)}>取消</Button>
            <Button
              variant="primary"
              onClick={() => {
                if (offlineDefault) saveDefault(offlineDefault)
                setOfflineDefault(null)
              }}
            >
              保存默认设备
            </Button>
          </>
        }
      />

      <DisconnectDialog
        state={disconnect}
        onCancel={() => setDisconnect(null)}
        onConfirm={confirmDisconnect}
        finalFocus={() => (removed.current ? headingRef.current : true)}
      />
    </Page>
  )
}

// 设备上已添加的文件夹。新文件夹在新建 Thread 的文件夹选择里添加；移除后新对话和文件预览不再能用它，已在运行的对话不受影响。
function FoldersDialog({ device, onClose }: { device: Device; onClose: () => void }) {
  const folders = useDeviceFolders(device.id, device.connection === 'online')
  const remove = useRemoveDeviceFolder()
  let body: ReactNode
  if (device.connection !== 'online') {
    body = <p {...stylex.props(text.small, text.muted)}>{device.name} 上线后可查看文件夹。</p>
  } else if (folders.isPending) {
    body = <p {...stylex.props(text.small, text.muted)}>正在加载文件夹…</p>
  } else if (folders.isError) {
    body = (
      <div {...stylex.props(styles.group)}>
        <p role="alert" {...stylex.props(text.small, styles.attention)}>
          无法加载文件夹。
        </p>
        <Button small onClick={() => void folders.refetch()}>
          重试
        </Button>
      </div>
    )
  } else if (folders.data.length === 0) {
    body = <p {...stylex.props(text.small, text.muted)}>暂无文件夹，可在开始对话时添加。</p>
  } else {
    body = (
      <div {...stylex.props(styles.folders)}>
        {folders.data.map((folder) => (
          <div key={folder} {...stylex.props(styles.folder)}>
            <span {...stylex.props(text.mono, styles.folderPath)}>{folder}</span>
            <button
              type="button"
              aria-label={`移除 ${folder}`}
              aria-disabled={remove.isPending || undefined}
              onClick={() => {
                if (!remove.isPending)
                  remove.mutate({ deviceId: device.id, path: folder }, { onSuccess: () => void folders.refetch() })
              }}
              {...stylex.props(text.small, styles.textButton, focusRing.ring)}
            >
              移除
            </button>
          </div>
        ))}
        {remove.isError && (
          <p role="alert" {...stylex.props(text.caption, styles.attention)}>
            无法移除文件夹，请重试。
          </p>
        )}
      </div>
    )
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={`${device.name} 上的文件夹`}
      actions={<Button onClick={onClose}>完成</Button>}
    >
      {body}
    </Dialog>
  )
}

function DisconnectDialog({
  state,
  onCancel,
  onConfirm,
  finalFocus,
}: {
  state: Disconnect | null
  onCancel: () => void
  onConfirm: () => void
  finalFocus: () => HTMLElement | null | boolean
}) {
  const name = state?.device.name ?? ''
  let title = `断开“${name}”？`
  let description = state?.wasDefault
    ? '请重新选择默认设备。已运行的助手会继续在本机运行。'
    : '已运行的助手会继续在本机运行。'
  let actions = (
    <>
      <Button onClick={onCancel}>取消</Button>
      <Button variant="dangerSolid" onClick={onConfirm}>
        断开设备
      </Button>
    </>
  )
  if (state?.phase === 'pending') {
    title = `正在断开 ${name}…`
    actions = <Button variant="dangerSolid">正在断开…</Button>
  } else if (state?.phase === 'failed') {
    title = '无法确认是否已断开'
    description = `${name} 可能仍处于连接状态。`
    actions = (
      <>
        <Button onClick={onCancel}>取消</Button>
        <Button variant="dangerSolid" onClick={onConfirm}>
          重试
        </Button>
      </>
    )
  }
  return (
    <Dialog
      open={state !== null}
      onOpenChange={(open) => {
        if (!open && state?.phase !== 'pending') onCancel()
      }}
      title={title}
      description={description}
      actions={actions}
      finalFocus={finalFocus}
    />
  )
}
