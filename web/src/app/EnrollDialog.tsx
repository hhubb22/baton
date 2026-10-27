import * as stylex from '@stylexjs/stylex'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useCreateEnrollment, useDevices, useEnrollment } from '../data/queries'
import type { Device, DeviceOS, IssuedEnrollment } from '../data/types'
import { text } from '../theme/text'
import { colors, radius, space } from '../theme/tokens.stylex'
import { Button, IconButton } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Input } from '../ui/Field'
import { Icon } from '../ui/Icon'
import { StatusDot, type Tone } from '../ui/Status'
import { Segmented } from '../ui/Tabs'

const styles = stylex.create({
  section: { display: 'flex', flexDirection: 'column', gap: space.sm },
  nameRow: { display: 'flex', gap: space.md },
  name: { flexGrow: 1, flexBasis: 0, minWidth: 0 },
  system: { display: 'flex', flexGrow: 1, flexBasis: 0 },
  box: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space.sm,
    minHeight: '44px',
    paddingBlock: space.sm,
    paddingLeft: space.md,
    paddingRight: space.xs,
    backgroundColor: colors.code,
    borderRadius: radius.md,
  },
  boxText: {
    flexGrow: 1,
    minWidth: 0,
    paddingBlock: '4px',
    margin: 0,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    userSelect: 'all',
  },
  dim: { color: colors.faint },
  helper: { color: colors.muted },
  warning: { color: colors.attentionText },
  error: { color: colors.danger },
  status: { display: 'inline-flex', alignItems: 'center', gap: space.sm, color: colors.muted },
  countdown: { color: colors.faint },
  device: {
    display: 'flex',
    alignItems: 'center',
    gap: space.md,
    paddingBlock: space.md,
    paddingInline: space.lg,
    backgroundColor: colors.panel,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSoft,
    borderRadius: radius.lg,
  },
  deviceBody: { display: 'flex', flexDirection: 'column', minWidth: 0 },
})

const systems: { value: DeviceOS; label: string }[] = [
  { value: 'Windows', label: 'Windows' },
  { value: 'macOS', label: 'macOS' },
  { value: 'Linux', label: 'Linux' },
]

function detectOS(): DeviceOS {
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/Windows/.test(agent)) return 'Windows'
  if (/Mac/.test(agent)) return 'macOS'
  return 'Linux'
}

const placeholderName = 'My computer'

function shellQuote(value: string, os: DeviceOS) {
  if (/^[\w .()-]*$/.test(value)) return `"${value}"`
  // PowerShell 单引号里用两个单引号表示一个；POSIX shell 先结束引号再接转义的单引号。
  return os === 'Windows' ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`
}

// 设置码通过环境变量交给 batond，不出现在命令行参数和 shell 历史里。
export function registerCommand(coordinatorUrl: string, name: string, os: DeviceOS, reauth = false) {
  const tokenInput =
    os === 'Windows'
      ? '$env:BATON_ENROLLMENT_TOKEN = Read-Host -MaskInput'
      : 'read -rs BATON_ENROLLMENT_TOKEN && export BATON_ENROLLMENT_TOKEN'
  if (reauth) return `${tokenInput}\nbatond reauth && batond up`
  const displayName = shellQuote(name.trim() || placeholderName, os)
  if (os === 'Windows') {
    return [
      tokenInput,
      `batond up --coordinator ${coordinatorUrl} \``,
      `  --display-name ${displayName} --system windows`,
    ].join('\n')
  }
  return [
    tokenInput,
    `batond up --coordinator ${coordinatorUrl} \\`,
    `  --display-name ${displayName} --system ${os === 'macOS' ? 'macos' : 'linux'}`,
  ].join('\n')
}

