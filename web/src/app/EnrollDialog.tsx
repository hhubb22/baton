import type { DownloadItem } from '@baton/protocol/http-api'
import * as stylex from '@stylexjs/stylex'
import { useState } from 'react'
import { fileSize } from '../data/derive'
import { desktopBridge } from '../data/desktop'
import { useDownloads } from '../data/queries'
import type { Device, DeviceOS } from '../data/types'
import { text } from '../theme/text'
import { semantic } from '../theme/semantic.stylex'
import { radius, space } from '../theme/tokens.stylex'
import { Button, focusRing, IconButton } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Segmented } from '../ui/Tabs'
import { DesktopEnrollDialog } from './DesktopEnrollDialog'

const styles = stylex.create({
  section: { display: 'flex', flexDirection: 'column', gap: space.sm },
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
  helper: { color: semantic.mutedForeground },
  link: { color: semantic.brandForeground },
  checksum: { overflowWrap: 'anywhere', userSelect: 'all' },
  error: { color: semantic.destructiveForeground },
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

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function downloadUrl(file: string) {
  return new URL(`/downloads/${encodeURIComponent(file)}`, window.location.origin).href
}

function loginCommand(download?: DownloadItem) {
  const commands = download
    ? [`tar xzf ${shellQuote(download.file)} && cd ${shellQuote(download.file.replace(/\.tar\.gz$/, ''))}`]
    : []
  commands.push(`./batond login --coordinator ${shellQuote(window.location.origin)}`, './batond service install')
  return commands.join(' &&\n')
}

type Copied = { target: 'command' | 'download'; ok: boolean }

function copyText(value: string) {
  if (!navigator.clipboard) return Promise.reject(new Error('Clipboard unavailable'))
  return navigator.clipboard.writeText(value)
}

export function EnrollDialog(props: {
  device?: Device
  onClose: () => void
  finalFocus?: () => HTMLElement | null | boolean
}) {
  return desktopBridge() ? <DesktopEnrollDialog {...props} /> : <BrowserEnrollDialog {...props} />
}

function BrowserEnrollDialog({
  onClose,
  finalFocus,
}: {
  onClose: () => void
  finalFocus?: () => HTMLElement | null | boolean
}) {
  const downloads = useDownloads()
  const [arch, setArch] = useState<'arm64' | 'x64'>('x64')
  const [os, setOS] = useState(detectOS)
  const [copied, setCopied] = useState<Copied | null>(null)
  const platform = os === 'macOS' ? 'darwin' : os === 'Windows' ? 'win32' : 'linux'
  const manifest = downloads.data
  const items = manifest?.enabled ? manifest.items.filter((item) => item.platform === platform) : []
  const cliItems = items.filter((item) => item.kind === 'cli' && item.platform !== 'win32')
  const cli = cliItems.find((item) => item.arch === arch) ?? cliItems[0]
  const desktop = items.find((item) => item.kind === 'desktop')
  const downloadCommand = cli ? `curl -fL -O ${shellQuote(downloadUrl(cli.file))}` : ''
  const showCommand = downloads.isSuccess && os !== 'Windows' && (!manifest?.enabled || cli !== undefined)
  const command = loginCommand(cli)
  const copy = (target: Copied['target'], value: string) => {
    copyText(value).then(
      () => setCopied({ target, ok: true }),
      () => setCopied({ target, ok: false }),
    )
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title="连接设备"
      wide
      finalFocus={finalFocus}
      actions={<Button onClick={onClose}>关闭</Button>}
    >
      <Segmented label="操作系统" options={systems} value={os} onChange={setOS} block />
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
          {os !== 'Windows' && !cli && (
            <p {...stylex.props(text.small, styles.helper)}>暂无适用于 {os} 的命令行工具下载。</p>
          )}
          {os === 'Windows' && !desktop && (
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
          {cli && os !== 'Windows' && (
            <div {...stylex.props(styles.section)}>
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
              <p {...stylex.props(text.caption, styles.helper)}>下载后请核对 SHA-256。</p>
            </div>
          )}
        </div>
      )}
      {os === 'Windows' && downloads.isSuccess && (
        <p {...stylex.props(text.small, styles.helper)}>安装桌面客户端后，在设备页面选择「在桌面客户端打开」。</p>
      )}
      {showCommand && (
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
        </div>
      )}
      {copied && !copied.ok && (
        <p role="alert" {...stylex.props(text.caption, styles.error)}>
          无法访问剪贴板，请手动复制。
        </p>
      )}
    </Dialog>
  )
}
