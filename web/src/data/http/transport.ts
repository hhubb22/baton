import { ClientError } from '../client'
import { clearFailure, recordFailure, resetFailures } from '../../telemetry/diagnostics'

export interface ErrorPayload {
  code?: string
  error?: string
  message?: string
  current?: unknown
  [key: string]: unknown
}

const messages: Record<string, string> = {
  invalid_credentials: '用户名或密码错误。',
  password_change_required: '请先修改初始密码。',
  invalid_password: '密码需为 12 至 128 个字符，不能使用用户名或常见密码。',
  password_reused: '请使用其他密码。',
  csrf_rejected: '登录状态需要刷新，请重试。',
  origin_rejected: '此地址无权访问 Baton。',
  forbidden: '你无权访问此内容。',
  revoked: '此设备已从 Baton 断开。',
  path_changed: '文件夹正在更改，请稍后重试。',
  directory_changed: '文件夹已更改，请重新加载。',
  roots_changed: '允许访问的文件夹已更改，请重新加载列表。',
  file_changed: '文件已更改，请重新加载后继续阅读。',
  thinking_unavailable: '模型的思考强度选项已变更，请重新选择。',
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
          ? 'Baton 无法完成请求，请重试。'
          : status === 409
            ? '记录已更改，请查看最新内容。'
            : status === 404
              ? '此记录已不可用。'
              : 'Baton 无法接受请求，请检查输入后重试。'),
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
  const fetcher: typeof fetch = options.fetch ?? ((...args) => globalThis.fetch(...args))
  const base = (options.baseUrl ?? '/api/v1').replace(/\/$/, '')
  let csrf: string | null = null
  let telemetry: typeof import('../../telemetry/index') | undefined
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
      recordFailure(path, null, 'unavailable')
      throw new ClientError('unavailable', '无法连接 Baton，请检查网络后重试。')
    }
    const payload = response.status === 204 ? null : ((await response.json().catch(() => null)) as ErrorPayload | null)
    if (!response.ok) {
      recordFailure(path, response.headers.get('traceresponse'), payload?.code)
      if (response.status === 403 && payload?.code === 'csrf_rejected' && retry) {
        csrf = null
        await request('/me')
        return request<T>(path, init, false)
      }
      if (response.status === 401 && path !== '/login' && path !== '/me/password') {
        csrf = null
        telemetry?.stopTelemetry()
        resetFailures()
        options.onUnauthorized?.()
      }
      throw new HttpError(response.status, payload ?? {})
    }
    if (response.status !== 204 && payload === null)
      throw new ClientError('unavailable', 'Baton 返回了无法读取的内容，请重试。')
    clearFailure(path)
    if (payload && typeof payload.csrf_token === 'string') csrf = payload.csrf_token
    if (path === '/me' && payload) {
      const config = payload.telemetry
      if (
        config &&
        typeof config === 'object' &&
        'endpoint' in config &&
        'key' in config &&
        typeof config.endpoint === 'string' &&
        config.endpoint &&
        typeof config.key === 'string' &&
        config.key
      ) {
        try {
          telemetry ??= await import('../../telemetry/index')
          telemetry.startTelemetry({
            endpoint: config.endpoint,
            key: config.key,
            ...('session_replay' in config && config.session_replay === 'masked' ? { session_replay: 'masked' } : {}),
          })
        } catch {
          try {
            telemetry?.stopTelemetry()
          } catch {
            /* 遥测不可用时继续使用 Baton。 */
          }
        }
      } else telemetry?.stopTelemetry()
    }
    return payload as T
  }
  return {
    request,
    traceSocket: (socket: WebSocket) => telemetry?.traceSocket(socket),
    clear: () => {
      csrf = null
      telemetry?.stopTelemetry()
      resetFailures()
    },
  }
}
