import * as stylex from '@stylexjs/stylex'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, Navigate, useRouter, useSearch } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { AuthShell } from '../app/AuthShell'
import { ClientError } from '../data/client'
import { HttpError } from '../data/http/transport'
import { useClient, useSession } from '../data/queries'
import { text } from '../theme/text'
import { semantic } from '../theme/semantic.stylex'
import { radius, space } from '../theme/tokens.stylex'
import { BrandMark } from '../ui/BrandMark'
import { Button, focusRing } from '../ui/Button'
import { Field, Input } from '../ui/Field'

const styles = stylex.create({
  brand: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: space.md },
  form: { display: 'flex', flexDirection: 'column', gap: space.lg, width: '100%' },
  device: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.sm,
    alignSelf: 'stretch',
    padding: space.lg,
    backgroundColor: semantic.sidebar,
    borderRadius: radius.md,
  },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: space.md },
  error: { color: semantic.destructiveForeground },
  link: { color: semantic.brandForeground },
})

function loginError(error: Error) {
  if (error instanceof HttpError) {
    if (error.status === 410) return '设备登录码已过期，请在设备上重新运行登录命令。'
    if (error.status === 404) return '找不到待确认的设备登录码，请检查后重试。'
    if (error.status === 409) return '此设备登录请求已处理，请在设备上查看登录状态。'
    if (error.status === 403) return error.message
  }
  if (error instanceof ClientError && error.code === 'unavailable') return '无法连接 Baton，请重试。'
  return '无法确认设备登录，请重试。'
}

function DeviceLoginForm({ initialCode }: { initialCode: string }) {
  const client = useClient()
  const router = useRouter()
  const [input, setInput] = useState(initialCode)
  const code = initialCode.trim()
  const [missing, setMissing] = useState(false)
  const [done, setDone] = useState<'approve' | 'deny' | null>(null)
  const lookup = useQuery({
    queryKey: ['deviceLogin', code],
    queryFn: () => client.getDeviceLoginSession(code),
    enabled: Boolean(code),
    staleTime: 0,
    refetchOnMount: 'always',
  })
  const decision = useMutation({
    mutationFn: async (action: 'approve' | 'deny') => {
      const session = lookup.data!
      if (action === 'approve') await client.approveDeviceLoginSession(session.session_id, session.user_code)
      else await client.denyDeviceLoginSession(session.session_id)
      return action
    },
    onSuccess: setDone,
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (decision.isPending) return
    const next = input.trim()
    setInput(next)
    setMissing(!next)
    decision.reset()
    if (next === code && next) void lookup.refetch()
    else if (next) void router.navigate({ to: '/device-login', search: { code: next }, replace: true })
  }
  const failure = decision.error ?? lookup.error
  const handled = decision.error instanceof HttpError && [404, 409, 410].includes(decision.error.status)
  const session = !lookup.isError && !lookup.isFetching && !handled && input.trim() === code ? lookup.data : undefined
  const system = session && { macos: 'macOS', linux: 'Linux', windows: 'Windows' }[session.system]

  if (done) {
    return (
      <>
        <p role="status" {...stylex.props(text.label)}>
          {done === 'approve' ? '已允许设备登录' : '已拒绝设备登录'}
        </p>
        <p {...stylex.props(text.small, text.muted)}>可以关闭此页面，返回设备查看登录状态。</p>
        <Link to="/devices" {...stylex.props(text.label, styles.link, focusRing.ring)}>
          查看设备
        </Link>
      </>
    )
  }

  return (
    <>
      <form onSubmit={submit} {...stylex.props(styles.form)}>
        <Field label="设备登录码" error={missing ? '请输入设备登录码。' : undefined}>
          {(props) => (
            <Input
              {...props}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="ABCD-EFGH"
              maxLength={32}
              value={input}
              readOnly={decision.isPending}
              onChange={(event) => {
                setInput(event.target.value)
                setMissing(false)
              }}
            />
          )}
        </Field>
        <Button type="submit" disabled={lookup.isFetching || decision.isPending}>
          {lookup.isFetching ? '正在查找…' : '查找设备'}
        </Button>
      </form>
      {failure && (
        <p role="alert" {...stylex.props(text.small, styles.error)}>
          {loginError(failure)}
        </p>
      )}
      {session && (
        <div {...stylex.props(styles.device)}>
          <span {...stylex.props(text.label)}>{session.display_name}</span>
          <span {...stylex.props(text.small, text.muted)}>{system}</span>
          <code {...stylex.props(text.mono)}>{session.user_code}</code>
          <p {...stylex.props(text.small, text.muted)}>仅允许你正在设置的设备登录你的账号。</p>
          <div {...stylex.props(styles.actions)}>
            <Button disabled={decision.isPending} onClick={() => decision.mutate('deny')}>
              {decision.isPending && decision.variables === 'deny' ? '正在拒绝…' : '拒绝登录'}
            </Button>
            <Button variant="primary" disabled={decision.isPending} onClick={() => decision.mutate('approve')}>
              {decision.isPending && decision.variables === 'approve' ? '正在允许…' : '允许登录'}
            </Button>
          </div>
        </div>
      )}
    </>
  )
}

export function DeviceLoginPage() {
  const session = useSession()
  const router = useRouter()
  const search = useSearch({ from: '/device-login' })
  if (session.isPending) return null
  const redirect = router.state.location.href
  if (!session.data?.account)
    return <Navigate to="/login" search={{ notice: session.data?.ended ?? undefined, redirect }} replace />
  if (session.data.mustChangePassword) return <Navigate to="/password" search={{ redirect }} replace />
  return (
    <AuthShell>
      <div {...stylex.props(styles.brand)}>
        <BrandMark tone="color" size={36} />
        <h1 {...stylex.props(text.title)}>确认设备登录</h1>
      </div>
      <DeviceLoginForm key={search.code ?? ''} initialCode={search.code ?? ''} />
    </AuthShell>
  )
}
