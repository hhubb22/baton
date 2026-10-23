import * as stylex from '@stylexjs/stylex'
import { useState } from 'react'
import { folderName, parentFolder, type Location } from '../data/derive'
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
      return { title: `${name} is offline`, detail: `Reconnect ${name} to browse its folders.` }
    case 'syncing':
      return { title: `${name} is syncing`, detail: 'Retry when it finishes syncing.' }
    case 'outsideFolders':
      return {
        title: 'Folder is outside allowed paths',
        detail: `${listing.path} is not shared with Baton on ${name}.`,
      }
    case 'missing':
      return { title: `Folder not found on ${name}`, detail: `${listing.path} may have been moved or deleted.` }
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
  const folders = useFolders(selectedDevice, path)
  const device = devices.data?.find((item) => item.id === selectedDevice)
  const listing = folders.data
  const parent = path === null ? null : parentFolder(path)
  const atRoot = path !== null && device?.folders.includes(path)
  const problem = listing?.state === 'unavailable' ? unavailableText(listing, device) : null

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Choose folder"
      description="New chats run in a folder on one device."
      note={path ?? 'Choose an allowed folder.'}
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
      <DeviceFolderForm
        key={selectedDevice}
        deviceId={selectedDevice}
        onAdded={(folder, updated) => {
          const added = updated.folders.find((item) => !device?.folders.includes(item))
          setPath(updated.folders.includes(folder) ? folder : (added ?? folder))
        }}
      />
      <div>
        <div role="group" aria-label="Folders" {...stylex.props(styles.box)}>
          {path === null ? (
            <span {...stylex.props(text.captionMedium, styles.heading)}>Allowed folders</span>
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
                {atRoot || parent === null ? 'Back to allowed folders' : `Back to ${folderName(parent)}`}
              </button>
            </>
          )}
          {folders.isPending && <span {...stylex.props(text.caption, styles.status)}>Loading folders…</span>}
          {folders.isError && (
            <Banner
              icon="alert"
              title="Could not load folders"
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
              detail={problem.detail}
              action={
                <Button small onClick={() => void folders.refetch()}>
                  Retry
                </Button>
              }
            />
          )}
          {listing?.state === 'ready' && listing.folders.length === 0 && (
            <span {...stylex.props(text.caption, styles.status)}>No subfolders</span>
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
        <p {...stylex.props(text.caption, styles.hint)}>
          Add a folder path above or choose from shared folders on this device.
        </p>
      </div>
    </Dialog>
  )
}