function countdown(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

// 接入后只写系统；同步中或没有可用 Agent 时补一句。
function availability(device: Device) {
  if (device.connection === 'syncing') return 'Checking availability…'
  return device.agents.some((agent) => !agent.problem) ? null : 'No agents available yet'
}

type Copied = { target: 'code' | 'command'; ok: boolean }
type Phase = 'loading' | 'failed' | 'pending' | 'expired' | 'used' | 'connected'

function copyText(value: string) {
  if (!navigator.clipboard) return Promise.reject(new Error('Clipboard unavailable'))
  return navigator.clipboard.writeText(value)
}

function Status({ tone, children }: { tone: Tone; children: string }) {
  return (
    <span {...stylex.props(styles.status)}>
      <StatusDot tone={tone} />
      {children}
    </span>
  )
}

// 打开时向中心要一次性设置码；设备用它连上后显示设备信息。重新取码时保留已填的名称和系统。
export function EnrollDialog({
  device,
  onClose,
  finalFocus,
}: {
  device?: Device
  onClose: () => void
  finalFocus?: () => HTMLElement | null | boolean
}) {
  const create = useCreateEnrollment()
  const devices = useDevices()
  const [issued, setIssued] = useState<{ enrollment: IssuedEnrollment; receivedAt: number } | null>(null)
  const enrollment = useEnrollment(issued?.enrollment.id ?? null)
  const [name, setName] = useState('')
  const [os, setOS] = useState(detectOS)
  const [copied, setCopied] = useState<Copied | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const requested = useRef(false)

  const request = () => {
    setCopied(null)
    setIssued(null)
    create.mutate(device?.id, { onSuccess: (result) => setIssued({ enrollment: result, receivedAt: Date.now() }) })
  }

  useEffect(() => {
    if (requested.current) return
    requested.current = true
    request()
    // 只在打开时取一次码，之后由「Get a new code」重新取。
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const state = enrollment.data?.state ?? issued?.enrollment.state
  let phase: Phase = 'loading'
  if (create.isError) phase = 'failed'
  else if (issued && state) phase = state

  useEffect(() => {
    if (phase !== 'pending') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [phase])

  const connected = devices.data?.find((item) => item.id === enrollment.data?.deviceId)
  const code = issued?.enrollment.code ?? ''
  const command = issued
    ? registerCommand(issued.enrollment.coordinatorUrl, name, device?.os ?? os, device !== undefined)
    : ''
  const title = device ? 'Reconnect device' : 'Connect a device'

  const copy = (target: Copied['target'], value: string) => {
    copyText(value).then(
      () => setCopied({ target, ok: true }),
      () => setCopied({ target, ok: false }),
    )
  }

  const close = () => onClose()

  if (phase === 'connected') {
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) close()
        }}
        title={title}
        wide
        finalFocus={finalFocus}
        note={<Status tone="success">Connected</Status>}
        actions={
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        }
      >
        {connected && (
          <div {...stylex.props(styles.device)}>
            <Icon name="laptop" size={16} style={styles.helper} />
            <div {...stylex.props(styles.deviceBody)}>
              <span {...stylex.props(text.label)}>{connected.name}</span>
              <span {...stylex.props(text.caption, styles.helper)}>
                {[connected.os, availability(connected)].filter(Boolean).join(' · ')}
              </span>
            </div>
          </div>
        )}
      </Dialog>
    )
  }

  const closed = phase === 'expired' || phase === 'used'
  const codeLabels: Record<Exclude<Phase, 'connected'>, string> = {
    loading: 'Getting a setup code…',
    failed: 'Setup code',
    pending: 'Setup code',
    expired: 'Setup code expired',
    used: 'Setup code already used',
  }

  // 复制成功只换成对勾图标，不另加说明。
  const blocked = <span {...stylex.props(styles.warning)}>Clipboard blocked. Copy it manually.</span>
  let codeNote: ReactNode = null
  if (phase === 'expired' || phase === 'used') {
    codeNote = <span {...stylex.props(styles.error)}>Run the command again with a new code.</span>
  } else if (copied?.target === 'code' && !copied.ok) {
    codeNote = blocked
  }

  let commandNote: ReactNode = (
    <span {...stylex.props(styles.helper)}>Paste the code and press Enter. It stays hidden.</span>
  )
  if (copied?.target === 'command' && !copied.ok) commandNote = blocked

  const notes: Record<Exclude<Phase, 'connected'>, ReactNode> = {
    loading: <Status tone="hollow">Getting a new code…</Status>,
    failed: <Status tone="attention">Can't reach Baton</Status>,
    pending: (
      <span {...stylex.props(styles.status)}>
        <Status tone="hollow">Waiting for device…</Status>
        {issued && (
          <span {...stylex.props(styles.countdown)}>
            Expires in {countdown(issued.enrollment.expiresIn - (now - issued.receivedAt))}
          </span>
        )}
      </span>
    ),
    expired: <Status tone="danger">Setup code expired</Status>,
    used: <Status tone="danger">Setup code already used</Status>,
  }

  const retry = phase === 'failed' || closed

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
      title={title}
      wide
      finalFocus={finalFocus}
      note={notes[phase]}
      actions={
        <>
          <Button onClick={close}>Close</Button>
          {retry && (
            <Button variant="primary" onClick={request}>
              Get a new code
            </Button>
          )}
        </>
      }
    >
      {device ? (
        <span {...stylex.props(text.label)}>{device.name}</span>
      ) : (
        <div {...stylex.props(styles.section)}>
          <label htmlFor="enroll-name" {...stylex.props(text.label)}>
            Device name
          </label>
          <div {...stylex.props(styles.nameRow)}>
            <Input
              id="enroll-name"
              value={name}
              placeholder={placeholderName}
              autoComplete="off"
              onChange={(event) => setName(event.target.value)}
              style={styles.name}
            />
            <div {...stylex.props(styles.system)}>
              <Segmented label="Operating system" options={systems} value={os} onChange={setOS} block />
            </div>
          </div>
        </div>
      )}
      <div {...stylex.props(styles.section)}>
        <span id="enroll-code-label" {...stylex.props(text.label)}>
          {codeLabels[phase]}
        </span>
        <div {...stylex.props(styles.box)}>
          <code
            aria-labelledby="enroll-code-label"
            {...stylex.props(text.mono, styles.boxText, (phase !== 'pending' || !code) && styles.dim)}
          >
            {phase === 'loading' && 'Waiting for Baton…'}
            {phase === 'failed' && 'No code issued'}
            {phase !== 'loading' && phase !== 'failed' && code}
          </code>
          {phase === 'pending' && (
            <IconButton
              icon={copied?.target === 'code' && copied.ok ? 'check' : 'copy'}
              label="Copy setup code"
              onClick={() => copy('code', code)}
            />
          )}
        </div>
        {codeNote && <p {...stylex.props(text.caption)}>{codeNote}</p>}
      </div>
      {issued && phase !== 'failed' && (
        <div {...stylex.props(styles.section)}>
          <span id="enroll-command-label" {...stylex.props(text.label)}>
            Run in terminal
          </span>
          <div {...stylex.props(styles.box)}>
            <pre aria-labelledby="enroll-command-label" {...stylex.props(text.mono, styles.boxText)}>
              {command}
            </pre>
            <IconButton
              icon={copied?.target === 'command' && copied.ok ? 'check' : 'copy'}
              label="Copy command"
              onClick={() => copy('command', command)}
            />
          </div>
          <p {...stylex.props(text.caption)}>{commandNote}</p>
        </div>
      )}
    </Dialog>
  )
}
