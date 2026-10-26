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
  hint: { color: colors.faint },
})

export function DeviceFolderForm({
  deviceId,
  deviceName,
  onAdded,
}: {
  deviceId: ID
  deviceName: string
  onAdded?: (path: string, device: Device) => void
}) {
  const add = useAddDeviceFolder()
  const [path, setPath] = useState('')
  const [empty, setEmpty] = useState(false)
  return (
    <form
      aria-label="Add folder"
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
          placeholder="Or type a path, e.g. ~/work/app"
          value={path}
          style={styles.input}
          onChange={(event) => {
            setPath(event.target.value)
            setEmpty(false)
            if (add.isError) add.reset()
          }}
        />
        <Button type="submit" aria-disabled={add.isPending || undefined}>
          {add.isPending ? 'Adding…' : 'Add and select'}
        </Button>
      </div>
      {empty || add.isError ? (
        <p role="alert" {...stylex.props(text.caption, styles.error)}>
          {empty ? 'Enter a folder path.' : "Couldn't add the folder. Check the path and try again."}
        </p>
      ) : (
        path.trim() && <p {...stylex.props(text.caption, styles.hint)}>Adds this folder to {deviceName}.</p>
      )}
    </form>
  )
}
