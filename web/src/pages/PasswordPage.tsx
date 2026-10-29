import * as stylex from '@stylexjs/stylex'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Navigate, useSearch } from '@tanstack/react-router'
import { useRef, useState, type FormEvent } from 'react'
import { AuthShell } from '../app/AuthShell'
import { ClientError } from '../data/client'
import { keys, useClient, useSession } from '../data/queries'
import { text } from '../theme/text'
import { colors, space } from '../theme/tokens.stylex'
import { BrandMark } from '../ui/BrandMark'
import { Button } from '../ui/Button'
import { Field, Input } from '../ui/Field'

const styles = stylex.create({
  brand: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: space.md, textAlign: 'center' },
  form: { display: 'flex', flexDirection: 'column', gap: space.lg, width: '100%' },
  error: { color: colors.danger },
})

function passwordError(password: string, username: string) {
  if (
    password !== password.trim() ||
    Array.from(password).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    return '开头和结尾不能有空格，密码不能包含控制字符。'
  }
  if (Array.from(password).length < 12 || Array.from(password).length > 128) return '请输入 12 到 128 个字符。'
  if (password.toLowerCase() === username.toLowerCase()) return '密码不能与用户名相同。'
}

export function PasswordPage() {
  const client = useClient()
  const cache = useQueryClient()
  const session = useSession()
  const search = useSearch({ from: '/password' })
  const [current, setCurrent] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [validation, setValidation] = useState<string>()
  const [currentMissing, setCurrentMissing] = useState(false)
  const [mismatch, setMismatch] = useState(false)
  const [updated, setUpdated] = useState(false)
  const currentRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const confirmationRef = useRef<HTMLInputElement>(null)
  const change = useMutation({
    mutationFn: () => client.changePassword(current, password),
    onSuccess: (next) => {
      setUpdated(true)
      cache.setQueryData(keys.session, next)
      cache.removeQueries({ predicate: (query) => query.queryKey[0] !== 'session' })
    },
  })

  if (updated) return <Navigate to="/login" search={{ notice: 'passwordUpdated', redirect: search.redirect }} replace />
  if (session.isPending) return null
  if (!session.data?.account) return <Navigate to="/login" search={{ redirect: search.redirect }} replace />
  if (!session.data.mustChangePassword) return <Navigate to={search.redirect ?? '/'} replace />

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (change.isPending) return
    change.reset()
    const invalid = passwordError(password, session.data.account!.username)
    setValidation(invalid)
    setCurrentMissing(!current)
    setMismatch(password !== confirmation)
    if (!current) currentRef.current?.focus()
    else if (invalid) passwordRef.current?.focus()
    else if (password !== confirmation) confirmationRef.current?.focus()
    else change.mutate()
  }

  const failure = change.error
    ? change.error instanceof ClientError && change.error.code === 'unavailable'
      ? '无法连接 Baton，请重试。'
      : change.error instanceof ClientError && change.error.code === 'invalid'
        ? change.error.message
        : '无法更新密码，请检查当前密码后重试。'
    : null

  return (
    <AuthShell>
      <div {...stylex.props(styles.brand)}>
        <BrandMark tone="color" size={36} />
        <h1 {...stylex.props(text.title)}>修改密码</h1>
        <p {...stylex.props(text.small, text.muted)}>请先修改密码，再进入工作区。</p>
      </div>
      <form onSubmit={submit} noValidate {...stylex.props(styles.form)}>
        <Field label="当前密码" error={currentMissing ? '请输入当前密码。' : undefined}>
          {(props) => (
            <Input
              {...props}
              ref={currentRef}
              type="password"
              autoComplete="current-password"
              required
              autoFocus
              value={current}
              readOnly={change.isPending}
              onChange={(event) => {
                setCurrent(event.target.value)
                setCurrentMissing(false)
                change.reset()
              }}
            />
          )}
        </Field>
        <Field
          label="新密码"
          helper="使用 12 到 128 个字符。开头和结尾不能有空格，不能包含控制字符，也不能与用户名相同。"
          error={validation}
        >
          {(props) => (
            <Input
              {...props}
              ref={passwordRef}
              type="password"
              autoComplete="new-password"
              required
              value={password}
              readOnly={change.isPending}
              onChange={(event) => {
                setPassword(event.target.value)
                setValidation(undefined)
                setMismatch(false)
                change.reset()
              }}
            />
          )}
        </Field>
        <Field label="确认新密码" error={mismatch ? '两次输入的密码不一致。' : undefined}>
          {(props) => (
            <Input
              {...props}
              ref={confirmationRef}
              type="password"
              autoComplete="new-password"
              required
              value={confirmation}
              readOnly={change.isPending}
              onChange={(event) => {
                setConfirmation(event.target.value)
                setMismatch(false)
                change.reset()
              }}
            />
          )}
        </Field>
        {failure && (
          <p role="alert" {...stylex.props(text.small, styles.error)}>
            {failure}
          </p>
        )}
        <Button type="submit" variant="primary" block>
          {change.isPending ? '正在更新…' : '更新密码'}
        </Button>
      </form>
    </AuthShell>
  )
}
