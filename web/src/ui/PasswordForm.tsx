import { useState, type FormEvent } from 'react'

type Props = {
  username: string
  error: string
  busy: boolean
  canWrite: boolean
  onSubmit: (currentPassword: string, newPassword: string) => void
}

export function PasswordForm({ username, error, busy, canWrite, onSubmit }: Props) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [localError, setLocalError] = useState('')

  function submit(event: FormEvent) {
    event.preventDefault()
    if (busy || !canWrite) return
    if (newPassword !== confirmPassword) {
      setLocalError('两次输入的新口令不一致')
      return
    }
    setLocalError('')
    onSubmit(currentPassword, newPassword)
  }

  const shown = localError || error

  return (
    <form className="card" data-testid="password-form" onSubmit={submit}>
      <h2>更换口令</h2>
      <p>账号 {username} 必须先更换初始口令，之后才能查看节点。</p>
      <p className="hint">新口令至少 12 个字符，最长 128 个字符，不能有控制字符或首尾空格，也不能与用户名或当前口令相同。是否接受由服务端决定。</p>
      {shown ? <p className="error" role="alert">{shown}</p> : null}
      <label>
        当前口令
        <input
          data-testid="password-current"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
        />
      </label>
      <label>
        新口令
        <input
          data-testid="password-new"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
        />
      </label>
      <label>
        再次输入新口令
        <input
          data-testid="password-confirm"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
        />
      </label>
      <button data-testid="password-submit" type="submit" disabled={busy || !canWrite}>
        {busy ? '正在提交' : '更换口令'}
      </button>
    </form>
  )
}
