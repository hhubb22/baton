import * as stylex from '@stylexjs/stylex'
import { useEffect, useRef, useState } from 'react'
import {
  desktopErrorMessage,
  desktopStatusLabel,
  desktopStatusReason,
  useDesktopStatus,
  type DesktopLogin,
} from '../data/desktop'
import { useClient } from '../data/queries'
import { text } from '../theme/text'
import { semantic } from '../theme/semantic.stylex'
import { radius, space } from '../theme/tokens.stylex'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'

const styles = stylex.create({
  device: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.sm,
    padding: space.lg,
    backgroundColor: semantic.sidebar,
    borderRadius: radius.md,
  },
  code: { letterSpacing: '0.12em' },
  error: { color: semantic.destructiveForeground },
})

function expiry(seconds: number) {
  return `${Math.max(1, Math.ceil(seconds / 60))} 分钟内有效`
}

function systemLabel(system: string | undefined) {
  if (system === 'macos') return 'macOS'
  if (system === 'windows') return 'Windows'
  if (system === 'linux') return 'Linux'
  return system ?? ''
}

export function DesktopConnectDialog({
  onClose,
  finalFocus,
}: {
  onClose: () => void
  finalFocus?: () => HTMLElement | null | boolean
}) {
  const desktop = useDesktopStatus()
  const client = useClient()
  const bridge = desktop.bridge
  const current = desktop.data
  const [login, setLogin] = useState<DesktopLogin | null>(null)
  const [device, setDevice] = useState<{ display_name: string; system: string } | null>(null)
  const [phase, setPhase] = useState<'starting' | 'pending' | 'approving' | 'approved' | 'failed'>('starting')
  const [error, setError] = useState<string | null>(null)
  const approvedRef = useRef(false)
  const closed = useRef(false)
  const reason = current && desktopStatusReason(current)
  const connected = phase === 'approved' || current?.state === 'online' || current?.registered === true

  useEffect(() => {
    if (!bridge) return
    let cancelled = false
    void (async () => {
      try {
        const result = await bridge.startLogin({})
        if (cancelled) {
          if (result.status === 'pending') await bridge.cancelLogin().catch(() => {})
          return
        }
        if (result.status === 'already_bound') {
          approvedRef.current = true
          setPhase('approved')
          return
        }
        setLogin(result.login)
        setPhase('pending')
        void client
          .getDeviceLoginSession(result.login.user_code)
          .then((session) => {
            if (!cancelled) setDevice({ display_name: session.display_name, system: session.system })
          })
          .catch(() => {})
        if (closed.current) await bridge.cancelLogin().catch(() => {})
      } catch (cause) {
        if (!cancelled) {
          setError(desktopErrorMessage(cause))
          setPhase('failed')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [bridge, client])

  const close = () => {
    if (!closed.current && login && !approvedRef.current) void bridge?.cancelLogin().catch(() => {})
    closed.current = true
    onClose()
  }

  const approve = async () => {
    if (!login || phase === 'approving') return
    setError(null)
    setPhase('approving')
    try {
      await client.approveDeviceLoginSession(login.session_id, login.user_code)
      approvedRef.current = true
      setPhase('approved')
    } catch (cause) {
      setError(desktopErrorMessage(cause, login.user_code))
      setPhase('failed')
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
      title="连接这台电脑"
      finalFocus={finalFocus}
      note={current ? desktopStatusLabel(current) : '正在检查此电脑…'}
      actions={
        <>
          <Button onClick={close}>{connected ? '完成' : '取消'}</Button>
          {login && phase !== 'approved' && (
            <Button variant="primary" aria-busy={phase === 'approving'} onClick={() => void approve()}>
              {phase === 'approving' ? '正在允许…' : '允许登录'}
            </Button>
          )}
        </>
      }
    >
      {phase === 'starting' && <p {...stylex.props(text.small, text.muted)}>正在准备设备登录…</p>}
      {login && phase !== 'approved' && (
        <div {...stylex.props(styles.device)}>
          <span {...stylex.props(text.label)}>{device?.display_name ?? current?.display_name ?? '这台电脑'}</span>
          {(device?.system ?? current?.platform) && (
            <span {...stylex.props(text.small, text.muted)}>{systemLabel(device?.system ?? current?.platform)}</span>
          )}
          <code {...stylex.props(text.title, styles.code)}>{login.user_code}</code>
          <span {...stylex.props(text.small, text.muted)}>{expiry(login.expires_in_seconds)}</span>
          <p {...stylex.props(text.small, text.muted)}>确认短码与此电脑上显示的一致后再允许登录。</p>
        </div>
      )}
      {phase === 'approved' && (
        <p role="status" {...stylex.props(text.small)}>
          {current?.state === 'online' || current?.registered
            ? '此电脑已连接。'
            : '已允许登录，正在完成连接。可以关闭此窗口。'}
        </p>
      )}
      {(error || reason || desktop.isError) && (
        <p role="alert" {...stylex.props(text.small, styles.error)}>
          {error ?? (desktop.isError ? '无法读取此电脑的状态，请重试。' : reason)}
        </p>
      )}
    </Dialog>
  )
}
