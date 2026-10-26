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

function setup(
  path = '/inbox?handled=true',
  authenticated = false,
  options: { mustChange?: boolean; username?: string } = {},
) {
  let signedIn = authenticated
  let mustChange = options.mustChange ?? true
  let password = 'initial-password'
  let failure: 'offline' | 'wrongPassword' | null = null
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
    if (path.startsWith('/inbox?')) return Response.json({ requests: [] })
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
  const next = await screen.findByLabelText('New password')
  await user.clear(next)
  if (password) await user.type(next, password)
  const confirm = screen.getByLabelText('Confirm new password')
  await user.clear(confirm)
  if (confirmation) await user.type(confirm, confirmation)
}

beforeEach(() => localStorage.clear())

describe('password change', () => {
  it('requires an initial HTTP login to change password, sign in again, and return to the original URL', async () => {
    const user = userEvent.setup()
    const { router, requests } = setup()
    await user.type(await screen.findByLabelText('Username'), 'kaken')
    await user.type(screen.getByLabelText('Password'), 'initial-password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('heading', { name: 'Change your password' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/password')
    expect(router.state.location.search.redirect).toBe('/inbox?handled=true')
    expect(screen.queryByRole('navigation', { name: 'Workspace' })).not.toBeInTheDocument()
    expect(requests.some((request) => request.path === '/nodes' || request.path === '/projects')).toBe(false)

    await user.type(screen.getByLabelText('Current password'), 'initial-password')
    await fillPassword(user, 'updated-password')
    await user.click(screen.getByRole('button', { name: 'Update password' }))
    expect(await screen.findByText('Password updated')).toBeInTheDocument()
    expect(screen.getByText('Sign in again with your new password.')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/login')
    expect(router.state.location.search.redirect).toBe('/inbox?handled=true')
    expect(requests.find((request) => request.path === '/me/password')?.body).toEqual({
      current_password: 'initial-password',
      new_password: 'updated-password',
    })
    await user.type(screen.getByLabelText('Username'), 'kaken')
    await user.type(screen.getByLabelText('Password'), 'updated-password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('heading', { name: 'Handled' })).toBeInTheDocument()
    expect(router.state.location.href).toBe('/inbox?handled=true')
  })

  it('returns signed-out visitors to login with their requested workspace page', async () => {
    const { router } = setup('/password?redirect=%2Finbox%3Fhandled%3Dtrue')
    expect(await screen.findByRole('heading', { name: 'Sign in to Baton' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/login')
    expect(router.state.location.search.redirect).toBe('/inbox?handled=true')
  })

  it('opens the requested workspace page for an account that has already changed its password', async () => {
    const { router } = setup('/password?redirect=%2Finbox%3Fhandled%3Dtrue', true, { mustChange: false })
    expect(await screen.findByRole('heading', { name: 'Handled' })).toBeInTheDocument()
    expect(router.state.location.href).toBe('/inbox?handled=true')
  })

  it('requires a password different from the username, ignoring case', async () => {
    const user = userEvent.setup()
    const { requests } = setup('/password', true, { username: 'EmployeeName' })
    await user.type(await screen.findByLabelText('Current password'), 'initial-password')
    await fillPassword(user, 'EMPLOYEENAME')
    await user.click(screen.getByRole('button', { name: 'Update password' }))
    expect(screen.getByText('Choose a password different from your username.')).toBeInTheDocument()
    expect(requests.some((request) => request.path === '/me/password')).toBe(false)
  })

  it('accepts the lower length boundary', async () => {
    const user = userEvent.setup()
    const { requests } = setup('/password', true)
    await user.type(await screen.findByLabelText('Current password'), 'initial-password')
    await fillPassword(user, 'a'.repeat(12))
    await user.click(screen.getByRole('button', { name: 'Update password' }))
    expect(await screen.findByText('Password updated')).toBeInTheDocument()
    expect(requests.find((request) => request.path === '/me/password')?.body.new_password).toHaveLength(12)
  })

  it('guards direct workspace navigation until the password is changed', async () => {
    const { router, requests } = setup('/devices', true)
    expect(await screen.findByRole('heading', { name: 'Change your password' })).toBeInTheDocument()
    await act(() => router.navigate({ to: '/inbox' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/password'))
    expect(screen.queryByRole('navigation', { name: 'Workspace' })).not.toBeInTheDocument()
    expect(requests.every((request) => request.path === '/me')).toBe(true)
  })

  it.each(['//example.com', '/\\example.com', '/login', '/password?redirect=/inbox', '/x/../login'])(
    'drops unsafe or recursive redirects: %s',
    async (redirect) => {
      const { router } = setup(`/login?redirect=${encodeURIComponent(redirect)}`, true)
      expect(await screen.findByRole('heading', { name: 'Change your password' })).toBeInTheDocument()
      expect(router.state.location.search.redirect).toBeUndefined()
    },
  )

  it('checks password length, confirmation and current password before sending', async () => {
    const user = userEvent.setup()
    const { requests } = setup('/password', true)
    await fillPassword(user, 'short')
    await user.click(screen.getByRole('button', { name: 'Update password' }))
    expect(screen.getByText('Enter your current password.')).toBeInTheDocument()
    expect(screen.getByText('Use 12 to 128 characters.')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Current password'), 'initial-password')
    await fillPassword(user, 'a'.repeat(129))
    await user.click(screen.getByRole('button', { name: 'Update password' }))
    expect(screen.getByText('Use 12 to 128 characters.')).toBeInTheDocument()
    await fillPassword(user, 'valid-password', 'different-password')
    await user.click(screen.getByRole('button', { name: 'Update password' }))
    expect(screen.getByText('Passwords do not match.')).toBeInTheDocument()
    expect(requests.some((request) => request.path === '/me/password')).toBe(false)
  })

  it.each([' password-with-space', 'password-with-space ', 'password-with-\u007f'])(
    'rejects disallowed spaces and control characters',
    async (password) => {
      const user = userEvent.setup()
      const { requests } = setup('/password', true)
      await user.type(await screen.findByLabelText('Current password'), 'initial-password')
      await fillPassword(user, password)
      await user.click(screen.getByRole('button', { name: 'Update password' }))
      expect(screen.getByText('Use no control characters or spaces at the start or end.')).toBeInTheDocument()
      expect(requests.some((request) => request.path === '/me/password')).toBe(false)
    },
  )

  it('counts Unicode characters and accepts the upper length boundary', async () => {
    const user = userEvent.setup()
    const { requests } = setup('/password', true)
    await user.type(await screen.findByLabelText('Current password'), 'initial-password')
    await fillPassword(user, '🔑'.repeat(128))
    await user.click(screen.getByRole('button', { name: 'Update password' }))
    expect(await screen.findByText('Password updated')).toBeInTheDocument()
    expect(requests.find((request) => request.path === '/me/password')?.body.new_password).toBe('🔑'.repeat(128))
  })

  it('keeps entered values after wrong current password and connection failure, then retries', async () => {
    const user = userEvent.setup()
    const { fail } = setup('/password', true)
    await user.type(await screen.findByLabelText('Current password'), 'initial-password')
    await fillPassword(user, 'updated-password')
    fail('wrongPassword')
    await user.click(screen.getByRole('button', { name: 'Update password' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Check your current password')
    fail('offline')
    await user.click(screen.getByRole('button', { name: 'Update password' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("Can't reach Baton. Try again.")
    expect(screen.getByLabelText('Current password')).toHaveValue('initial-password')
    expect(screen.getByLabelText('New password')).toHaveValue('updated-password')
    expect(screen.getByLabelText('Confirm new password')).toHaveValue('updated-password')
    fail(null)
    await user.click(screen.getByRole('button', { name: 'Update password' }))
    expect(await screen.findByText('Password updated')).toBeInTheDocument()
  })
})
