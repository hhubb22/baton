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
  signedOut: { title: '已退出登录', detail: '' },
  expired: { title: '登录已过期', detail: '' },
  passwordReset: { title: '管理员已重置密码', detail: '其他会话已退出。' },
  passwordUpdated: { title: '密码已更新', detail: '使用新密码重新登录。' },
  unavailable: { title: '无法连接 Baton', detail: '' },
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

  let label = '登录'
  if (signIn.isPending) label = '正在登录…'
  else if (unreachable) label = '重新登录'

  return (
    <AuthShell>
      <div {...stylex.props(styles.brand)}>
        <BrandMark tone="color" size={36} />
        <h1 {...stylex.props(text.title)}>登录 Baton</h1>
      </div>
      {notice && (
        <div role={notice === 'unavailable' ? 'alert' : 'status'} {...stylex.props(styles.notice)}>
          <span {...stylex.props(text.label)}>{notices[notice].title}</span>
          {notices[notice].detail && <span {...stylex.props(text.caption, text.muted)}>{notices[notice].detail}</span>}
        </div>
      )}
      <form onSubmit={submit} {...stylex.props(styles.form)}>
        <Field label="用户名">
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
        <Field label="密码" error={invalid ? '用户名或密码错误。' : undefined}>
          {(props) => (
            <Input
              {...props}
              ref={passwordRef}
              type="password"
              autoComplete="current-password"
              placeholder={notice === 'passwordReset' ? '新密码' : '密码'}
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
      <p {...stylex.props(text.caption, text.muted, styles.note)}>没有账号？请联系管理员。</p>
    </AuthShell>
  )
}
