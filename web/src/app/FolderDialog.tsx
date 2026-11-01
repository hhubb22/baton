import * as stylex from '@stylexjs/stylex'
import { useState } from 'react'
import type { Location } from '../data/derive'
import { fileName as folderName, fileParent as parentFolder } from '../data/file-paths'
import { useDevices, useFolders, useRemoveDeviceFolder } from '../data/queries'
import type { Device, FolderListing, ID } from '../data/types'
import { text } from '../theme/text'
import { semantic } from '../theme/semantic.stylex'
import { radius, space } from '../theme/tokens.stylex'
import { Banner } from '../ui/Banner'
import { Button, focusRing } from '../ui/Button'
import { Dialog, DialogClose } from '../ui/Dialog'
import { Field } from '../ui/Field'
import { Icon } from '../ui/Icon'
import { Select } from '../ui/Select'
import { Tooltip } from '../ui/Tooltip'
import { DeviceFolderForm } from './DeviceFolderForm'
import { useLocalDirectoryPicker } from './LocalDirectoryPicker'

const styles = stylex.create({
  box: {
    display: 'flex',
    flexDirection: 'column',
    height: '264px',
    overflowY: 'auto',
    padding: space.xs,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: semantic.input,
    borderRadius: radius.md,
  },
  heading: { paddingBlock: '6px', paddingInline: space.sm, color: semantic.faintForeground },
  path: { paddingBlock: '6px', paddingInline: space.sm, color: semantic.mutedForeground },
  root: { display: 'flex', alignItems: 'center', gap: space.xs },
  folderChoice: { flexGrow: 1, minWidth: 0, width: 'auto' },
  remove: {
    flexShrink: 0,
    paddingBlock: space.xs,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: 'transparent', ':hover': semantic.muted },
    color: semantic.destructiveForeground,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    width: '100%',
    minHeight: '32px',
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: 'transparent', ':hover': semantic.muted },
    color: semantic.foreground,
    textAlign: 'left',
  },
  back: { color: semantic.mutedForeground },
  glyph: { color: semantic.mutedForeground, flexShrink: 0 },
  name: { flexGrow: 1 },
  status: { padding: space.sm, color: semantic.faintForeground },
  hint: { color: semantic.faintForeground },
  error: { color: semantic.destructiveForeground },
})

function unavailableText(listing: Extract<FolderListing, { state: 'unavailable' }>, device: Device | undefined) {
  const name = device?.name ?? '此设备'
  switch (listing.reason) {
    case 'offline':
      return { title: `${name} 已离线`, detail: '' }
    case 'syncing':
      return { title: `${name} 正在同步`, detail: '' }
    case 'outsideFolders':
      return { title: '链接指向设备允许的文件夹之外', detail: listing.path }
    case 'missing':
      return { title: `无法读取 ${listing.path}`, detail: '' }
  }
}

