import * as stylex from '@stylexjs/stylex'
import { useState } from 'react'
import { useAddDeviceFolder } from '../data/queries'
import type { Device, ID } from '../data/types'
import { text } from '../theme/text'
import { colors, space } from '../theme/tokens.stylex'
import { Button } from '../ui/Button'
import { Input } from '../ui/Field'

const styles = stylex.create({
  form: { display: 'flex', flexDirection: 'column', gap: space.xs },
  row: { display: 'flex', alignItems: 'center', gap: space.sm },
  input: { minWidth: 0, flexGrow: 1 },
  error: { color: colors.danger },
})

export function DeviceFolderForm({
  deviceId,
  onAdded,
}: {
  deviceId: ID
  onAdded?: (path: string, device: Device) => void
}) {
  const add = useAddDeviceFolder()
  const [path, setPath] = useState('')
  const [empty, setEmpty] = useState(false)
  return (
    <form
      aria-label="Add allowed folder"
      {...stylex.props(styles.form)}
      onSubmit={(event) => {
        event.preventDefault()
        if (add.isPending) return
        const folder = path.trim()
        if (!folder) {
          setEmpty(true)
          return
        }
        setEmpty(false)
        add.mutate(
          { deviceId, path: folder },
          {
            onSuccess: (device) => {
              setPath('')
              onAdded?.(folder, device)
            },
          },
        )
      }}
    >
      <div {...stylex.props(styles.row)}>
        <Input
          aria-label="Folder path"
          placeholder="/path/to/folder"
          value={path}
          style={styles.input}
          onChange={(event) => {
            setPath(event.target.value)
            setEmpty(false)
            if (add.isError) add.reset()
          }}
        />
        <Button type="submit" aria-disabled={add.isPending || undefined}>
          {add.isPending ? 'Adding…' : 'Add folder'}
        </Button>
      </div>
      {(empty || add.isError) && (
        <p role="alert" {...stylex.props(text.caption, styles.error)}>
          {empty
            ? 'Enter a folder path.'
            : 'Could not add folder. Check the path and device connection, then try again.'}
        </p>
      )}
    </form>
  )
}
