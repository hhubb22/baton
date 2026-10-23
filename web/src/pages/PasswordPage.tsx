import * as stylex from '@stylexjs/stylex'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Navigate, useSearch } from '@tanstack/react-router'
import { useRef, useState, type FormEvent } from 'react'
import { ClientError } from '../data/client'
import { keys, useClient, useSession } from '../data/queries'
import { text } from '../theme/text'
import { colors, space } from '../theme/tokens.stylex'
import { BrandMark } from '../ui/BrandMark'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { Field, Input } from '../ui/Field'

const styles = stylex.create({
  page: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    padding: space.xl,
    backgroundColor: colors.canvas,
  },
  column: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: space.lg, width: '380px' },
  card: { width: '100%' },
  form: { display: 'flex', flexDirection: 'column', gap: space.lg },
  error: { color: colors.danger },
})

function passwordError(password: string, username: string) {
  if (
    password !== password.trim() ||
    [...password].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    return 'Use no control characters or spaces at the start or end.'
  }
  if ([...password].length < 12 || [...password].length > 128) return 'Use 12 to 128 characters.'
  if (password.toLowerCase() === username.toLowerCase()) return 'Choose a password different from your username.'
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
      ? 'Baton could not be reached. Your entries are kept. Try again.'
      : change.error instanceof ClientError && change.error.code === 'invalid'
        ? change.error.message
        : 'Could not update your password. Check your current password and try again.'
    : null

  return (
    <main {...stylex.props(styles.page)}>
      <div {...stylex.props(styles.column)}>
        <BrandMark tone="color" size={36} />
        <h1 {...stylex.props(text.title)}>Change your password</h1>
        <p {...stylex.props(text.small, text.muted)}>Update your password before opening your workspace.</p>
        <Card style={styles.card}>
          <form onSubmit={submit} noValidate {...stylex.props(styles.form)}>
            <Field label="Current password" error={currentMissing ? 'Enter your current password.' : undefined}>
              {(props) => (
                <Input
                  {...props}
                  ref={currentRef}
                  type="password"
                  autoComplete="current-password"
                  required
                  autoFocus
                  value={current}
                  disabled={change.isPending}
                  onChange={(event) => {
                    setCurrent(event.target.value)
                    setCurrentMissing(false)
                    change.reset()
                  }}
                />
              )}
            </Field>
            <Field
              label="New password"
              helper="Use 12 to 128 characters. Avoid control characters and spaces at the start or end. Choose a password different from your username."
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
                  disabled={change.isPending}
                  onChange={(event) => {
                    setPassword(event.target.value)
                    setValidation(undefined)
                    setMismatch(false)
                    change.reset()
                  }}
                />
              )}
            </Field>
            <Field label="Confirm new password" error={mismatch ? 'Passwords do not match.' : undefined}>
              {(props) => (
                <Input
                  {...props}
                  ref={confirmationRef}
                  type="password"
                  autoComplete="new-password"
                  required
                  value={confirmation}
                  disabled={change.isPending}
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
            <Button type="submit" variant="primary" block disabled={change.isPending}>
              {change.isPending ? 'Updating…' : 'Update password'}
            </Button>
          </form>
        </Card>
      </div>
    </main>
  )
}
