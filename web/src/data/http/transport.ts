import { ClientError } from '../client'

export interface ErrorPayload {
  code?: string
  error?: string
  message?: string
  current?: unknown
  [key: string]: unknown
}

const messages: Record<string, string> = {
  invalid_credentials: 'Invalid username or password.',
  password_change_required: 'Change your initial password to continue.',
  invalid_password: 'Use 12–128 characters and avoid your username or a common password.',
  password_reused: 'Choose a different password.',
  csrf_rejected: 'Your sign-in needs to be refreshed. Try again.',
  origin_rejected: 'This address is not allowed to access Baton.',
  forbidden: 'You do not have access to this resource.',
  revoked: 'This device was disconnected from Baton.',
  path_changed: 'The folder is changing. Retry when it settles.',
  directory_changed: 'The folder changed. Reload it to see all entries.',
  roots_changed: 'Allowed folders changed. Reload the list.',
  file_changed: 'The file changed. Reload it to continue reading.',
}

export class HttpError extends ClientError {
  readonly status: number
  readonly payload: ErrorPayload
  constructor(status: number, payload: ErrorPayload) {
    const code = payload.code ?? payload.error ?? ''
    super(
      status === 401
        ? 'unauthorized'
        : status === 404
          ? 'notFound'
          : status === 409
            ? 'conflict'
            : status >= 500
              ? 'unavailable'
              : 'invalid',
      messages[code] ??
        (status >= 500
          ? 'Baton could not complete this request. Try again.'
          : status === 409
            ? 'This record changed. Review the latest result.'
            : status === 404
              ? 'This record is no longer available.'
              : 'Baton could not accept this request. Check your input and try again.'),
    )
    this.status = status
    this.payload = payload
  }
}

export interface TransportOptions {
  fetch?: typeof fetch
  baseUrl?: string
  onUnauthorized?: () => void
}

export function createTransport(options: TransportOptions = {}) {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
  const base = (options.baseUrl ?? '/api/v1').replace(/\/$/, '')
  let csrf: string | null = null
  const request = async <T>(path: string, init: RequestInit = {}, retry = true): Promise<T> => {
    const method = (init.method ?? 'GET').toUpperCase()
    const write = method !== 'GET' && method !== 'HEAD'
    if (write && !csrf && path !== '/login') await request<{ csrf_token?: string }>('/me')
    const headers = new Headers(init.headers)
    headers.set('Accept', 'application/json')
    if (init.body !== undefined) headers.set('Content-Type', 'application/json')
    if (write && csrf) headers.set('X-CSRF-Token', csrf)
    let response: Response
    try {
      response = await fetcher(`${base}${path}`, { ...init, headers, credentials: 'same-origin', cache: 'no-store' })
    } catch {
      throw new ClientError('unavailable', 'Baton could not be reached. Check your connection and try again.')
    }
    const payload = response.status === 204 ? null : ((await response.json().catch(() => null)) as ErrorPayload | null)
    if (!response.ok) {
      if (response.status === 403 && payload?.code === 'csrf_rejected' && retry) {
        csrf = null
        await request('/me')
        return request<T>(path, init, false)
      }
      if (response.status === 401 && path !== '/login' && path !== '/me/password') {
        csrf = null
        options.onUnauthorized?.()
      }
      throw new HttpError(response.status, payload ?? {})
    }
    if (response.status !== 204 && payload === null)
      throw new ClientError('unavailable', 'Baton returned an unreadable response. Try again.')
    if (payload && typeof payload.csrf_token === 'string') csrf = payload.csrf_token
    return payload as T
  }
  return {
    request,
    clear: () => {
      csrf = null
    },
  }
}
