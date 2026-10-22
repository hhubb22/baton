import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import * as stylex from '@stylexjs/stylex'
import { useState, type ReactNode } from 'react'
import {
  baseName,
  fileSize,
  folderName,
  parentFolder,
  previewProblem,
  readFailure,
  shortenExcerpt,
  type PreviewView,
} from '../data/derive'
import { useDevices, useFile, useFolders, useThreads } from '../data/queries'
import { previewLimit, type Device, type ID, type Reference } from '../data/types'
import { fonts, shadow } from '../theme/base.stylex'
import { text } from '../theme/text'
import { colors, radius, space } from '../theme/tokens.stylex'
import { Button, focusRing, IconButton } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { useWorkspace } from './workspace'
import { copySelection, copyText, SelectionArea } from './SelectionMenu'

const styles = stylex.create({
  backdrop: { position: 'fixed', inset: 0, zIndex: 30, backgroundColor: colors.overlay },
  popup: {
    position: 'fixed',
    top: '50%',
    left: '50%',
    zIndex: 31,
    display: 'flex',
    flexDirection: 'column',
    width: '960px',
    maxWidth: 'calc(100vw - 32px)',
    height: '580px',
    maxHeight: 'calc(100vh - 64px)',
    overflow: 'hidden',
    transform: 'translate(-50%, -50%)',
    backgroundColor: colors.surface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    borderRadius: '14px',
    boxShadow: shadow.dialog,
    color: colors.text,
    outline: 'none',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    flexShrink: 0,
    paddingBlock: space.md,
    paddingLeft: space.lg,
    paddingRight: space.md,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSoft,
  },
  heading: { display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 },
  split: { display: 'flex', flexGrow: 1, minHeight: 0 },
  nav: {
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
    width: '240px',
    minHeight: 0,
    backgroundColor: colors.panel,
    borderRightWidth: '1px',
    borderRightStyle: 'solid',
    borderRightColor: colors.borderSoft,
  },
  crumbs: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.xs,
    paddingBlock: space.sm,
    paddingInline: space.md,
    color: colors.muted,
  },
  crumb: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: { default: colors.muted, ':hover': colors.text },
  },
  crumbCurrent: { color: colors.text },
  rows: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    minHeight: 0,
    overflowY: 'auto',
    paddingBottom: space.sm,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    flexShrink: 0,
    height: '30px',
    marginInline: space.xs,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: 'transparent', ':hover': colors.hover },
    color: colors.text,
    textAlign: 'left',
  },
  rowSelected: { backgroundColor: { default: colors.selected, ':hover': colors.selected } },
  rowName: { flexGrow: 1 },
  rowIcon: { flexShrink: 0, color: colors.muted },
  rowSize: { flexShrink: 0, color: colors.faint },
  navNote: { paddingBlock: space.xs, paddingInline: space.md, color: colors.muted },
  content: { display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0, minHeight: 0 },
  scroll: { flexGrow: 1, minHeight: 0, overflow: 'auto' },
  lines: { paddingBlock: space.sm, fontFamily: fonts.mono, fontSize: '12px', lineHeight: 1.6 },
  line: { display: 'flex', paddingRight: space.lg },
  lineSelected: { backgroundColor: colors.infoSoft },
  gutter: {
    flexShrink: 0,
    width: '56px',
    paddingRight: space.md,
    color: colors.faint,
    textAlign: 'right',
    userSelect: 'none',
  },
  code: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', minWidth: 0 },
  divider: {
    display: 'flex',
    alignItems: 'center',
    gap: space.md,
    paddingBlock: space.md,
    paddingInline: space.lg,
    color: colors.faint,
    '::before': { content: '""', flexGrow: 1, height: '1px', backgroundColor: colors.borderSoft },
    '::after': { content: '""', flexGrow: 1, height: '1px', backgroundColor: colors.borderSoft },
  },
  selectionNote: {
    flexShrink: 0,
    paddingBlock: space.sm,
    paddingInline: space.lg,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.borderSoft,
    color: colors.info,
  },
  state: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    flexGrow: 1,
    padding: space.xxl,
    textAlign: 'center',
  },
  stateIcon: { color: colors.faint },
  stateDetail: { maxWidth: '360px', color: colors.muted },
  muted: { color: colors.muted },
})

