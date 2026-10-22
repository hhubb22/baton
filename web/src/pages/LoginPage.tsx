import * as stylex from '@stylexjs/stylex'
import { Navigate, useNavigate } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { useSession, useSignIn } from '../data/queries'
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
  column: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: space.lg, width: '360px' },
  form: { display: 'flex', flexDirection: 'column', gap: space.lg, width: '100%' },
  card: { width: '100%' },
  note: { alignSelf: 'stretch' },
})

export function LoginPage() {
  const navigate = useNavigate()
  const session = useSession()
  const signIn = useSignIn()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  if (session.data?.account) return <Navigate to="/" replace />

  const submit = (event: FormEvent) => {
    event.preventDefault()
    signIn.mutate({ username, password }, { onSuccess: () => void navigate({ to: '/' }) })
  }

  const error = signIn.isError ? 'Username or password is incorrect.' : undefined

  return (
    <main {...stylex.props(styles.page)}>
      <div {...stylex.props(styles.column)}>
        <BrandMark tone="color" size={40} />
        <h1 {...stylex.props(text.title)}>Sign in to Baton</h1>
        <Card style={styles.card}>
          <form onSubmit={submit} {...stylex.props(styles.form)}>
            <Field label="Username">
              {(props) => (
                <Input {...props} autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} />
              )}
            </Field>
            <Field label="Password" error={error}>
              {(props) => (
                <Input
                  {...props}
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              )}
            </Field>
            <Button type="submit" variant="primary" block>
              {signIn.isPending ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </Card>
        <p {...stylex.props(text.caption, text.faint, styles.note)}>
          Contact your administrator if you need an account or password reset.
        </p>
      </div>
    </main>
  )
}
