import type { DownloadItem } from '@baton/protocol/http-api'
import * as stylex from '@stylexjs/stylex'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { fileSize } from '../data/derive'
import { desktopBridge } from '../data/desktop'
import { DesktopEnrollDialog } from './DesktopEnrollDialog'
import { useCreateEnrollment, useDevices, useDownloads, useEnrollment } from '../data/queries'
import type { Device, DeviceOS, IssuedEnrollment } from '../data/types'
import { text } from '../theme/text'
import { semantic } from '../theme/semantic.stylex'
import { radius, space } from '../theme/tokens.stylex'
import { Button, focusRing, IconButton } from '../ui/Button'
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
    backgroundColor: semantic.code,
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
  dim: { color: semantic.faintForeground },
  helper: { color: semantic.mutedForeground },
  link: { color: semantic.brandForeground },
  checksum: { overflowWrap: 'anywhere', userSelect: 'all' },
  warning: { color: semantic.warningForeground },
  error: { color: semantic.destructiveForeground },
  status: { display: 'inline-flex', alignItems: 'center', gap: space.sm, color: semantic.mutedForeground },
  countdown: { color: semantic.faintForeground },
  device: {
    display: 'flex',
    alignItems: 'center',
    gap: space.md,
    paddingBlock: space.md,
    paddingInline: space.lg,
    backgroundColor: semantic.sidebar,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: semantic.border,
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

const placeholderName = '我的电脑'

function shellQuote(value: string, os: DeviceOS) {
  if (/^[\w .()-]*$/.test(value)) return `"${value}"`
  // PowerShell 单引号里用两个单引号表示一个；POSIX shell 先结束引号再接转义的单引号。
  return os === 'Windows' ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`
}

function downloadUrl(file: string) {
  return new URL(`/downloads/${encodeURIComponent(file)}`, window.location.origin).href
}

// 设置码通过环境变量交给 batond，不出现在命令行参数和 shell 历史里。
export function registerCommand(
  coordinatorUrl: string,
  name: string,
  os: DeviceOS,
  reauth = false,
  download?: DownloadItem,
) {
  const tokenInput =
    os === 'Windows'
      ? '$env:BATON_ENROLLMENT_TOKEN = Read-Host -MaskInput'
      : 'read -rs BATON_ENROLLMENT_TOKEN && export BATON_ENROLLMENT_TOKEN'
  const displayName = shellQuote(name.trim() || placeholderName, os)
  if (download) {
    return [
      `tar xzf ${shellQuote(download.file, os)} && cd ${shellQuote(download.file.replace(/\.tar\.gz$/, ''), os)}`,
      tokenInput,
      `./batond ${reauth ? 'reauth' : `register --coordinator ${shellQuote(window.location.origin, os)} --display-name ${displayName}`} && ./batond service install`,
    ].join(' &&\n')
  }
  if (reauth) return `${tokenInput}\nbatond reauth && batond up`
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
  if (device.connection === 'syncing') return '正在检查可用性…'
  return device.agents.some((agent) => !agent.problem) ? null : '暂无可用助手'
}

type Copied = { target: 'code' | 'command' | 'download'; ok: boolean }
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

export function EnrollDialog(props: {
  device?: Device
  onClose: () => void
  finalFocus?: () => HTMLElement | null | boolean
}) {
  return desktopBridge() ? <DesktopEnrollDialog {...props} /> : <BrowserEnrollDialog {...props} />
}

// 打开时向中心要一次性设置码；设备用它连上后显示设备信息。重新取码时保留已填的名称和系统。
function BrowserEnrollDialog({
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
  const downloads = useDownloads()
  const [arch, setArch] = useState<'arm64' | 'x64'>('x64')
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
  const targetOS = device?.os ?? os
  const platform = targetOS === 'macOS' ? 'darwin' : targetOS === 'Windows' ? 'win32' : 'linux'
  const manifest = downloads.data
  const downloadable = manifest?.enabled === true
  const items = manifest?.enabled ? manifest.items.filter((item) => item.platform === platform) : []
  const cliItems = items.filter((item) => item.kind === 'cli' && item.platform !== 'win32')
  const cli = cliItems.find((item) => item.arch === arch) ?? cliItems[0]
  const downloadCommand = cli ? `curl -fL -O ${shellQuote(downloadUrl(cli.file), targetOS)}` : ''
  const desktopOnly = downloadable && targetOS === 'Windows'
  const showCommand = downloads.isSuccess && (!downloadable || cli !== undefined) && !desktopOnly
  const command =
    issued && showCommand
      ? registerCommand(issued.enrollment.coordinatorUrl, name, targetOS, device !== undefined, cli)
      : ''
  const title = device ? '重新连接设备' : '连接设备'

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
        note={<Status tone="success">已连接</Status>}
        actions={
          <Button variant="primary" onClick={close}>
            完成
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
    loading: '正在获取设置码…',
    failed: '设置码',
    pending: '设置码',
    expired: '设置码已过期',
    used: '设置码已使用',
  }

  // 复制成功只换成对勾图标，不另加说明。
  const blocked = <span {...stylex.props(styles.warning)}>无法访问剪贴板，请手动复制。</span>
  let codeNote: ReactNode = null
  if (phase === 'expired' || phase === 'used') {
    codeNote = <span {...stylex.props(styles.error)}>请使用新设置码重新运行命令。</span>
  } else if (copied?.target === 'code' && !copied.ok) {
    codeNote = blocked
  }

  let commandNote: ReactNode = <span {...stylex.props(styles.helper)}>粘贴设置码并按 Enter，输入内容不会显示。</span>
  if (copied?.target === 'command' && !copied.ok) commandNote = blocked

  const notes: Record<Exclude<Phase, 'connected'>, ReactNode> = {
    loading: <Status tone="hollow">正在获取新设置码…</Status>,
    failed: <Status tone="attention">无法连接 Baton</Status>,
    pending: (
      <span {...stylex.props(styles.status)}>
        <Status tone="hollow">等待设备连接…</Status>
        {issued && (
          <span {...stylex.props(styles.countdown)}>
            {countdown(issued.enrollment.expiresIn - (now - issued.receivedAt))} 后过期
          </span>
        )}
      </span>
    ),
    expired: <Status tone="danger">设置码已过期</Status>,
    used: <Status tone="danger">设置码已使用</Status>,
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
          <Button onClick={close}>关闭</Button>
          {retry && (
            <Button variant="primary" onClick={request}>
              获取新设置码
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
            设备名称
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
              <Segmented label="操作系统" options={systems} value={os} onChange={setOS} block />
            </div>
          </div>
        </div>
      )}
      {downloads.isPending && <p {...stylex.props(text.small, styles.helper)}>正在加载下载信息…</p>}
      {downloads.isError && (
        <div {...stylex.props(styles.section)}>
          <p role="alert" {...stylex.props(text.small, styles.error)}>
            无法加载下载信息。
          </p>
          <Button small onClick={() => void downloads.refetch()}>
            重试
          </Button>
        </div>
      )}
      {manifest?.enabled && (
        <div {...stylex.props(styles.section)}>
          {items
            .filter((item) => item.kind === 'desktop' || item.platform !== 'win32')
            .map((item) => (
              <div key={item.file} {...stylex.props(styles.section)}>
                <a
                  href={downloadUrl(item.file)}
                  download={item.file}
                  {...stylex.props(text.label, styles.link, focusRing.ring)}
                >
                  下载{item.kind === 'cli' ? '命令行工具' : '桌面客户端'} · {item.arch}
                </a>
                <span {...stylex.props(text.caption, styles.helper)}>
                  {manifest.version} · {fileSize(item.size)}
                </span>
                <code {...stylex.props(text.mono, styles.checksum)}>SHA-256: {item.sha256}</code>
              </div>
            ))}
          {desktopOnly && items.length > 0 ? (
            <p {...stylex.props(text.small, styles.helper)}>安装桌面客户端后，在设备页面选择“在桌面客户端打开”。</p>
          ) : (
            !desktopOnly &&
            !cli && <p {...stylex.props(text.small, styles.helper)}>暂无适用于 {targetOS} 的命令行工具下载。</p>
          )}
          {items.length === 0 && desktopOnly && (
            <p {...stylex.props(text.small, styles.helper)}>暂无适用于 Windows 的桌面客户端下载。</p>
          )}
          {cliItems.length > 1 && (
            <Segmented
              label="架构"
              options={cliItems.map((item) => ({ value: item.arch, label: item.arch }))}
              value={cli?.arch ?? arch}
              onChange={setArch}
            />
          )}
          {cli && !desktopOnly && (
            <>
              <span id="enroll-download-label" {...stylex.props(text.label)}>
                在终端下载
              </span>
              <div {...stylex.props(styles.box)}>
                <pre aria-labelledby="enroll-download-label" {...stylex.props(text.mono, styles.boxText)}>
                  {downloadCommand}
                </pre>
                <IconButton
                  icon={copied?.target === 'download' && copied.ok ? 'check' : 'copy'}
                  label="复制下载命令"
                  onClick={() => copy('download', downloadCommand)}
                />
              </div>
              <p {...stylex.props(text.caption, styles.helper)}>
                {copied?.target === 'download' && !copied.ok ? blocked : '运行设置命令前，请核对 SHA-256。'}
              </p>
              {!device && (
                <p {...stylex.props(text.caption, styles.helper)}>
                  如果中心使用自签名证书，请先将可信的 CA 证书保存到设备，下载时给 curl 添加 --cacert
                  &lt;本地证书路径&gt;，注册时给 register 添加 --ca-file &lt;本地证书路径&gt;。下载后请核对 SHA-256。
                </p>
              )}
            </>
          )}
        </div>
      )}
      {!desktopOnly && (
        <div {...stylex.props(styles.section)}>
          <span id="enroll-code-label" {...stylex.props(text.label)}>
            {codeLabels[phase]}
          </span>
          <div {...stylex.props(styles.box)}>
            <code
              aria-labelledby="enroll-code-label"
              {...stylex.props(text.mono, styles.boxText, (phase !== 'pending' || !code) && styles.dim)}
            >
              {phase === 'loading' && '正在等待 Baton…'}
              {phase === 'failed' && '未生成设置码'}
              {phase !== 'loading' && phase !== 'failed' && code}
            </code>
            {phase === 'pending' && (
              <IconButton
                icon={copied?.target === 'code' && copied.ok ? 'check' : 'copy'}
                label="复制设置码"
                onClick={() => copy('code', code)}
              />
            )}
          </div>
          {codeNote && <p {...stylex.props(text.caption)}>{codeNote}</p>}
        </div>
      )}
      {issued && showCommand && phase !== 'failed' && (
        <div {...stylex.props(styles.section)}>
          <span id="enroll-command-label" {...stylex.props(text.label)}>
            在终端运行
          </span>
          <div {...stylex.props(styles.box)}>
            <pre aria-labelledby="enroll-command-label" {...stylex.props(text.mono, styles.boxText)}>
              {command}
            </pre>
            <IconButton
              icon={copied?.target === 'command' && copied.ok ? 'check' : 'copy'}
              label="复制命令"
              onClick={() => copy('command', command)}
            />
          </div>
          <p {...stylex.props(text.caption)}>{commandNote}</p>
        </div>
      )}
    </Dialog>
  )
}
