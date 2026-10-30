import * as stylex from '@stylexjs/stylex'
import { useState } from 'react'
import { useAddDeviceFolder } from '../data/queries'
import type { Device, ID } from '../data/types'
import { text } from '../theme/text'
import { semantic } from '../theme/semantic.stylex'
import { space } from '../theme/tokens.stylex'
import { Button } from '../ui/Button'
import { Input } from '../ui/Field'

const styles = stylex.create({
  form: { display: 'flex', flexDirection: 'column', gap: space.xs },
  row: { display: 'flex', alignItems: 'center', gap: space.sm },
  input: { minWidth: 0, flexGrow: 1 },
  error: { color: semantic.destructiveForeground },
  hint: { color: semantic.faintForeground },
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
      aria-label="添加文件夹"
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
          aria-label="文件夹路径"
          placeholder="或输入路径，例如 ~/work/app"
          value={path}
          style={styles.input}
          onChange={(event) => {
            setPath(event.target.value)
            setEmpty(false)
            if (add.isError) add.reset()
          }}
        />
        <Button type="submit" aria-disabled={add.isPending || undefined}>
          {add.isPending ? '正在添加…' : '添加并选择'}
        </Button>
      </div>
      {empty || add.isError ? (
        <p role="alert" {...stylex.props(text.caption, styles.error)}>
          {empty ? '请输入文件夹路径。' : '无法添加文件夹，请检查路径后重试。'}
        </p>
      ) : (
        path.trim() && <p {...stylex.props(text.caption, styles.hint)}>将此文件夹添加到 {deviceName}。</p>
      )}
    </form>
  )
}
