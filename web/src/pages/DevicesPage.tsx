import * as stylex from '@stylexjs/stylex'
import { isAccessError } from '../data/client'
import { SyncStatus } from '../app/SyncStatus'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { DeviceAgentsDialog } from '../app/DeviceAgentsDialog'
import { EnrollDialog } from '../app/EnrollDialog'
import { LocalDeviceDiagnostics } from '../app/LocalDeviceDiagnostics'
import { ProjectAssistantDialog, type PermissionState } from '../app/ProjectAssistantDialog'
import { Page } from '../app/Page'
import { useNow } from '../app/useNow'
import {
  agentSummary,
  codingAgentsSummary,
  deviceConnectionView,
  devicesHeading,
  projectAssistantSummary,
  systemName,
} from '../data/derive'
import {
  useDevices,
  useClient,
  useDownloads,
  useProjects,
  useRemoveDevice,
  useSession,
  useSetCommandAccess,
  useSetDefaultDevice,
} from '../data/queries'
import type { Device, ID } from '../data/types'
import { desktopStatusLabel, desktopStatusReason, needsDesktopReauth, useDesktopStatus } from '../data/desktop'
import { text } from '../theme/text'
import { semantic } from '../theme/semantic.stylex'
import { radius, space } from '../theme/tokens.stylex'
import { Button, focusRing } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Icon } from '../ui/Icon'
import { StatusDot } from '../ui/Status'
import { Tooltip } from '../ui/Tooltip'

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
  summaries: {
    display: 'grid',
    gridTemplateColumns: '76px minmax(0, 1fr)',
    gap: '8px 16px',
    alignItems: 'baseline',
  },
  summaryLabel: { color: semantic.mutedForeground },
  actions: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: space.sm },
  disconnect: { marginInlineStart: 'auto' },
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
// 已结束且没有问题的更新不显示。
const upgradeLabels: Partial<Record<NonNullable<Device['updateRequest']>['phase'], string>> = {
  requested: '等待设备更新',
  downloading: '正在下载',
  verifying: '正在校验',
  draining: '等待工作结束',
  ready: '准备就绪',
  migrating: '正在迁移',
  syncing: '正在同步',
  failed: '更新失败',
}
// 操作后的提示。移除默认设备后要等用户选出替代设备，替代设备按当前列表现算。
type Feedback = { kind: 'notice'; notice: Notice } | { kind: 'chooseDefault'; removed: string }

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
        <Tooltip label={`${device.system} · Baton ${device.batondVersion}`} align="start">
          <span {...stylex.props(text.caption, text.muted, text.truncate)}>{systemName(device.system)}</span>
        </Tooltip>
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

function DeviceDetails({
  device,
  isDefault,
  savingDefault,
  onAgents,
  onAssistant,
  onDefault,
  onReconnect,
  onDisconnect,
}: {
  device: Device
  isDefault: boolean
  savingDefault: boolean
  onAgents: () => void
  onAssistant: () => void
  onDefault: () => void
  onReconnect: () => void
  onDisconnect: () => void
}) {
  const client = useClient()
  const [updateState, setUpdateState] = useState<'idle' | 'sending' | 'accepted' | 'failed'>('idle')
  // 离线或同步中的设备只显示操作，Agent 信息要等设备同步完才准确。
  const connected = device.connection === 'online'
  const assistant = connected ? projectAssistantSummary(device) : null
  const coding = connected ? codingAgentsSummary(device) : null
  const upgrade = device.updateRequest ?? device.upgradeState
  const upgradeLabel = upgrade && upgradeLabels[upgrade.phase]
  const availableVersion = device.updateAvailability?.status === 'available' ? device.updateAvailability : null

  return (
    <div id={`device-${device.id}`} {...stylex.props(styles.details)}>
      <LocalDeviceDiagnostics nodeId={device.id} />
      {connected && assistant && coding && (
        <div {...stylex.props(styles.summaries)}>
          <span {...stylex.props(text.caption, styles.summaryLabel)}>项目助手</span>
          <span {...stylex.props(text.small, assistant.attention ? styles.attention : text.muted)}>
            {assistant.text}
          </span>
          <span {...stylex.props(text.caption, styles.summaryLabel)}>编码 Agent</span>
          <span {...stylex.props(text.small, coding.attention ? styles.attention : text.muted)}>{coding.text}</span>
        </div>
      )}
      {upgradeLabel && (
        <span {...stylex.props(text.small, text.muted)}>
          {device.upgradeState?.operationId === upgrade.operationId && `${device.upgradeState.targetVersion} · `}
          {upgradeLabel}
          {device.updateRequest?.reason && ` · ${device.updateRequest.reason}`}
        </span>
      )}
      {updateState === 'accepted' && !device.updateRequest && <span role="status">等待设备更新</span>}
      {updateState === 'failed' && <span role="alert">无法更新，请重试。</span>}
      {device.credentialState === 'idle_expired' && (
        <span {...stylex.props(text.small, styles.attention)}>需要登录</span>
      )}
      {device.connection === 'offline' && device.credentialState !== 'idle_expired' && (
        <span {...stylex.props(text.small, text.muted)}>新对话将等待设备就绪。</span>
      )}
      <div {...stylex.props(styles.actions)}>
        {connected && (
          <>
            <Button small onClick={onAgents}>
              编码 Agent
            </Button>
            <Button small onClick={onAssistant}>
              项目助手
            </Button>
          </>
        )}
        {device.updateProtocol === 1 && device.updateAvailability?.status !== 'current' && (
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
            {updateState === 'sending'
              ? '正在提交…'
              : availableVersion
                ? `更新到 ${availableVersion.version}`
                : '更新设备'}
          </Button>
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
  const [offlineDefault, setOfflineDefault] = useState<Device | null>(null)
  const [agentsDeviceId, setAgentsDeviceId] = useState<ID | null>(null)
  const [assistantDeviceId, setAssistantDeviceId] = useState<ID | null>(null)
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
                  onAgents={() => setAgentsDeviceId(device.id)}
                  onAssistant={() => setAssistantDeviceId(device.id)}
                  onDefault={() => chooseDefault(device)}
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

      {(() => {
        const agentsDevice = agentsDeviceId ? list.find((item) => item.id === agentsDeviceId) : null
        return agentsDevice ? (
          <DeviceAgentsDialog device={agentsDevice} onClose={() => setAgentsDeviceId(null)} />
        ) : null
      })()}

      {(() => {
        const assistantDevice = assistantDeviceId ? list.find((item) => item.id === assistantDeviceId) : null
        return assistantDevice ? (
          <ProjectAssistantDialog
            device={assistantDevice}
            permission={permission?.deviceId === assistantDevice.id ? permission : undefined}
            onSavePermission={(enabled) => savePermission(assistantDevice, enabled)}
            onClose={() => setAssistantDeviceId(null)}
          />
        ) : null
      })()}

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
