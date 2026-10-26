import * as stylex from '@stylexjs/stylex'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { EnrollDialog } from '../app/EnrollDialog'
import { DeviceFolderForm } from '../app/DeviceFolderForm'
import { SubscriptionLoginDialog } from '../app/SubscriptionLoginDialog'
import { Page } from '../app/Page'
import { useNow } from '../app/useNow'
import {
  agentSummary,
  capabilityLines,
  deviceConnectionView,
  devicesHeading,
  lastSeen,
  modelLines,
  setupNeeded,
  setupSteps,
} from '../data/derive'
import {
  useDevices,
  useDeviceFolders,
  useProjects,
  useRemoveDevice,
  useRemoveDeviceFolder,
  useSession,
  useSetCommandAccess,
  useSetDefaultDevice,
} from '../data/queries'
import type { Device, ID } from '../data/types'
import { text } from '../theme/text'
import { colors, radius, space } from '../theme/tokens.stylex'
import { Button, IconButton, focusRing } from '../ui/Button'
import { Tag } from '../ui/Badge'
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
  intro: { display: 'flex', alignItems: 'flex-start', gap: space.xl },
  introText: { display: 'flex', flexDirection: 'column', gap: space.xs, flexGrow: 1 },
  heading: { outline: 'none' },
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
    paddingTop: space.md,
    paddingBottom: space.lg,
    paddingLeft: '60px',
    paddingRight: space.lg,
  },
  // 展开行里的设备提示：离线、同步中或需要补齐时显示在详情最上方。
  deviceNotice: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.xs,
    paddingBlock: space.md,
    paddingInline: space.lg,
    backgroundColor: colors.surface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSoft,
    borderRadius: radius.lg,
  },
  columns: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: space.xl },
  group: { display: 'flex', flexDirection: 'column', gap: space.sm, minWidth: 0 },
  folder: { display: 'flex', alignItems: 'center', gap: space.sm },
  folderPath: { flexGrow: 1, overflowWrap: 'anywhere', minWidth: 0 },
  capability: { display: 'flex', alignItems: 'baseline', gap: space.sm },
  ok: { color: colors.success, alignSelf: 'center' },
  problem: { color: colors.attention, alignSelf: 'center' },
  models: { display: 'flex', flexDirection: 'column' },
  permission: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.sm,
    paddingTop: space.lg,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.borderSoft,
  },
  permissionHead: { display: 'flex', alignItems: 'flex-start', gap: space.lg },
  permissionText: { display: 'flex', flexDirection: 'column', gap: space.xxs, flexGrow: 1 },
  risk: { display: 'flex', alignItems: 'center', gap: space.sm, color: colors.attentionText },
  actions: { display: 'flex', alignItems: 'center', gap: space.lg },
  textButton: {
    paddingBlock: space.xs,
    paddingInline: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: { default: colors.danger, ':hover': colors.text },
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
  detail: string
  action?: { label: string; run: () => void }
}

const unreachableNotice: Notice = {
  title: 'Could not save default device',
  detail: 'Baton could not be reached. Check your connection, then try again.',
}

// 操作后的提示。移除默认设备后要等用户选出替代设备，替代设备按当前列表现算。
type Feedback = { kind: 'notice'; notice: Notice } | { kind: 'chooseDefault'; removed: string }

type PermissionState = { deviceId: ID; phase: 'saving' | 'saved' | 'failed'; enabled: boolean }

type Disconnect = { device: Device; wasDefault: boolean; phase: 'confirm' | 'pending' | 'failed' }

