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
  const failure = error ?? (expired ? '设置码已过期，请重试。' : null)
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
        throw new Error('请在浏览器中重新连接此设备。')
      if (status.registered && !needsDesktopReauth(status, devices.data ?? [])) {
        setAccepted(true)
        return
      }
      const nodeId = status.registered ? status.node_id : undefined
      let issued = await client.createEnrollment(nodeId)
      if (issued.state === 'expired' || issued.expiresIn <= 0) issued = await client.createEnrollment(nodeId)
      setEnrollmentId(issued.id)
      if (issued.state !== 'pending' || issued.expiresIn <= 0) throw new Error('设置码已过期，请重试。')
      secret = issued.code
      if (!secret) throw new Error('未生成设置码，请重试。')
      const result = status.registered
        ? await desktop.bridge.reauth({ code: secret })
        : await desktop.bridge.enroll({ code: secret, ...(name.trim() ? { displayName: name.trim() } : {}) })
      desktop.update(result)
      if (result.state === 'rejected' || result.connection_state === 'rejected') {
        setError((desktopStatusReason(result) ?? '无法连接此电脑，请重试。').replaceAll(secret, '[hidden]'))
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
      title={accepted || connected ? '此电脑' : reauth ? '重新连接此电脑' : '连接此电脑'}
      finalFocus={finalFocus}
      note={busy ? '正在连接…' : current ? desktopStatusLabel(current) : '正在检查此电脑…'}
      actions={
        <>
          <Button onClick={onClose}>{connected || accepted ? '完成' : '关闭'}</Button>
          {(!accepted || expired || current?.code === 'needs_reauth') && canConnect && (
            <Button variant="primary" aria-busy={busy} onClick={() => void connect()}>
              {failure ? '重试' : reauth ? '重新连接' : '连接'}
            </Button>
          )}
          {desktop.isError && <Button onClick={() => void desktop.refetch()}>重试</Button>}
        </>
      }
    >
      {!reauth && (
        <div {...stylex.props(styles.field)}>
          <label htmlFor="desktop-device-name" {...stylex.props(text.label)}>
            设备名称
          </label>
          <Input
            id="desktop-device-name"
            value={name}
            placeholder="电脑名称"
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
            ? '请在浏览器中重新连接此设备。'
            : (failure ?? (desktop.isError ? '无法读取此电脑的状态，请重试。' : reason))}
        </p>
      )}
    </Dialog>
  )
}
