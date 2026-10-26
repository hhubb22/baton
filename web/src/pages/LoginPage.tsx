import * as stylex from '@stylexjs/stylex'
import { Navigate, useRouter, useSearch } from '@tanstack/react-router'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { AuthShell } from '../app/AuthShell'
import type { LoginNotice } from '../app/router'
import { ClientError } from '../data/client'
import { useSession, useSignIn } from '../data/queries'
import { text } from '../theme/text'
import { colors, space } from '../theme/tokens.stylex'
import { BrandMark } from '../ui/BrandMark'
import { Button } from '../ui/Button'
import { Field, Input } from '../ui/Field'

const styles = stylex.create({
  brand: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: space.md },
  notice: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.xxs,
    alignSelf: 'stretch',
    paddingBlock: '10px',
    paddingInline: '14px',
    backgroundColor: colors.panel,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSoft,
    borderRadius: '10px',
  },
  form: { display: 'flex', flexDirection: 'column', gap: space.lg, width: '100%' },
  note: { alignSelf: 'stretch' },
})

type Notice = LoginNotice | 'unavailable'

const notices: Record<Notice, { title: string; detail: string }> = {
  signedOut: { title: 'You are signed out', detail: 'Sign in to view your devices, threads, and projects.' },
  expired: {
    title: 'Your sign-in expired',
    detail: 'Sign in again to continue. Saved threads and devices are still in your account.',
  },
  passwordReset: {
    title: 'Password reset by administrator',
    detail: 'Previous sessions have been signed out. Sign in with your new password.',
  },
  passwordUpdated: { title: 'Password updated', detail: 'Sign in again with your new password.' },
  unavailable: { title: 'Baton could not be reached', detail: 'Check your connection, then try signing in again.' },
}

function unavailable(error: Error | null) {
  return error instanceof ClientError && error.code === 'unavailable'
}

export function LoginPage() {
  const router = useRouter()
  const search = useSearch({ from: '/login' })
  const session = useSession()
  const signIn = useSignIn()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  // 账号或口令错误时只提示一次，再输入就清掉。
  const [invalid, setInvalid] = useState(false)
  const passwordRef = useRef<HTMLInputElement>(null)

  const signedIn = Boolean(session.data?.account)
  const mustChangePassword = session.data?.mustChangePassword
  // 登录后回到登录前所在的页面；redirect 由路由校验过，只会是站内地址。
  useEffect(() => {
    if (signedIn && !mustChangePassword) router.history.replace(search.redirect ?? '/')
  }, [signedIn, mustChangePassword, router, search.redirect])

  if (signedIn && mustChangePassword) return <Navigate to="/password" search={{ redirect: search.redirect }} replace />
  if (signedIn) return null

  const unreachable = unavailable(signIn.error) || (signIn.isIdle && unavailable(session.error))
  const notice: Notice | undefined = unreachable ? 'unavailable' : search.notice

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (signIn.isPending) return
    setInvalid(false)
    signIn.mutate(
      { username, password },
      {
        onError: (error) => {
          // 连不上 Baton 时表单原样保留；账号或口令错误时保留用户名，清空口令重新输入。
          if (unavailable(error)) return
          setInvalid(true)
          setPassword('')
          passwordRef.current?.focus()
        },
      },
    )
  }

  let label = 'Sign in'
  if (signIn.isPending) label = 'Signing in…'
  else if (unreachable) label = 'Try signing in again'

  return (
    <AuthShell>
      <div {...stylex.props(styles.brand)}>
        <BrandMark tone="color" size={36} />
        <h1 {...stylex.props(text.title)}>Sign in to Baton</h1>
      </div>
      {notice && (
        <div role={notice === 'unavailable' ? 'alert' : 'status'} {...stylex.props(styles.notice)}>
          <span {...stylex.props(text.label)}>{notices[notice].title}</span>
          <span {...stylex.props(text.caption, text.muted)}>{notices[notice].detail}</span>
        </div>
      )}
      <form onSubmit={submit} {...stylex.props(styles.form)}>
        <Field label="Username">
          {(props) => (
            <Input
              {...props}
              autoComplete="username"
              value={username}
              onChange={(event) => {
                setUsername(event.target.value)
                setInvalid(false)
              }}
            />
          )}
        </Field>
        <Field label="Password" error={invalid ? 'Invalid username or password.' : undefined}>
          {(props) => (
            <Input
              {...props}
              ref={passwordRef}
              type="password"
              autoComplete="current-password"
              placeholder={notice === 'passwordReset' ? 'New password' : 'Password'}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value)
                setInvalid(false)
              }}
            />
          )}
        </Field>
        <Button type="submit" variant="primary" block>
          {label}
        </Button>
      </form>
      <p {...stylex.props(text.caption, text.muted, styles.note)}>
        Contact your administrator if you need an account or password reset.
      </p>
    </AuthShell>
  )
}
