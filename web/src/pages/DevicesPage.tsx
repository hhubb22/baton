import * as stylex from '@stylexjs/stylex'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { EnrollDialog } from '../app/EnrollDialog'
import { LocalDeviceDiagnostics } from '../app/LocalDeviceDiagnostics'
import { SubscriptionLoginDialog } from '../app/SubscriptionLoginDialog'
import { Page } from '../app/Page'
import { useNow } from '../app/useNow'
import { agentSummary, capabilityLines, deviceConnectionView, devicesHeading, systemName } from '../data/derive'
import {
  useDevices,
  useDownloads,
  useDeviceFolders,
  useProjects,
  useRemoveDevice,
  useRemoveDeviceFolder,
  useSession,
  useSetCommandAccess,
  useSetDefaultDevice,
} from '../data/queries'
import type { Device, ID } from '../data/types'
import { desktopStatusLabel, desktopStatusReason, needsDesktopReauth, useDesktopStatus } from '../data/desktop'
import { text } from '../theme/text'
import { colors, radius, space } from '../theme/tokens.stylex'
import { Button, focusRing } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Icon } from '../ui/Icon'
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
  desktopLink: { color: colors.accentText, whiteSpace: 'nowrap' },
  notice: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.sm,
    paddingBlock: '14px',
    paddingInline: space.lg,
    backgroundColor: colors.panel,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSoft,
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
    borderTopColor: colors.borderSoft,
  },
  item: {
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSoft,
  },
  rowOpen: { backgroundColor: { default: colors.selected, ':hover': colors.selected } },
  row: {
    display: 'grid',
    gridTemplateColumns: '32px minmax(0, 1fr) 200px 170px 16px',
    alignItems: 'center',
    gap: space.md,
    width: '100%',
    paddingBlock: space.md,
    paddingInline: space.lg,
    borderWidth: 0,
    backgroundColor: { default: 'transparent', ':hover': colors.hover },
    color: colors.text,
    textAlign: 'left',
  },
  tile: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '32px',
    height: '32px',
    color: colors.muted,
  },
  identity: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  nameLine: { display: 'flex', alignItems: 'center', gap: space.sm, minWidth: 0 },
  status: { display: 'flex', alignItems: 'center', gap: space.sm, minWidth: 0 },
  agentStatus: { color: colors.agentText },
  attention: { color: colors.attentionText },
  chevron: { color: colors.faint },
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
    borderBottomColor: { default: colors.borderSoft, ':last-child': 'transparent' },
  },
  folderPath: { flexGrow: 1, overflowWrap: 'anywhere', minWidth: 0 },
  textButton: {
    paddingBlock: space.xs,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: 'transparent', ':hover': colors.hover },
    color: colors.danger,
  },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: space.md,
    paddingBlock: space.section,
    paddingInline: space.xl,
    textAlign: 'center',
    backgroundColor: colors.surface,
    borderWidth: '1px',
    borderStyle: 'dashed',
    borderColor: colors.border,
    borderRadius: radius.lg,
  },
})

interface Notice {
  title: string
  detail?: string
  action?: { label: string; run: () => void }
}

