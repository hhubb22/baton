import * as stylex from '@stylexjs/stylex'
import { useRef, useState } from 'react'
import {
  desktopErrorMessage,
  desktopStatusLabel,
  desktopStatusReason,
  needsDesktopReauth,
  useDesktopStatus,
} from '../data/desktop'
import { useClient, useDevices, useEnrollment } from '../data/queries'
import type { Device } from '../data/types'
import { text } from '../theme/text'
import { colors, space } from '../theme/tokens.stylex'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Input } from '../ui/Field'

const styles = stylex.create({
  field: { display: 'flex', flexDirection: 'column', gap: space.sm },
  error: { color: colors.danger },
})

export function DesktopEnrollDialog({
  device,
  onClose,
  finalFocus,
}: {
  device?: Device
  onClose: () => void
  finalFocus?: () => HTMLElement | null | boolean
}) {
  const desktop = useDesktopStatus()
  const client = useClient()
  const devices = useDevices()
  const [name, setName] = useState('')
  const [enrollmentId, setEnrollmentId] = useState<string | null>(null)
  const enrollment = useEnrollment(enrollmentId)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const sending = useRef(false)
  const current = desktop.data
  const reauth = current?.registered === true
  const foreign = device && (!current?.registered || device.id !== current.node_id)
  const expired = enrollment.data?.state === 'expired'
  const connected = enrollment.data?.state === 'connected'
  const canConnect = current && !foreign && (!current.registered || needsDesktopReauth(current, devices.data ?? []))
  const failure = error ?? (expired ? 'Setup code expired. Try again.' : null)
  const reason = current && desktopStatusReason(current)

  const connect = async () => {
    if (sending.current || !desktop.bridge) return
    sending.current = true
    setBusy(true)
    setError(null)
    setAccepted(false)
    let secret = ''
    try {
      const status = await desktop.bridge.status()
      desktop.update(status)
      if (device && (!status.registered || device.id !== status.node_id))
        throw new Error('Reconnect this device in a browser.')
      if (status.registered && !needsDesktopReauth(status, devices.data ?? [])) {
        setAccepted(true)
        return
      }
      const nodeId = status.registered ? status.node_id : undefined
      let issued = await client.createEnrollment(nodeId)
      if (issued.state === 'expired' || issued.expiresIn <= 0) issued = await client.createEnrollment(nodeId)
      setEnrollmentId(issued.id)
      if (issued.state !== 'pending' || issued.expiresIn <= 0) throw new Error('Setup code expired. Try again.')
      secret = issued.code
      if (!secret) throw new Error('No setup code was issued. Try again.')
      const result = status.registered
        ? await desktop.bridge.reauth({ code: secret })
        : await desktop.bridge.enroll({ code: secret, ...(name.trim() ? { displayName: name.trim() } : {}) })
      desktop.update(result)
      if (result.state === 'rejected' || result.connection_state === 'rejected') {
        setError(
          (desktopStatusReason(result) ?? 'Could not connect this computer. Try again.').replaceAll(secret, '[hidden]'),
        )
      } else setAccepted(result.registered)
    } catch (cause) {
      // 桥接异常也可能包含输入，接入口令在写入界面状态前移除。
      setError(desktopErrorMessage(cause, secret))
    } finally {
      sending.current = false
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={accepted || connected ? 'This computer' : reauth ? 'Reconnect this computer' : 'Connect this computer'}
      finalFocus={finalFocus}
      note={busy ? 'Connecting…' : current ? desktopStatusLabel(current) : 'Checking this computer…'}
      actions={
        <>
          <Button onClick={onClose}>{connected || accepted ? 'Done' : 'Close'}</Button>
          {(!accepted || expired || current?.code === 'needs_reauth') && canConnect && (
            <Button variant="primary" aria-busy={busy} onClick={() => void connect()}>
              {failure ? 'Try again' : reauth ? 'Reconnect' : 'Connect'}
            </Button>
          )}
          {desktop.isError && <Button onClick={() => void desktop.refetch()}>Try again</Button>}
        </>
      }
    >
      {!reauth && (
        <div {...stylex.props(styles.field)}>
          <label htmlFor="desktop-device-name" {...stylex.props(text.label)}>
            Device name
          </label>
          <Input
            id="desktop-device-name"
            value={name}
            placeholder="Computer name"
            autoComplete="off"
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
      )}
      {reauth && <span {...stylex.props(text.label)}>{current.display_name}</span>}
      {(failure || foreign || desktop.isError || reason) && (
        <p role="alert" {...stylex.props(text.small, styles.error)}>
          {foreign
            ? 'Reconnect this device in a browser.'
            : (failure ?? (desktop.isError ? "Couldn't read this computer's status. Try again." : reason))}
        </p>
      )}
    </Dialog>
  )
}
