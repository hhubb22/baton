import * as stylex from '@stylexjs/stylex'
import { useEffect, useRef, useState } from 'react'
import { useStartSubscriptionLogin } from '../data/queries'
import type { Device } from '../data/types'
import { text } from '../theme/text'
import { colors, radius, space } from '../theme/tokens.stylex'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { useNow } from './useNow'

const styles = stylex.create({
  code: {
    padding: space.lg,
    backgroundColor: colors.code,
    borderRadius: radius.md,
    textAlign: 'center',
    userSelect: 'all',
  },
  actions: { display: 'flex', alignItems: 'center', gap: space.md },
  link: { color: colors.accentText },
  error: { color: colors.danger },
})

export function SubscriptionLoginDialog({
  device,
  provider,
  localOnly = false,
  onClose,
}: {
  device: Device
  provider: string
  localOnly?: boolean
  onClose: () => void
}) {
  const start = useStartSubscriptionLogin()
  const { mutate } = start
  const requested = useRef(false)
  const [receivedAt, setReceivedAt] = useState(0)
  const [copy, setCopy] = useState<'copied' | 'failed' | null>(null)
  const now = useNow(1000)
  const subscription = device.subscriptions.find((sub) => sub.provider === provider)
  const methods = subscription?.loginMethods ?? []
  const localSetup = localOnly || !methods.includes('device_code')
  const providerId = subscription?.providerId ?? provider
  const signedIn = subscription?.signedIn === true
  const [initiallySignedIn] = useState(signedIn)
  const challenge = start.data
  const remaining = challenge
    ? Math.max(0, Math.ceil((challenge.expiresInSeconds * 1000 - Math.max(0, now - receivedAt)) / 1000))
    : 0
  const expired = challenge !== undefined && remaining === 0

  useEffect(() => {
    if (requested.current || localSetup) return
    requested.current = true
    mutate({ deviceId: device.id, provider }, { onSuccess: () => setReceivedAt(Date.now()) })
  }, [device.id, provider, mutate, localSetup])

  const retry = () => {
    setCopy(null)
    mutate({ deviceId: device.id, provider }, { onSuccess: () => setReceivedAt(Date.now()) })
  }
  const copyCode = async () => {
    if (!challenge) return
    try {
      if (!navigator.clipboard) throw new Error('剪贴板不可用')
      await navigator.clipboard.writeText(challenge.userCode)
      setCopy('copied')
    } catch {
      setCopy('failed')
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`在 ${device.name} 上${localSetup ? '设置' : '登录'} ${provider}`}
      description={
        localSetup
          ? `请使用连接 Baton 的同一账号，在 ${device.name} 上运行这些命令。`
          : signedIn
            ? '已登录'
            : '打开登录页面并输入此代码。请保持窗口打开，以便查看登录结果。'
      }
      note={
        !signedIn && challenge && !start.isPending && !start.isError && !expired
          ? `${Math.floor(remaining / 60)} 分 ${remaining % 60} 秒后过期`
          : undefined
      }
      finalFocus={() => document.getElementById(`device-row-${device.id}`)}
      actions={<Button onClick={onClose}>{signedIn ? '完成' : '关闭'}</Button>}
    >
      {localSetup && (
        <>
          {methods.includes('oauth') && (
            <>
              <p {...stylex.props(text.small)}>使用订阅登录：</p>
              <pre {...stylex.props(text.mono, styles.code)}>{`batond login ${providerId}`}</pre>
            </>
          )}
        </>
      )}
      {!localSetup && (!signedIn || initiallySignedIn) && (
        <>
          {start.isPending && (
            <p role="status" {...stylex.props(text.small, text.muted)}>
              正在获取登录码…
            </p>
          )}
          {start.isError && (
            <>
              <p role="alert" {...stylex.props(text.small, styles.error)}>
                无法开始登录，请重试。
              </p>
              <Button onClick={retry}>重新登录</Button>
            </>
          )}
          {!start.isPending &&
            !start.isError &&
            challenge &&
            (expired ? (
              <>
                <p role="status" {...stylex.props(text.small, text.muted)}>
                  登录码已过期，请获取新码后继续。
                </p>
                <Button onClick={retry}>获取新验证码</Button>
              </>
            ) : (
              <>
                <div aria-label="登录码" {...stylex.props(text.mono, styles.code)}>
                  {challenge.userCode}
                </div>
                <div {...stylex.props(styles.actions)}>
                  <Button onClick={() => void copyCode()}>复制验证码</Button>
                  <a
                    href={challenge.verificationUri}
                    target="_blank"
                    rel="noreferrer"
                    {...stylex.props(text.small, styles.link)}
                  >
                    打开登录页面
                  </a>
                </div>
                {copy && (
                  <p role="status" {...stylex.props(text.caption, copy === 'failed' ? styles.error : text.muted)}>
                    {copy === 'copied' ? '代码已复制' : '无法访问剪贴板，请手动复制。'}
                  </p>
                )}
                {device.connection !== 'online' && (
                  <p role="status" {...stylex.props(text.small, text.muted)}>
                    请重新连接 {device.name}，以检查登录状态。
                  </p>
                )}
              </>
            ))}
        </>
      )}
    </Dialog>
  )
}
