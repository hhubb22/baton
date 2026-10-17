import { useState } from 'react'
import { formatReportTime, registerUsage } from '../model.ts'
import type { Enrollment } from '../types.ts'

type Props = {
  enrollment: Enrollment | null
  origin: string
  busy: boolean
  canWrite: boolean
  onIssue: () => void
  onDismiss: () => void
}

export function EnrollmentPanel({ enrollment, origin, busy, canWrite, onIssue, onDismiss }: Props) {
  const [copyState, setCopyState] = useState('')

  async function copyToken(token: string) {
    try {
      await navigator.clipboard.writeText(token)
      setCopyState('已复制。关闭后无法再查看。')
    } catch {
      setCopyState('无法复制，请手动选择。')
    }
  }

  if (!enrollment) {
    return (
      <section className="card">
        <h2>注册节点</h2>
        <p>领取后凭据只在页面上显示一次。关闭或离开后不能再查看，服务端也不会再次返回同一张凭据。</p>
        <button data-testid="enrollment-issue" type="button" disabled={!canWrite || busy} onClick={onIssue}>
          {busy ? '正在领取' : '领取注册凭据'}
        </button>
      </section>
    )
  }

  const usage = registerUsage(origin)
  return (
    <section className="card">
      <h2>一次性注册凭据</h2>
      <p>这张凭据只显示这一次。不要写入 localStorage、URL 或日志，也不要放进命令行参数。</p>
      <label>
        凭据
        <textarea
          data-testid="enrollment-token"
          readOnly
          rows={3}
          spellCheck={false}
          autoComplete="off"
          value={enrollment.enrollment_token}
        />
      </label>
      <p>有效期至 {formatReportTime(enrollment.expires_at)}。标识 {enrollment.enrollment_id}。</p>
      <pre data-testid="register-usage">{usage}</pre>
      <div className="actions">
        <button type="button" onClick={() => void copyToken(enrollment.enrollment_token)}>复制凭据</button>
        <button data-testid="enrollment-dismiss" type="button" onClick={onDismiss}>关闭并清除</button>
      </div>
      {copyState ? <p className="hint">{copyState}</p> : null}
    </section>
  )
}