// 浏览设备上允许 Agent 访问的目录，选中一个目录作为新对话的位置。
export function FolderDialog({
  deviceId,
  onClose,
  onSelect,
}: {
  deviceId: ID
  onClose: () => void
  onSelect: (location: Location) => void
}) {
  const devices = useDevices()
  const [selectedDevice, setSelectedDevice] = useState(deviceId)
  const [path, setPath] = useState<string | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const local = useLocalDirectoryPicker({ nodeId: selectedDevice, onSelect, onError: setLocalError })
  const folders = useFolders(selectedDevice, path)
  const allowed = useFolders(selectedDevice, null)
  const remove = useRemoveDeviceFolder()
  const device = devices.data?.find((item) => item.id === selectedDevice)
  const listing = folders.data
  const parent = path === null ? null : parentFolder(path)
  const roots = allowed.data?.state === 'ready' ? allowed.data.folders : (device?.folders ?? [])
  const atRoot = path !== null && roots.includes(path)
  const problem = listing?.state === 'unavailable' ? unavailableText(listing, device) : null

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="选择文件夹"
      note={path ?? undefined}
      actions={
        <>
          <DialogClose render={<Button>取消</Button>} />
          <Button
            variant={path === null ? 'secondary' : 'primary'}
            onClick={() => path !== null && onSelect({ deviceId: selectedDevice, folder: path })}
          >
            选择文件夹
          </Button>
        </>
      }
    >
      <Field label="设备">
        {(props) => (
          <Select
            {...props}
            value={selectedDevice}
            onChange={(next) => {
              setSelectedDevice(next)
              setPath(null)
              setLocalError(null)
              remove.reset()
            }}
            options={(devices.data ?? []).map((item) => ({
              value: item.id,
              label: item.connection === 'online' ? item.name : `${item.name} (${item.connection})`,
            }))}
          />
        )}
      </Field>
      {local.available && (
        <Button small icon="folder" onClick={() => void local.pick()}>
          {local.label}
        </Button>
      )}
      {localError && <Banner icon="alert" title={localError} />}
      <div>
        <div role="group" aria-label="文件夹" {...stylex.props(styles.box)}>
          {path === null ? (
            <span {...stylex.props(text.captionMedium, styles.heading)}>用过的位置</span>
          ) : (
            <>
              <Tooltip label={path} align="start">
                <span {...stylex.props(text.mono, styles.path, text.truncate)}>{path}</span>
              </Tooltip>
              <button
                type="button"
                onClick={() => setPath(atRoot ? null : parent)}
                {...stylex.props(text.small, styles.row, styles.back, focusRing.ring)}
              >
                <Icon name="chevron-left" size={14} />
                {atRoot || parent === null ? '返回用过的位置' : `返回 ${folderName(parent)}`}
              </button>
            </>
          )}
          {folders.isPending && <span {...stylex.props(text.caption, styles.status)}>正在加载文件夹…</span>}
          {folders.isError && (
            <Banner
              icon="alert"
              title="无法加载文件夹"
              action={
                <Button small onClick={() => void folders.refetch()}>
                  重试
                </Button>
              }
            />
          )}
          {problem && (
            <Banner
              icon="offline"
              title={problem.title}
              detail={problem.detail || undefined}
              action={
                <Button small onClick={() => void folders.refetch()}>
                  重试
                </Button>
              }
            />
          )}
          {listing?.state === 'ready' && listing.scanLimited && (
            <span role="status" {...stylex.props(text.caption, styles.status)}>
              文件夹扫描受到限制，部分内容可能未显示。{' '}
              <Button small onClick={() => void folders.refetch()}>
                重试
              </Button>
            </span>
          )}
          {listing?.state === 'ready' && !listing.scanLimited && listing.folders.length === 0 && (
            <span {...stylex.props(text.caption, styles.status)}>
              {path === null ? `${device?.name ?? '此设备'} 还没有用过的位置。请在下方输入路径添加。` : '没有子文件夹'}
            </span>
          )}
          {listing?.state === 'ready' &&
            listing.folders.map((folder) => (
              <div key={folder} {...stylex.props(styles.root)}>
                <button
                  type="button"
                  onClick={() => setPath(folder)}
                  {...stylex.props(text.small, styles.row, styles.folderChoice, focusRing.ring)}
                >
                  <Icon name="folder" size={15} style={styles.glyph} />
                  <span {...stylex.props(path === null ? text.mono : null, styles.name, text.truncate)}>
                    {path === null ? folder : folderName(folder)}
                  </span>
                  <Icon name="chevron-right" size={14} style={styles.glyph} />
                </button>
                {path === null && (
                  <button
                    type="button"
                    aria-label={`移除 ${folder}`}
                    aria-disabled={remove.isPending || undefined}
                    onClick={() => {
                      if (!remove.isPending) remove.mutate({ deviceId: selectedDevice, path: folder })
                    }}
                    {...stylex.props(text.small, styles.remove, focusRing.ring)}
                  >
                    移除
                  </button>
                )}
              </div>
            ))}
          {remove.isError && (
            <p role="alert" {...stylex.props(text.caption, styles.status, styles.error)}>
              无法移除文件夹，请重试。
            </p>
          )}
        </div>
      </div>
      <DeviceFolderForm
        key={selectedDevice}
        deviceId={selectedDevice}
        deviceName={device?.name ?? '此设备'}
        onAdded={(folder, updated) => {
          const added = updated.folders.find((item) => !device?.folders.includes(item))
          onSelect({ deviceId: selectedDevice, folder: updated.folders.includes(folder) ? folder : (added ?? folder) })
        }}
      />
    </Dialog>
  )
}