function inside(path: string, root: string) {
  if (path === root) return true
  const separator = root.includes('\\') ? '\\' : '/'
  return path.startsWith(root.endsWith(separator) ? root : root + separator)
}

// 浏览的起点：文件在 Thread 目录里时用 Thread 目录，否则用包含它的允许目录。
function rootFor(path: string, device: Device | undefined, folder: string | null) {
  if (folder && inside(path, folder)) return folder
  return device?.folders.find((root) => inside(path, root)) ?? null
}

export interface PreviewSource {
  threadId: ID
  // 打开文件的那条回复的序号；更早的对话里没有序号。
  reply: number | null
}

// 文件预览：左边是允许目录里的文件夹，右边是从设备实时读到的内容。设备离线或路径不可读时只显示原因，不显示旧内容。
// 选中几行后可以带着来源去问 Project 助手；不属于 Project 时改为复制。
export function FilePreview({
  deviceId,
  path,
  onClose,
  projectId,
  source,
}: {
  deviceId: ID
  path: string
  onClose: () => void
  projectId: ID | null
  source: PreviewSource | null
}) {
  const devices = useDevices()
  const threads = useThreads()
  const device = devices.data?.find((item) => item.id === deviceId)
  const thread = source ? threads.data?.find((item) => item.id === source.threadId) : undefined
  const [file, setFile] = useState<string | null>(path)
  const [dir, setDir] = useState<string | null>(() => parentFolder(path))
  const root = dir ? rootFor(dir, device, thread?.folder ?? null) : null
  const current = file ?? dir ?? path
  const fileRoot = file ? rootFor(file, device, thread?.folder ?? null) : root
  const shown = fileRoot && current !== fileRoot ? current.slice(fileRoot.length).replace(/^[\\/]/, '') : current
  const preview = useFile(deviceId, file)
  const size = file && preview.data ? preview.data.size : null
  const meta = [device?.name ?? 'Removed device', fileRoot, size !== null ? fileSize(size) : null].filter(Boolean)
  const [copied, setCopied] = useState(false)

  return (
    <BaseDialog.Root open onOpenChange={(open) => !open && onClose()}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop {...stylex.props(styles.backdrop)} />
        <BaseDialog.Popup {...stylex.props(styles.popup)}>
          <div {...stylex.props(styles.header)}>
            <div {...stylex.props(styles.heading)}>
              <BaseDialog.Title title={current} {...stylex.props(text.mono, text.truncate)}>
                {shown}
              </BaseDialog.Title>
              <span {...stylex.props(text.caption, styles.muted, text.truncate)}>{meta.join(' · ')}</span>
            </div>
            <IconButton
              icon={copied ? 'check' : 'copy'}
              label={copied ? 'Path copied' : 'Copy path'}
              onClick={() => void copyText(current).then(() => setCopied(true))}
            />
            <BaseDialog.Close render={<IconButton icon="close" label="Close preview" />} />
          </div>
          <div {...stylex.props(styles.split)}>
            <FolderPane
              deviceId={deviceId}
              dir={dir}
              root={root}
              file={file}
              onDir={setDir}
              onFile={(next) => {
                setFile(next)
                setCopied(false)
              }}
            />
            {file ? (
              <FileContent
                key={file}
                deviceId={deviceId}
                path={file}
                device={device}
                preview={preview}
                projectId={projectId}
                source={source}
                onBack={() => {
                  setDir(dir ?? parentFolder(file))
                  setFile(null)
                }}
              />
            ) : (
              <div {...stylex.props(styles.content)}>
                <State icon="folder" title="Choose a file" detail="Select a file on the left to preview it." />
              </div>
            )}
          </div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}

function FolderPane({
  deviceId,
  dir,
  root,
  file,
  onDir,
  onFile,
}: {
  deviceId: ID
  dir: string | null
  root: string | null
  file: string | null
  onDir: (dir: string | null) => void
  onFile: (path: string) => void
}) {
  // 不在允许目录里时列出允许的目录，从那里重新进入。
  const listing = useFolders(deviceId, root ? dir : null)
  const crumbs: { label: string; path: string | null }[] = [{ label: 'Allowed folders', path: null }]
  if (root && dir) {
    crumbs.splice(0, 1, { label: folderName(root), path: root })
    const rest = dir.slice(root.length).split(/[\\/]/).filter(Boolean)
    let at = root
    for (const part of rest) {
      at = `${at}${at.includes('\\') ? '\\' : '/'}${part}`
      crumbs.push({ label: part, path: at })
    }
  }
  const data = listing.data

  return (
    <nav aria-label="Folders" {...stylex.props(styles.nav)}>
      <div {...stylex.props(text.caption, styles.crumbs)}>
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1
          return (
            <span key={crumb.path ?? 'roots'}>
              {index > 0 && '/ '}
              {last ? (
                <span aria-current="location" {...stylex.props(styles.crumbCurrent)}>
                  {crumb.label}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onDir(crumb.path)}
                  {...stylex.props(text.caption, styles.crumb, focusRing.ring)}
                >
                  {crumb.label}
                </button>
              )}
            </span>
          )
        })}
      </div>
      <div {...stylex.props(styles.rows)}>
        {root && dir && dir !== root && (
          <button
            type="button"
            aria-label="Parent folder"
            onClick={() => onDir(parentFolder(dir))}
            {...stylex.props(text.small, styles.row, focusRing.ring)}
          >
            <span {...stylex.props(styles.rowIcon)}>
              <Icon name="chevron-left" size={14} />
            </span>
            ..
          </button>
        )}
        {listing.isPending && <p {...stylex.props(text.caption, styles.navNote)}>Loading folder…</p>}
        {listing.isError && (
          <p {...stylex.props(text.caption, styles.navNote)}>
            Could not list this folder.{' '}
            <button
              type="button"
              onClick={() => void listing.refetch()}
              {...stylex.props(text.caption, styles.crumb, focusRing.ring)}
            >
              Retry
            </button>
          </p>
        )}
        {data?.state === 'unavailable' && <p {...stylex.props(text.caption, styles.navNote)}>Folder unavailable</p>}
        {data?.state === 'ready' && (
          <>
            {data.folders.map((folder) => (
              <button
                key={folder}
                type="button"
                title={folder}
                onClick={() => onDir(folder)}
                {...stylex.props(text.small, styles.row, focusRing.ring)}
              >
                <span {...stylex.props(styles.rowIcon)}>
                  <Icon name="folder" size={14} />
                </span>
                <span {...stylex.props(styles.rowName, text.truncate)}>{folderName(folder)}</span>
              </button>
            ))}
            {data.files.map((entry) => (
              <button
                key={entry.path}
                type="button"
                title={entry.path}
                aria-current={entry.path === file || undefined}
                onClick={() => onFile(entry.path)}
                {...stylex.props(text.small, styles.row, entry.path === file && styles.rowSelected, focusRing.ring)}
              >
                <span {...stylex.props(styles.rowIcon)}>
                  <Icon name="file" size={14} />
                </span>
                <span {...stylex.props(styles.rowName, text.truncate)}>{baseName(entry.path)}</span>
                <span {...stylex.props(text.caption, styles.rowSize)}>{fileSize(entry.size)}</span>
              </button>
            ))}
            {data.folders.length === 0 && data.files.length === 0 && (
              <p {...stylex.props(text.caption, styles.navNote)}>This folder is empty</p>
            )}
          </>
        )}
      </div>
    </nav>
  )
}

