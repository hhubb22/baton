import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App.tsx'
import { alice, deskId, listOf, node } from './test/fixtures.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('登录流程', () => {
  it('必须改密时先引导改密，成功后要求重新登录', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.endsWith('/api/v1/me') && method === 'GET') {
        return json({ code: 'unauthenticated', message: '登录已失效', request_id: 'req-1' }, 401)
      }
      if (url.endsWith('/api/v1/login')) {
        const headers = new Headers(init?.headers)
        expect(headers.get('Authorization')).toBeNull()
        expect(init?.credentials).toBe('same-origin')
        return json({
          employee: { ...alice, must_change_password: true },
          csrf_token: 'csrf-token-value-0123456789',
          expires_at: '2026-10-18T00:00:00Z',
        })
      }
      if (url.endsWith('/api/v1/me/password')) {
        const headers = new Headers(init?.headers)
        expect(headers.get('X-CSRF-Token')).toBe('csrf-token-value-0123456789')
        return json({ employee: { ...alice, must_change_password: false } })
      }
      return json({ code: 'not_found', message: '找不到对应接口', request_id: 'req-x' }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    await screen.findByTestId('login-form')
    await user.type(screen.getByTestId('login-username'), 'alice')
    await user.type(screen.getByTestId('login-password'), 'initial-secret-001')
    await user.click(screen.getByTestId('login-submit'))
    expect(await screen.findByTestId('password-form')).toBeInTheDocument()
    expect(screen.queryByTestId('node-list')).not.toBeInTheDocument()

    await user.type(screen.getByTestId('password-current'), 'initial-secret-001')
    await user.type(screen.getByTestId('password-new'), 'replaced-secret-002')
    await user.type(screen.getByTestId('password-confirm'), 'different-secret')
    await user.click(screen.getByTestId('password-submit'))
    expect(await screen.findByRole('alert')).toHaveTextContent('两次输入的新口令不一致')
    expect(fetchMock.mock.calls.filter((call) => String(call[0]).endsWith('/api/v1/me/password'))).toHaveLength(0)

    await user.clear(screen.getByTestId('password-confirm'))
    await user.type(screen.getByTestId('password-confirm'), 'replaced-secret-002')
    await user.click(screen.getByTestId('password-submit'))
    expect(await screen.findByTestId('login-form')).toHaveTextContent('请用新口令重新登录')
    expect(sessionStorage.getItem('baton_csrf')).toBeNull()
    expect(localStorage.length).toBe(0)
  })

  it('登录失败时显示服务端原因', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/v1/me') && (init?.method ?? 'GET') === 'GET') {
        return json({ code: 'unauthenticated', message: '登录已失效', request_id: 'req-1' }, 401)
      }
      return json({ code: 'invalid_credentials', message: '账号或口令不正确', request_id: 'req-2' }, 401)
    }))
    render(<App />)
    await screen.findByTestId('login-form')
    await user.type(screen.getByTestId('login-username'), 'alice')
    await user.type(screen.getByTestId('login-password'), 'wrong-password-1')
    await user.click(screen.getByTestId('login-submit'))
    expect(await screen.findByRole('alert')).toHaveTextContent('账号或口令不正确')
    expect(screen.queryByTestId('node-list')).not.toBeInTheDocument()
  })

  it('登录后按服务端列表显示节点，领取凭据不写入存储', async () => {
    const user = userEvent.setup()
    const token = 'enroll-secret-from-server'
    let authed = false
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.endsWith('/api/v1/me') && method === 'GET') {
        if (!authed) return json({ code: 'unauthenticated', message: '登录已失效', request_id: 'req-1' }, 401)
        return json({ employee: alice, expires_at: '2026-10-18T00:00:00Z' })
      }
      if (url.endsWith('/api/v1/login')) {
        authed = true
        return json({
          employee: alice,
          csrf_token: 'csrf-token-value-0123456789',
          expires_at: '2026-10-18T00:00:00Z',
        })
      }
      if (url.endsWith('/api/v1/nodes') && method === 'GET') {
        return json(listOf([node({
          id: deskId,
          display_name: 'Desk',
          capabilities: ['start'],
          online: true,
          synced: true,
          executable: true,
          last_contact_at: '2026-10-17T02:00:00Z',
          status_updated_at: '2026-10-17T02:00:01Z',
        })]))
      }
      if (url.endsWith('/api/v1/node-enrollments')) {
        const headers = new Headers(init?.headers)
        expect(headers.get('Authorization')).toBeNull()
        expect(headers.get('X-CSRF-Token')).toBe('csrf-token-value-0123456789')
        return json({
          enrollment_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          enrollment_token: token,
          expires_at: '2026-10-17T00:10:00Z',
        })
      }
      if (url.endsWith('/api/v1/logout')) return new Response(null, { status: 204 })
      return json({ code: 'not_found', message: '找不到对应接口', request_id: 'req-x' }, 404)
    }))

    render(<App />)
    await screen.findByTestId('login-form')
    await user.type(screen.getByTestId('login-username'), 'alice')
    await user.type(screen.getByTestId('login-password'), 'replaced-secret-002')
    await user.click(screen.getByTestId('login-submit'))
    expect(await screen.findByTestId('node-list')).toHaveTextContent('Desk')
    expect(screen.getByTestId('node-presence')).toHaveTextContent('在线')
    expect(screen.getByTestId('node-sync')).toHaveTextContent('已同步')
    expect(screen.getByTestId('node-executable')).toHaveTextContent('可执行')

    await user.click(screen.getByTestId('enrollment-issue'))
    expect(await screen.findByTestId('enrollment-token')).toHaveValue(token)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.getItem('baton_csrf')).toBe('csrf-token-value-0123456789')
    expect(JSON.stringify(sessionStorage)).not.toContain(token)
    expect(window.location.href).not.toContain(token)

    await user.click(screen.getByTestId('logout'))
    expect(await screen.findByTestId('login-form')).toHaveTextContent('已退出')
    expect(screen.queryByText(token)).not.toBeInTheDocument()
  })
})
