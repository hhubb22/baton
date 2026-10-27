import * as stylex from '@stylexjs/stylex'
import { useState } from 'react'
import type { Location } from '../data/derive'
import { fileName as folderName, fileParent as parentFolder } from '../data/file-paths'
import { useDevices, useFolders } from '../data/queries'
import type { Device, FolderListing, ID } from '../data/types'
import { text } from '../theme/text'
import { colors, radius, size, space } from '../theme/tokens.stylex'
import { Banner } from '../ui/Banner'
import { Button, focusRing } from '../ui/Button'
import { Dialog, DialogClose } from '../ui/Dialog'
import { Field } from '../ui/Field'
import { Icon } from '../ui/Icon'
import { DeviceFolderForm } from './DeviceFolderForm'
import { useLocalDirectoryPicker } from './LocalDirectoryPicker'

const styles = stylex.create({
  select: {
    width: '100%',
    height: size.control,
    paddingInline: '10px',
    backgroundColor: colors.surface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: { default: colors.border, ':focus': colors.focus },
    borderRadius: radius.sm,
    outline: 'none',
    color: colors.text,
  },
  box: {
    display: 'flex',
    flexDirection: 'column',
    height: '264px',
    overflowY: 'auto',
    padding: space.xs,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    borderRadius: radius.md,
  },
  heading: { paddingBlock: '6px', paddingInline: space.sm, color: colors.faint },
  path: { paddingBlock: '6px', paddingInline: space.sm, color: colors.muted },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    width: '100%',
    minHeight: '32px',
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: 'transparent', ':hover': colors.hover },
    color: colors.text,
    textAlign: 'left',
  },
  back: { color: colors.muted },
  glyph: { color: colors.muted, flexShrink: 0 },
  name: { flexGrow: 1 },
  status: { padding: space.sm, color: colors.faint },
  hint: { color: colors.faint },
})

function unavailableText(listing: Extract<FolderListing, { state: 'unavailable' }>, device: Device | undefined) {
  const name = device?.name ?? 'This device'
  switch (listing.reason) {
    case 'offline':
      return { title: `${name} is offline`, detail: '' }
    case 'syncing':
      return { title: `${name} is syncing`, detail: '' }
    case 'outsideFolders':
      return { title: "Link points outside the device's folders", detail: listing.path }
    case 'missing':
      return { title: `Couldn't read ${listing.path}`, detail: '' }
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
      title="Choose folder"
      note={path ?? undefined}
      actions={
        <>
          <DialogClose render={<Button>Cancel</Button>} />
          <Button
            variant={path === null ? 'secondary' : 'primary'}
            onClick={() => path !== null && onSelect({ deviceId: selectedDevice, folder: path })}
          >
            Select folder
          </Button>
        </>
      }
    >
      <Field label="Device">
        {(props) => (
          <select
            {...props}
            value={selectedDevice}
            onChange={(event) => {
              setSelectedDevice(event.target.value)
              setPath(null)
              setLocalError(null)
            }}
            {...stylex.props(text.small, styles.select)}
          >
            {devices.data?.map((item) => (
              <option key={item.id} value={item.id}>
                {item.connection === 'online' ? item.name : `${item.name} (${item.connection})`}
              </option>
            ))}
          </select>
        )}
      </Field>
      {local.available && (
        <Button small icon="folder" onClick={() => void local.pick()}>
          {local.label}
        </Button>
      )}
      {localError && <Banner icon="alert" title={localError} />}
      <div>
        <div role="group" aria-label="Folders" {...stylex.props(styles.box)}>
          {path === null ? (
            <span {...stylex.props(text.captionMedium, styles.heading)}>Folders</span>
          ) : (
            <>
              <span title={path} {...stylex.props(text.mono, styles.path, text.truncate)}>
                {path}
              </span>
              <button
                type="button"
                onClick={() => setPath(atRoot ? null : parent)}
                {...stylex.props(text.small, styles.row, styles.back, focusRing.ring)}
              >
                <Icon name="chevron-left" size={14} />
                {atRoot || parent === null ? 'Back to folders' : `Back to ${folderName(parent)}`}
              </button>
            </>
          )}
          {folders.isPending && <span {...stylex.props(text.caption, styles.status)}>Loading folders…</span>}
          {folders.isError && (
            <Banner
              icon="alert"
              title="Couldn't load folders"
              action={
                <Button small onClick={() => void folders.refetch()}>
                  Retry
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
                  Retry
                </Button>
              }
            />
          )}
          {listing?.state === 'ready' && listing.scanLimited && (
            <span role="status" {...stylex.props(text.caption, styles.status)}>
              Folder scan limited. Some entries may be missing.{' '}
              <Button small onClick={() => void folders.refetch()}>
                Retry
              </Button>
            </span>
          )}
          {listing?.state === 'ready' && !listing.scanLimited && listing.folders.length === 0 && (
            <span {...stylex.props(text.caption, styles.status)}>
              {path === null
                ? `No folders on ${device?.name ?? 'this device'} yet. Type a path below to add one.`
                : 'No subfolders'}
            </span>
          )}
          {listing?.state === 'ready' &&
            listing.folders.map((folder) => (
              <button
                key={folder}
                type="button"
                onClick={() => setPath(folder)}
                {...stylex.props(text.small, styles.row, focusRing.ring)}
              >
                <Icon name="folder" size={15} style={styles.glyph} />
                <span {...stylex.props(path === null ? text.mono : null, styles.name, text.truncate)}>
                  {path === null ? folder : folderName(folder)}
                </span>
                <Icon name="chevron-right" size={14} style={styles.glyph} />
              </button>
            ))}
        </div>
      </div>
      <DeviceFolderForm
        key={selectedDevice}
        deviceId={selectedDevice}
        deviceName={device?.name ?? 'this device'}
        onAdded={(folder, updated) => {
          const added = updated.folders.find((item) => !device?.folders.includes(item))
          onSelect({ deviceId: selectedDevice, folder: updated.folders.includes(folder) ? folder : (added ?? folder) })
        }}
      />
    </Dialog>
  )
}
