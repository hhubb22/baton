import { createMemoryHistory } from '@tanstack/react-router'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { createHttpClient } from '../data/http/client'
import { App } from './App'
import { createAppRouter } from './router'

function requestURL(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input.toString()
}

function jsonBody(body: RequestInit['body']): string {
  if (typeof body !== 'string') throw new TypeError('Expected a JSON string request body')
  return body
}

function setup(path = '/threads', authenticated = false, options: { mustChange?: boolean; username?: string } = {}) {
  let signedIn = authenticated
  let mustChange = options.mustChange ?? true
  let password = 'initial-password'
  let failure: 'offline' | 'wrongPassword' | 'rateLimited' | 'loginBusy' | null = null
  const requests: { path: string; method: string; body: Record<string, string> }[] = []
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const path = requestURL(input).replace('/api/v1', '')
    const method = init?.method ?? 'GET'
    const body = JSON.parse(jsonBody(init?.body ?? '{}')) as Record<string, string>
    requests.push({ path, method, body })
    if (path === '/me/password') {
      if (failure === 'offline') throw new TypeError('Disconnected')
      if (failure === 'wrongPassword' || body.current_password !== password) {
        return Response.json({ code: 'invalid_credentials' }, { status: 401 })
      }
      password = body.new_password
      mustChange = false
      signedIn = false
      return new Response(null, { status: 204 })
    }
    if (path === '/login') {
      if (failure === 'rateLimited') return Response.json({ code: 'login_rate_limited' }, { status: 429 })
      if (failure === 'loginBusy') return Response.json({ code: 'login_busy' }, { status: 503 })
      if (body.password !== password) return Response.json({ code: 'invalid_credentials' }, { status: 401 })
      signedIn = true
      return Response.json({})
    }
    if (!signedIn) return Response.json({ code: 'unauthorized' }, { status: 401 })
    if (path === '/me')
      return Response.json({
        employee: {
          id: 'employee-1',
          username: options.username ?? 'kaken',
          display_name: 'Kaken He',
          must_change_password: mustChange,
        },
        csrf_token: 'test-csrf',
      })
    if (path === '/nodes') return Response.json({ nodes: [], default_device: {} })
    if (path === '/projects') return Response.json({ projects: [] })
    if (path.startsWith('/threads?')) return Response.json({ requests: [] })
    throw new Error(`Unexpected request: ${path}`)
  })
  const client = createHttpClient({ fetch: fetcher, WebSocket: null, pollInterval: 1_000_000 })
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) })
  render(<App client={client} router={router} />)
  return {
    client,
    router,
    requests,
    fail: (next: typeof failure) => {
      failure = next
    },
  }
}

async function fillPassword(user: ReturnType<typeof userEvent.setup>, password: string, confirmation = password) {
  const next = await screen.findByLabelText('新密码')
  await user.clear(next)
  if (password) await user.type(next, password)
  const confirm = screen.getByLabelText('确认新密码')
  await user.clear(confirm)
  if (confirmation) await user.type(confirm, confirmation)
}

beforeEach(() => localStorage.clear())