const unreachableNotice: Notice = { title: "Couldn't save the default device", detail: 'Try again.' }

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
          {isDefault && <span {...stylex.props(text.caption, text.faint)}>Default</span>}
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
  if (state?.phase === 'saving') line = { text: 'Saving command permission…' }
  else if (state?.phase === 'saved') line = { text: 'Saved' }
  else if (state?.phase === 'failed') {
    line = {
      warning: true,
      text: state.enabled ? "Couldn't save. Commands are still off." : "Couldn't save. Commands are still allowed.",
    }
  }
  return (
    <section aria-label="Command permission" {...stylex.props(styles.permission)}>
      <div {...stylex.props(styles.permissionText)}>
        <span {...stylex.props(text.label)}>Allow project assistant to run commands</span>
        <span {...stylex.props(text.caption, text.muted)}>
          Shell commands the project assistant runs itself. Threads set their own access.
        </span>
        {line && (
          <span role="status" {...stylex.props(text.caption, line.warning ? styles.attention : text.muted)}>
            {line.text}
          </span>
        )}
      </div>
      <Toggle
        label="Allow project assistant to run commands"
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
  // 离线或同步中的设备只显示操作，Agent 信息要等设备同步完才准确。
  const connected = device.connection === 'online'
  // 一切正常时不列 Agent，只列需要处理的问题。
  const problems = connected ? capabilityLines(device).filter((line) => !line.ok) : []
  const logins = connected && device.hasRuntime ? device.subscriptions : []
  const loginButtons = logins.flatMap((sub) => {
    const buttons: ReactNode[] = []
    if (sub.status === 'login_required' || (!sub.status && !sub.signedIn))
      buttons.push(
        <Button
          key={`${sub.provider}-login`}
          small
          onClick={() => setLoginProvider({ provider: sub.provider, localOnly: false })}
        >
          {sub.loginMethods?.includes('device_code') ? 'Sign in to' : 'Set up'} {sub.provider}
        </Button>,
      )
    if (sub.loginMethods?.includes('api_key') && (sub.signedIn || sub.loginMethods.includes('device_code')))
      buttons.push(
        <Button
          key={`${sub.provider}-key`}
          small
          onClick={() => setLoginProvider({ provider: sub.provider, localOnly: true })}
        >
          Use API key for {sub.provider}
        </Button>,
      )
    return buttons
  })
  return (
    <div id={`device-${device.id}`} {...stylex.props(styles.details)}>
      <LocalDeviceDiagnostics nodeId={device.id} />
      {loginProvider && (
        <SubscriptionLoginDialog
          device={device}
          provider={loginProvider.provider}
          localOnly={loginProvider.localOnly}
          onClose={() => setLoginProvider(null)}
        />
      )}
      {device.upgradeState?.phase === 'failed' && (
        <span {...stylex.props(text.small, text.muted)}>Waiting for the upgrade to be cancelled.</span>
      )}
      {device.credentialState === 'idle_expired' && (
        <span {...stylex.props(text.small, styles.attention)}>Needs sign-in</span>
      )}
      {device.connection === 'offline' && device.credentialState !== 'idle_expired' && (
        <span {...stylex.props(text.small, text.muted)}>New threads wait for it.</span>
      )}
      {(problems.length > 0 || loginButtons.length > 0) && (
        <div {...stylex.props(styles.group)}>
          {problems.length > 0 && (
            <>
              <span {...stylex.props(text.caption, text.muted)}>Agents & subscriptions</span>
              {problems.map((line) => (
                <span key={line.name} {...stylex.props(styles.capability)}>
                  <span {...stylex.props(text.small)}>{line.name}</span>
                  <span {...stylex.props(text.caption, styles.attention)}>{line.detail}</span>
                </span>
              ))}
            </>
          )}
          {loginButtons.length > 0 && <div {...stylex.props(styles.logins)}>{loginButtons}</div>}
        </div>
      )}
      {connected && device.hasRuntime && (
        <CommandPermission state={permission} enabled={device.commandAccess.enabled} onChange={onPermission} />
      )}
      <div {...stylex.props(styles.actions)}>
        {device.credentialState === 'idle_expired' && (
          <Button small onClick={onReconnect}>
            Reconnect device
          </Button>
        )}
        {!isDefault && (
          <Button small onClick={onDefault}>
            {savingDefault ? 'Saving…' : 'Set as default'}
          </Button>
        )}
        {device.connection !== 'offline' && (
          <Button small onClick={onFolders}>
            Folders…
          </Button>
        )}
        <Button small variant="danger" style={styles.disconnect} onClick={onDisconnect}>
          Disconnect device
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
        ? 'Reconnect this computer'
        : 'Connect this computer'
      : null
    : 'Connect a device'
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
        else notify({ title: `${device.name} disconnected`, detail: 'Its agents may still be running locally.' })
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
      title: 'Choose a new default device',
      action: replacement && {
        label: `Set ${replacement.name} as default`,
        run: () => saveDefault(replacement),
      },
    }
  }

  let body
  if (devices.isPending) {
    body = <p {...stylex.props(text.small, text.muted)}>Loading devices…</p>
  } else if (devices.isError) {
    body = (
      <NoticeBox notice={{ title: "Couldn't load devices" }}>
        <Button small icon="refresh" onClick={() => void devices.refetch()}>
          Try again
        </Button>
      </NoticeBox>
    )
  } else if (list.length === 0) {
    body = (
      <div {...stylex.props(styles.empty)}>
        <span {...stylex.props(text.heading)}>No devices yet</span>
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
    <Page title="Devices">
      <div {...stylex.props(styles.column)}>
        <div {...stylex.props(styles.intro)}>
          <h2 ref={headingRef} tabIndex={-1} {...stylex.props(text.title, styles.heading)}>
            {devicesHeading(list)}
          </h2>
          {!inDesktop && downloads.data?.enabled && downloads.data.connect_url && (
            <a href={downloads.data.connect_url} {...stylex.props(text.small, styles.desktopLink, focusRing.ring)}>
              Open in desktop app
            </a>
          )}
          {list.length > 0 && connectLabel && (
            <Button icon="plus" onClick={() => setEnrolling(true)}>
              {connectLabel}
            </Button>
          )}
        </div>
        {inDesktop && !enrolling && (
          <section aria-label="This computer" {...stylex.props(styles.group)}>
            <span role="status" {...stylex.props(text.small, text.muted, styles.status)}>
              <StatusDot
                tone={local?.state === 'online' ? 'success' : local?.state === 'rejected' ? 'attention' : 'hollow'}
              />
              This computer · {local ? desktopStatusLabel(local) : 'Checking…'}
            </span>
            {local && desktopStatusReason(local) && (
              <p {...stylex.props(text.small, text.muted)}>{desktopStatusReason(local)}</p>
            )}
            {desktop.isError && (
              <>
                <p role="alert" {...stylex.props(text.small, text.muted)}>
                  Couldn't read this computer's status.
                </p>
                <Button small onClick={() => void desktop.refetch()}>
                  Try again
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
        title={`Let the project assistant run commands on ${allowing?.name ?? ''}?`}
        description={`Commands run directly as ${allowing?.commandAccess.user || 'your user'} and can reach files outside your folders.`}
        actions={
          <>
            <Button onClick={() => setAllowing(null)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => {
                if (allowing) savePermission(allowing, true)
                setAllowing(null)
              }}
            >
              Allow commands
            </Button>
          </>
        }
      />

      <Dialog
        open={offlineDefault !== null}
        onOpenChange={(open) => {
          if (!open) setOfflineDefault(null)
        }}
        title={`Use ${offlineDefault?.name ?? ''} as default?`}
        description="It's offline. New threads on it wait until it's back."
        actions={
          <>
            <Button onClick={() => setOfflineDefault(null)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => {
                if (offlineDefault) saveDefault(offlineDefault)
                setOfflineDefault(null)
              }}
            >
              Save default device
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
    body = <p {...stylex.props(text.small, text.muted)}>Folders show when {device.name} is online.</p>
  } else if (folders.isPending) {
    body = <p {...stylex.props(text.small, text.muted)}>Loading folders…</p>
  } else if (folders.isError) {
    body = (
      <div {...stylex.props(styles.group)}>
        <p role="alert" {...stylex.props(text.small, styles.attention)}>
          Couldn't load folders.
        </p>
        <Button small onClick={() => void folders.refetch()}>
          Try again
        </Button>
      </div>
    )
  } else if (folders.data.length === 0) {
    body = <p {...stylex.props(text.small, text.muted)}>No folders yet. Add one when you start a thread.</p>
  } else {
    body = (
      <div {...stylex.props(styles.folders)}>
        {folders.data.map((folder) => (
          <div key={folder} {...stylex.props(styles.folder)}>
            <span {...stylex.props(text.mono, styles.folderPath)}>{folder}</span>
            <button
              type="button"
              aria-label={`Remove ${folder}`}
              aria-disabled={remove.isPending || undefined}
              onClick={() => {
                if (!remove.isPending)
                  remove.mutate({ deviceId: device.id, path: folder }, { onSuccess: () => void folders.refetch() })
              }}
              {...stylex.props(text.small, styles.textButton, focusRing.ring)}
            >
              Remove
            </button>
          </div>
        ))}
        {remove.isError && (
          <p role="alert" {...stylex.props(text.caption, styles.attention)}>
            Couldn't remove the folder. Try again.
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
      title={`Folders on ${device.name}`}
      actions={<Button onClick={onClose}>Done</Button>}
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
  let title = `Disconnect “${name}”?`
  let description = state?.wasDefault
    ? "You'll need to choose a new default. Agents already running on it keep running locally."
    : 'Agents already running on it keep running locally.'
  let actions = (
    <>
      <Button onClick={onCancel}>Cancel</Button>
      <Button variant="dangerSolid" onClick={onConfirm}>
        Disconnect device
      </Button>
    </>
  )
  if (state?.phase === 'pending') {
    title = `Disconnecting ${name}…`
    actions = <Button variant="dangerSolid">Disconnecting…</Button>
  } else if (state?.phase === 'failed') {
    title = "Couldn't confirm disconnection"
    description = `${name} may still be connected.`
    actions = (
      <>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="dangerSolid" onClick={onConfirm}>
          Try again
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