function State({
  icon,
  title,
  detail,
  action,
}: {
  icon: 'alert' | 'offline' | 'file' | 'folder' | 'lock'
  title: string
  detail?: string
  action?: ReactNode
}) {
  return (
    <div role="status" {...stylex.props(styles.state)}>
      <span {...stylex.props(styles.stateIcon)}>
        <Icon name={icon} size={24} />
      </span>
      <span {...stylex.props(text.bodyMedium)}>{title}</span>
      {detail && <span {...stylex.props(text.small, styles.stateDetail)}>{detail}</span>}
      {action}
    </div>
  )
}

const problemIcons: Record<string, 'alert' | 'offline' | 'file' | 'lock'> = {
  offline: 'offline',
  syncing: 'offline',
  outsideFolders: 'lock',
  missing: 'file',
  binary: 'file',
}

function FileContent({
  deviceId,
  path,
  device,
  preview,
  projectId,
  source,
  onBack,
}: {
  deviceId: ID
  path: string
  device: Device | undefined
  preview: ReturnType<typeof useFile>
  projectId: ID | null
  source: PreviewSource | null
  onBack: () => void
}) {
  const workspace = useWorkspace()
  const [selected, setSelected] = useState<{ from: number; to: number } | null>(null)

  const failed = (view: PreviewView, icon: 'alert' | 'offline' | 'file' | 'lock') => (
    <State
      icon={icon}
      title={view.title}
      detail={view.detail}
      action={
        view.action === 'retry' ? (
          <Button small onClick={() => void preview.refetch()}>
            Retry
          </Button>
        ) : (
          <Button small onClick={onBack}>
            Go back
          </Button>
        )
      }
    />
  )

  let body
  if (preview.isPending) {
    body = <State icon="file" title={`Loading ${baseName(path)}…`} />
  } else if (preview.isError) {
    body = failed(readFailure(path, device), 'alert')
  } else if (preview.data.state === 'unavailable') {
    body = failed(previewProblem(preview.data, device)!, problemIcons[preview.data.reason])
  } else {
    const data = preview.data
    const lines = data.content.replace(/\n$/, '').split('\n')
    const describe = (range: Range) => {
      const lineOf = (node: Node) => {
        const element = node instanceof Element ? node : node.parentElement
        const found = element?.closest<HTMLElement>('[data-line]')
        return found ? Number(found.dataset.line) : null
      }
      const from = lineOf(range.startContainer) ?? 1
      const to = lineOf(range.endContainer) ?? lines.length
      if (to < from) return null
      setSelected({ from, to })
      const selectedText = lines.slice(from - 1, to).join('\n')
      if (!projectId) return () => copySelection(selectedText)
      const { excerpt, bytes } = shortenExcerpt(selectedText)
      const reference: Reference = {
        kind: 'file',
        title: baseName(path),
        threadId: source?.threadId ?? null,
        reply: source?.reply ?? null,
        deviceId,
        path,
        lines: { from, to },
        itemId: null,
        excerpt,
        bytes,
      }
      return () => workspace.askProject(projectId, reference)
    }
    body = (
      <>
        <SelectionArea
          label={projectId ? 'Ask project assistant' : 'Copy selection'}
          icon={projectId ? 'reply' : 'copy'}
          describe={describe}
          onHide={() => setSelected(null)}
          style={styles.scroll}
        >
          <div
            aria-label={`Contents of ${baseName(path)}`}
            role="region"
            tabIndex={0}
            {...stylex.props(styles.lines, focusRing.ring)}
          >
            {lines.map((line, index) => {
              const number = index + 1
              const on = selected !== null && number >= selected.from && number <= selected.to
              return (
                <div key={index} data-line={number} {...stylex.props(styles.line, on && styles.lineSelected)}>
                  <span aria-hidden {...stylex.props(styles.gutter)}>
                    {number}
                  </span>
                  <span {...stylex.props(styles.code)}>{line || ' '}</span>
                </div>
              )
            })}
          </div>
          {data.truncated && (
            <div {...stylex.props(text.caption, styles.divider)}>Showing first {fileSize(previewLimit)}</div>
          )}
        </SelectionArea>
        {selected && (
          <span {...stylex.props(text.caption, styles.selectionNote)}>
            {selected.from === selected.to ? `Line ${selected.from}` : `Lines ${selected.from}—${selected.to}`} selected
          </span>
        )}
      </>
    )
  }

  return <div {...stylex.props(styles.content)}>{body}</div>
}