function repoNames(device: Device) {
  return device.repos.map((path) => path.split(/[\\/]/).pop() ?? path)
}

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
          {isDefault && <Tag>Default device</Tag>}
        </span>
        <span {...stylex.props(text.caption, text.muted, text.truncate)}>
          {device.system} · batond {device.batondVersion}
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
  device,
  state,
  onChange,
}: {
  device: Device
  state: PermissionState | undefined
  onChange: (enabled: boolean) => void
}) {
  const { enabled, user, shell } = device.commandAccess
  let line: { text: string; warning?: boolean } | null = null
  if (state?.phase === 'saving') line = { text: 'Saving command permission…' }
  else if (state?.phase === 'saved') line = { text: `Saved · command permission is ${enabled ? 'on' : 'off'}` }
  else if (state?.phase === 'failed') {
    line = {
      warning: true,
      text: state.enabled
        ? 'Baton could not be reached. Command permission is still off. Click the switch to try again.'
        : 'Could not save because Baton could not be reached. Commands are still allowed. Click the switch to try again.',
    }
  }
  return (
    <section aria-label="Command permission" {...stylex.props(styles.permission)}>
      <div {...stylex.props(styles.permissionHead)}>
        <div {...stylex.props(styles.permissionText)}>
          <span {...stylex.props(text.label)}>Allow project assistant to run commands</span>
          <span {...stylex.props(text.caption, text.muted)}>
            {enabled
              ? `Lets the project assistant run shell commands in allowed folders as user “${user}” (${shell}). Commands can run for up to 2 hours.`
              : `Commands run as user “${user}” (${shell}) in allowed folders. Turn on only if you allow direct access without a sandbox.`}
          </span>
        </div>
        <Toggle
          label="Allow project assistant to run commands"
          checked={enabled}
          onChange={(next) => {
            if (state?.phase !== 'saving') onChange(next)
          }}
        />
      </div>
      <div {...stylex.props(styles.risk, text.caption)}>
        <Icon name="shield" size={14} />
        Commands run directly on {device.name} without a sandbox. Baton does not inspect them.
      </div>
      {line && (
        <span role="status" {...stylex.props(text.caption, line.warning ? styles.attention : text.muted)}>
          {line.text}
        </span>
      )}
    </section>
  )
}

function DeviceDetails({
  device,
  notice,
  isDefault,
  savingDefault,
  permission,
  onPermission,
  onDefault,
  onDisconnect,
}: {
  device: Device
  notice: Notice | null
  isDefault: boolean
  savingDefault: boolean
  permission: PermissionState | undefined
  onPermission: (enabled: boolean) => void
  onDefault: () => void
  onDisconnect: () => void
}) {
  const repos = repoNames(device)
  const removeFolder = useRemoveDeviceFolder()
  const [loginProvider, setLoginProvider] = useState<{ provider: string; localOnly: boolean } | null>(null)
  // 离线或同步中的设备只显示提示和操作，Agent 与文件夹信息要等设备同步完才准确。
  const connected = device.connection === 'online'
  const folders = useDeviceFolders(device.id, connected)
  let defaultLabel = 'Set as default'
  if (isDefault) defaultLabel = 'Default device'
  else if (savingDefault) defaultLabel = 'Saving…'
  return (
    <div id={`device-${device.id}`} {...stylex.props(styles.details)}>
      {loginProvider && (
        <SubscriptionLoginDialog
          device={device}
          provider={loginProvider.provider}
          localOnly={loginProvider.localOnly}
          onClose={() => setLoginProvider(null)}
        />
      )}
      {notice && (
        <div {...stylex.props(styles.deviceNotice)}>
          <span {...stylex.props(text.label)}>{notice.title}</span>
          <span {...stylex.props(text.small, text.muted)}>{notice.detail}</span>
        </div>
      )}
      {connected && (
        <div {...stylex.props(styles.columns)}>
          <div {...stylex.props(styles.group)}>
            <span {...stylex.props(text.caption, text.muted)}>Agents & subscriptions</span>
            {capabilityLines(device).map((line) => (
              <span key={line.name} {...stylex.props(styles.capability)}>
                <Icon name={line.ok ? 'check' : 'alert'} size={12} style={line.ok ? styles.ok : styles.problem} />
                <span {...stylex.props(text.small)}>{line.name}</span>
                <span {...stylex.props(text.caption, line.ok ? text.muted : styles.attention)}>{line.detail}</span>
              </span>
            ))}
            {device.hasRuntime &&
              device.subscriptions.map((sub) => (
                <span key={sub.provider}>
                  {(sub.status === 'login_required' || (!sub.status && !sub.signedIn)) && (
                    <Button small onClick={() => setLoginProvider({ provider: sub.provider, localOnly: false })}>
                      {sub.loginMethods?.includes('device_code') ? 'Sign in to' : 'Set up'} {sub.provider}
                    </Button>
                  )}
                  {sub.loginMethods?.includes('api_key') &&
                    (sub.signedIn || sub.loginMethods.includes('device_code')) && (
                      <Button small onClick={() => setLoginProvider({ provider: sub.provider, localOnly: true })}>
                        Use API key for {sub.provider}
                      </Button>
                    )}
                </span>
              ))}
            <span {...stylex.props(styles.models)}>
              {modelLines(device).map((line) => (
                <span key={line} {...stylex.props(text.caption, text.muted)}>
                  {line}
                </span>
              ))}
            </span>
          </div>
          <div {...stylex.props(styles.group)}>
            <span {...stylex.props(text.caption, text.muted)}>Allowed folders</span>
            {folders.isPending && <span {...stylex.props(text.small, text.muted)}>Loading folders…</span>}
            {folders.isError && (
              <>
                <p role="alert" {...stylex.props(text.caption, styles.attention)}>
                  Could not load allowed folders. Check the device connection, then try again.
                </p>
                <Button small onClick={() => void folders.refetch()}>
                  Try again
                </Button>
              </>
            )}
            {!folders.isError &&
              folders.data?.map((folder) => (
                <div key={folder} {...stylex.props(styles.folder)}>
                  <span {...stylex.props(text.mono, styles.folderPath)}>{folder}</span>
                  <IconButton
                    icon="close"
                    label={`Remove ${folder}`}
                    aria-disabled={removeFolder.isPending || undefined}
                    onClick={() => {
                      if (!removeFolder.isPending) removeFolder.mutate({ deviceId: device.id, path: folder })
                    }}
                  />
                </div>
              ))}
            {repos.length > 0 && (
              <span {...stylex.props(text.caption, text.muted)}>
                {repos.length} {repos.length === 1 ? 'repository' : 'repositories'} discovered: {repos.join(', ')}
              </span>
            )}
            <DeviceFolderForm deviceId={device.id} />
            {removeFolder.isError && (
              <p role="alert" {...stylex.props(text.caption, styles.attention)}>
                Could not remove folder. Check the device connection, then try again.
              </p>
            )}
          </div>
        </div>
      )}
      {connected && device.hasRuntime && (
        <CommandPermission device={device} state={permission} onChange={onPermission} />
      )}
      <div {...stylex.props(styles.actions)}>
        <Button small onClick={onDefault} aria-disabled={isDefault || undefined}>
          {defaultLabel}
        </Button>
        <button type="button" onClick={onDisconnect} {...stylex.props(text.small, styles.textButton, focusRing.ring)}>
          Disconnect device
        </button>
      </div>
    </div>
  )
}

