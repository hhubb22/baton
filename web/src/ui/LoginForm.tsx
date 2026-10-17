import { useState, type FormEvent } from 'react'

type Props = {
  notice: string
  error: string
  busy: boolean
  onSubmit: (username: string, password: string) => void
}

export function LoginForm({ notice, error, busy, onSubmit }: Props) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    onSubmit(username, password)
  }

  return (
    <form className="card" data-testid="login-form" onSubmit={submit}>
      <h2>登录</h2>
      {notice ? <p className="notice">{notice}</p> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
      <label>
        用户名
        <input
          data-testid="login-username"
          autoComplete="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
      </label>
      <label>
        口令
        <input
          data-testid="login-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      <button data-testid="login-submit" type="submit" disabled={busy}>
        {busy ? '正在登录' : '登录'}
      </button>
    </form>
  )
}