it.each([
  ['rateLimited', '登录尝试过于频繁'],
  ['loginBusy', '暂时无法登录'],
] as const)('shows %s without retrying or clearing the password', async (failure, title) => {
  const user = userEvent.setup()
  const { fail, requests } = setup('/login')
  fail(failure)
  await user.type(await screen.findByLabelText('用户名'), 'kaken')
  await user.type(screen.getByLabelText('密码'), 'initial-password')
  await user.click(screen.getByRole('button', { name: '登录' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(title)
  expect(screen.getByLabelText('密码')).toHaveValue('initial-password')
  expect(requests.filter((request) => request.path === '/login')).toHaveLength(1)
})

describe('password change', () => {
  it('requires an initial HTTP login to change password, sign in again, and return to the original URL', async () => {
    const user = userEvent.setup()
    const { router, requests } = setup()
    await user.type(await screen.findByLabelText('用户名'), 'kaken')
    await user.type(screen.getByLabelText('密码'), 'initial-password')
    await user.click(screen.getByRole('button', { name: '登录' }))
    expect(await screen.findByRole('heading', { name: '修改密码' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/password')
    expect(router.state.location.search.redirect).toBe('/threads')
    expect(screen.queryByRole('navigation', { name: '工作区' })).not.toBeInTheDocument()
    expect(requests.some((request) => request.path === '/nodes' || request.path === '/projects')).toBe(false)

    await user.type(screen.getByLabelText('当前密码'), 'initial-password')
    await fillPassword(user, 'updated-password')
    await user.click(screen.getByRole('button', { name: '更新密码' }))
    expect(await screen.findByText('密码已更新')).toBeInTheDocument()
    expect(screen.getByText('使用新密码重新登录。')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/login')
    expect(router.state.location.search.redirect).toBe('/threads')
    expect(requests.find((request) => request.path === '/me/password')?.body).toEqual({
      current_password: 'initial-password',
      new_password: 'updated-password',
    })
    await user.type(screen.getByLabelText('用户名'), 'kaken')
    await user.type(screen.getByLabelText('密码'), 'updated-password')
    await user.click(screen.getByRole('button', { name: '登录' }))
    expect(await screen.findByRole('link', { name: '对话' })).toBeInTheDocument()
    expect(router.state.location.href).toBe('/threads')
  })

  it('returns signed-out visitors to login with their requested workspace page', async () => {
    const { router } = setup('/password?redirect=%2Fthreads')
    expect(await screen.findByRole('heading', { name: '登录 Baton' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/login')
    expect(router.state.location.search.redirect).toBe('/threads')
  })

  it('opens the requested workspace page for an account that has already changed its password', async () => {
    const { router } = setup('/password?redirect=%2Fthreads', true, { mustChange: false })
    expect(await screen.findByRole('link', { name: '对话' })).toBeInTheDocument()
    expect(router.state.location.href).toBe('/threads')
  })

  it('requires a password different from the username, ignoring case', async () => {
    const user = userEvent.setup()
    const { requests } = setup('/password', true, { username: 'EmployeeName' })
    await user.type(await screen.findByLabelText('当前密码'), 'initial-password')
    await fillPassword(user, 'EMPLOYEENAME')
    await user.click(screen.getByRole('button', { name: '更新密码' }))
    expect(screen.getByText('密码不能与用户名相同。')).toBeInTheDocument()
    expect(requests.some((request) => request.path === '/me/password')).toBe(false)
  })

  it('accepts the lower length boundary', async () => {
    const user = userEvent.setup()
    const { requests } = setup('/password', true)
    await user.type(await screen.findByLabelText('当前密码'), 'initial-password')
    await fillPassword(user, 'a'.repeat(12))
    await user.click(screen.getByRole('button', { name: '更新密码' }))
    expect(await screen.findByText('密码已更新')).toBeInTheDocument()
    expect(requests.find((request) => request.path === '/me/password')?.body.new_password).toHaveLength(12)
  })

  it('guards direct workspace navigation until the password is changed', async () => {
    const { router, requests } = setup('/devices', true)
    expect(await screen.findByRole('heading', { name: '修改密码' })).toBeInTheDocument()
    await act(() => router.navigate({ to: '/threads' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/password'))
    expect(screen.queryByRole('navigation', { name: '工作区' })).not.toBeInTheDocument()
    expect(requests.every((request) => request.path === '/me')).toBe(true)
  })

  it.each(['//example.com', '/\\example.com', '/login', '/password?redirect=/threads', '/x/../login'])(
    'drops unsafe or recursive redirects: %s',
    async (redirect) => {
      const { router } = setup(`/login?redirect=${encodeURIComponent(redirect)}`, true)
      expect(await screen.findByRole('heading', { name: '修改密码' })).toBeInTheDocument()
      expect(router.state.location.search.redirect).toBeUndefined()
    },
  )

  it('checks password length, confirmation and current password before sending', async () => {
    const user = userEvent.setup()
    const { requests } = setup('/password', true)
    await fillPassword(user, 'short')
    await user.click(screen.getByRole('button', { name: '更新密码' }))
    expect(screen.getByText('请输入当前密码。')).toBeInTheDocument()
    expect(screen.getByText('请输入 12 到 128 个字符。')).toBeInTheDocument()
    await user.type(screen.getByLabelText('当前密码'), 'initial-password')
    await fillPassword(user, 'a'.repeat(129))
    await user.click(screen.getByRole('button', { name: '更新密码' }))
    expect(screen.getByText('请输入 12 到 128 个字符。')).toBeInTheDocument()
    await fillPassword(user, 'valid-password', 'different-password')
    await user.click(screen.getByRole('button', { name: '更新密码' }))
    expect(screen.getByText('两次输入的密码不一致。')).toBeInTheDocument()
    expect(requests.some((request) => request.path === '/me/password')).toBe(false)
  })

  it.each([' password-with-space', 'password-with-space ', 'password-with-\u007f'])(
    'rejects disallowed spaces and control characters',
    async (password) => {
      const user = userEvent.setup()
      const { requests } = setup('/password', true)
      await user.type(await screen.findByLabelText('当前密码'), 'initial-password')
      await fillPassword(user, password)
      await user.click(screen.getByRole('button', { name: '更新密码' }))
      expect(screen.getByText('开头和结尾不能有空格，密码不能包含控制字符。')).toBeInTheDocument()
      expect(requests.some((request) => request.path === '/me/password')).toBe(false)
    },
  )

  it('counts Unicode characters and accepts the upper length boundary', async () => {
    const user = userEvent.setup()
    const { requests } = setup('/password', true)
    await user.type(await screen.findByLabelText('当前密码'), 'initial-password')
    await fillPassword(user, '🔑'.repeat(128))
    await user.click(screen.getByRole('button', { name: '更新密码' }))
    expect(await screen.findByText('密码已更新')).toBeInTheDocument()
    expect(requests.find((request) => request.path === '/me/password')?.body.new_password).toBe('🔑'.repeat(128))
  })

  it('keeps entered values after wrong current password and connection failure, then retries', async () => {
    const user = userEvent.setup()
    const { fail } = setup('/password', true)
    await user.type(await screen.findByLabelText('当前密码'), 'initial-password')
    await fillPassword(user, 'updated-password')
    fail('wrongPassword')
    await user.click(screen.getByRole('button', { name: '更新密码' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('请检查当前密码')
    fail('offline')
    await user.click(screen.getByRole('button', { name: '更新密码' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('无法连接 Baton，请重试。')
    expect(screen.getByLabelText('当前密码')).toHaveValue('initial-password')
    expect(screen.getByLabelText('新密码')).toHaveValue('updated-password')
    expect(screen.getByLabelText('确认新密码')).toHaveValue('updated-password')
    fail(null)
    await user.click(screen.getByRole('button', { name: '更新密码' }))
    expect(await screen.findByText('密码已更新')).toBeInTheDocument()
  })
})