function deviceNotice(device: Device, now: number): Notice | null {
  if (device.connection === 'offline') {
    return {
      title: `${device.name} is offline`,
      detail: `Last contact at ${lastSeen(device.lastSeenAt, now)}. New chats on ${device.name} wait for it to reconnect. Wake ${device.name} and reconnect it to the network.`,
    }
  }
  if (device.connection === 'syncing') {
    return {
      title: `${device.name} is syncing`,
      detail: 'Connected just now. Chats will wait until device information is up to date.',
    }
  }
  if (setupNeeded(device)) return { title: `Finish setup on ${device.name}`, detail: setupSteps(device) }
  return null
}

function NoticeBox({ notice, children }: { notice: Notice; children?: ReactNode }) {
  return (
    <div role="status" {...stylex.props(styles.notice)}>
      <span {...stylex.props(text.label)}>{notice.title}</span>
      <span {...stylex.props(text.small, text.muted)}>{notice.detail}</span>
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
  const projects = useProjects()
  const session = useSession()
  const setDefault = useSetDefaultDevice()
  const setCommandAccess = useSetCommandAccess()
  const removeDevice = useRemoveDevice()
  const search = useSearch({ from: '/workspace/devices' })
  const navigate = useNavigate()

  const [expanded, setExpanded] = useState<ID | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const notify = (notice: Notice) => setFeedback({ kind: 'notice', notice })
  // 首页的「Connect a device」带 connect 参数打开这里，直接弹出接入窗口。
  const [enrolling, setEnrolling] = useState(() => Boolean(search.connect))
  const [disconnect, setDisconnect] = useState<Disconnect | null>(null)
  const [permission, setPermission] = useState<PermissionState | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const removed = useRef(false)

  useEffect(() => {
    if (search.connect) void navigate({ to: '/devices', search: {}, replace: true })
  }, [search.connect, navigate])

  const list = devices.data ?? []
  const defaultId = session.data?.defaultDeviceId ?? null
  // 最后联系时间按分钟显示，每分钟刷新一次。
  const now = useNow(60_000)

  const saveDefault = (device: Device, offline: boolean) => {
    setDefault.mutate(device.id, {
      onSuccess: () =>
        notify({
          title: 'Default device saved',
          detail: offline
            ? `${device.name} is your default device. It is offline; new chats on it wait until it reconnects. Projects can use another available device.`
            : `${device.name} is your default for new chats and the first choice for the project assistant.`,
        }),
      onError: () => notify(unreachableNotice),
    })
  }

  const chooseDefault = (device: Device) => {
    if (device.id === defaultId || setDefault.isPending) return
    saveDefault(device, device.connection === 'offline')
  }

  const changePermission = (device: Device, enabled: boolean) => {
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
        else {
          notify({
            title: `${device.name} disconnected`,
            detail: `Past chats and records are kept. If ${device.name} was offline, its agents may still be running locally.`,
          })
        }
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
      detail: `${feedback.removed} was your default and has been removed. No replacement has been selected. Past chats and records are kept.`,
      action: replacement && {
        label: `Set ${replacement.name} as default`,
        run: () =>
          setDefault.mutate(replacement.id, {
            onSuccess: () =>
              notify({
                title: 'Default device saved',
                detail: `${replacement.name} is your default for new chats and projects.`,
              }),
            onError: () => notify(unreachableNotice),
          }),
      },
    }
  }

  let body
  if (devices.isPending) {
    body = <p {...stylex.props(text.small, text.muted)}>Loading devices…</p>
  } else if (devices.isError) {
    body = (
      <NoticeBox
        notice={{ title: 'Could not load devices', detail: 'Baton could not be reached. Check your connection.' }}
      >
        <Button small icon="refresh" onClick={() => void devices.refetch()}>
          Try again
        </Button>
      </NoticeBox>
    )
  } else if (list.length === 0) {
    body = (
      <div {...stylex.props(styles.empty)}>
        <span {...stylex.props(text.heading)}>No devices connected</span>
        <span {...stylex.props(text.small, text.muted)}>
          Connect a computer to start chats and run work in your projects.
        </span>
        <Button variant="primary" icon="plus" onClick={() => setEnrolling(true)}>
          Connect a device
        </Button>
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
                  notice={deviceNotice(device, now)}
                  isDefault={device.id === defaultId}
                  savingDefault={setDefault.isPending && setDefault.variables === device.id}
                  permission={permission?.deviceId === device.id ? permission : undefined}
                  onPermission={(enabled) => changePermission(device, enabled)}
                  onDefault={() => chooseDefault(device)}
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
          <div {...stylex.props(styles.introText)}>
            <h2 ref={headingRef} tabIndex={-1} {...stylex.props(text.title, styles.heading)}>
              {devicesHeading(list)}
            </h2>
            <p {...stylex.props(text.small, text.muted)}>
              Connect the computers where your code lives. The project assistant uses your default device first, then
              another available computer.
            </p>
          </div>
          {list.length > 0 && (
            <Button icon="plus" onClick={() => setEnrolling(true)}>
              Connect a device
            </Button>
          )}
        </div>
        {shownFeedback && <NoticeBox notice={shownFeedback} />}
        {body}
      </div>

      {enrolling && (
        <EnrollDialog
          onClose={() => setEnrolling(false)}
          // 空列表里的接入按钮在设备连上后就不在了，焦点回到标题。
          finalFocus={() => headingRef.current}
        />
      )}

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
  let title = `Disconnect “${name}”?`
  let description = state?.wasDefault
    ? `${name} is your default device. Removing it leaves no default until you choose another. Offline agents may keep running locally. Past chats and records are kept; file changes and commands already run are not undone.`
    : `Removes ${name} from Baton. If it is offline, agents still running on it will keep running locally. Past chats and records are kept. This does not undo file changes or commands already run.`
  let actions = (
    <>
      <Button onClick={onCancel}>Cancel</Button>
      <Button variant="danger" onClick={onConfirm}>
        Disconnect device
      </Button>
    </>
  )
  if (state?.phase === 'pending') {
    title = `Disconnecting ${name}…`
    description =
      'Baton is blocking new connections and closing the current connection. Wait for confirmation before treating this device as disconnected.'
    actions = (
      <Button variant="danger" aria-disabled>
        Disconnecting…
      </Button>
    )
  } else if (state?.phase === 'failed') {
    title = 'Could not confirm disconnection'
    description = `Baton could not be reached while disconnecting ${name}. Its connection may still be active. Check your connection, then retry to confirm removal.`
    actions = (
      <>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="danger" onClick={onConfirm}>
          Retry disconnection
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
