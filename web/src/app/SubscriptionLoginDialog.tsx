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
      title={`${localSetup ? 'Set up' : 'Sign in to'} ${provider} on ${device.name}`}
      description={
        localSetup
          ? `Run these commands on ${device.name} using the same account that connected it to Baton.`
          : signedIn
            ? 'Signed in'
            : 'Open the sign-in page and enter this code. Keep this window open to see when sign-in finishes.'
      }
      note={
        !signedIn && challenge && !start.isPending && !start.isError && !expired
          ? `Expires in ${Math.floor(remaining / 60)}m ${remaining % 60}s`
          : undefined
      }
      finalFocus={() => document.getElementById(`device-row-${device.id}`)}
      actions={<Button onClick={onClose}>{signedIn ? 'Done' : 'Close'}</Button>}
    >
      {localSetup && (
        <>
          {methods.includes('oauth') && (
            <>
              <p {...stylex.props(text.small)}>Sign in with your subscription:</p>
              <pre {...stylex.props(text.mono, styles.code)}>{`batond login ${providerId}`}</pre>
            </>
          )}
        </>
      )}
      {!localSetup && (!signedIn || initiallySignedIn) && (
        <>
          {start.isPending && (
            <p role="status" {...stylex.props(text.small, text.muted)}>
              Getting sign-in code…
            </p>
          )}
          {start.isError && (
            <>
              <p role="alert" {...stylex.props(text.small, styles.error)}>
                Couldn't start sign-in. Try again.
              </p>
              <Button onClick={retry}>Retry sign-in</Button>
            </>
          )}
          {!start.isPending &&
            !start.isError &&
            challenge &&
            (expired ? (
              <>
                <p role="status" {...stylex.props(text.small, text.muted)}>
                  Sign-in code expired. Get a new code to continue.
                </p>
                <Button onClick={retry}>Get a new code</Button>
              </>
            ) : (
              <>
                <div aria-label="Sign-in code" {...stylex.props(text.mono, styles.code)}>
                  {challenge.userCode}
                </div>
                <div {...stylex.props(styles.actions)}>
                  <Button onClick={() => void copyCode()}>Copy code</Button>
                  <a
                    href={challenge.verificationUri}
                    target="_blank"
                    rel="noreferrer"
                    {...stylex.props(text.small, styles.link)}
                  >
                    Open sign-in page
                  </a>
                </div>
                {copy && (
                  <p role="status" {...stylex.props(text.caption, copy === 'failed' ? styles.error : text.muted)}>
                    {copy === 'copied' ? 'Code copied' : 'Clipboard blocked. Copy it manually.'}
                  </p>
                )}
                {device.connection !== 'online' && (
                  <p role="status" {...stylex.props(text.small, text.muted)}>
                    Reconnect {device.name} to check sign-in status.
                  </p>
                )}
              </>
            ))}
        </>
      )}
    </Dialog>
  )
}
