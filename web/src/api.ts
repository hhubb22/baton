import { isNodeID } from './model.ts'
import type { Enrollment, LoginResponse, MeResponse, NodeList, RevokeResult, SavedDefault } from './types.ts'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly requestId: string

  constructor(status: number, code: string, message: string, requestId: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.requestId = requestId
  }
}

type Options = {
  method?: string
  body?: unknown
  csrf?: string
}

export function messageOf(err: unknown): string {
  if (err instanceof ApiError) {
    return err.requestId ? `${err.message}（${err.requestId}）` : err.message
  }
  return '无法连接服务'
}

export async function request<T>(path: string, options: Options = {}): Promise<T> {
  const headers = new Headers()
  if (options.body !== undefined) headers.set('Content-Type', 'application/json')
  if (options.csrf) headers.set('X-CSRF-Token', options.csrf)
  let response: Response
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
  } catch {
    throw new ApiError(0, 'unavailable', '无法连接服务', '')
  }
  if (response.status === 204) return undefined as T
  const text = await response.text()
  let payload: unknown = null
  if (text) {
    try {
      payload = JSON.parse(text) as unknown
    } catch {
      payload = null
    }
  }
  if (!response.ok) {
    const parsed = asError(payload)
    throw new ApiError(response.status, parsed.code, parsed.message, parsed.requestId)
  }
  if (payload === null) throw new ApiError(response.status, 'invalid_response', '响应格式不正确', '')
  return payload as T
}

export function login(username: string, password: string): Promise<LoginResponse> {
  return request<LoginResponse>('/api/v1/login', {
    method: 'POST',
    body: { username, password },
  })
}

export function logout(csrf: string): Promise<void> {
  return request<void>('/api/v1/logout', { method: 'POST', csrf })
}

export function getMe(): Promise<MeResponse> {
  return request<MeResponse>('/api/v1/me')
}

export function changePassword(csrf: string, currentPassword: string, newPassword: string): Promise<MeResponse> {
  return request<MeResponse>('/api/v1/me/password', {
    method: 'POST',
    csrf,
    body: { current_password: currentPassword, new_password: newPassword },
  })
}

export function getNodes(): Promise<NodeList> {
  return request<NodeList>('/api/v1/nodes')
}

export function issueEnrollment(csrf: string): Promise<Enrollment> {
  return request<Enrollment>('/api/v1/node-enrollments', {
    method: 'POST',
    csrf,
    body: {},
  })
}

export async function putDefaultPC(csrf: string, nodeId: string): Promise<SavedDefault> {
  if (!isNodeID(nodeId)) throw new ApiError(400, 'invalid_id', '节点标识不正确', '')
  return request<SavedDefault>('/api/v1/me/default-pc', {
    method: 'PUT',
    csrf,
    body: { node_id: nodeId },
  })
}

export async function revokeNode(csrf: string, nodeId: string): Promise<RevokeResult> {
  if (!isNodeID(nodeId)) throw new ApiError(400, 'invalid_id', '节点标识不正确', '')
  return request<RevokeResult>(`/api/v1/nodes/${nodeId}/revoke`, {
    method: 'POST',
    csrf,
    body: {},
  })
}

function asError(payload: unknown): { code: string; message: string; requestId: string } {
  if (!payload || typeof payload !== 'object') {
    return { code: 'invalid_response', message: '请求失败', requestId: '' }
  }
  const body = payload as Record<string, unknown>
  return {
    code: typeof body.code === 'string' ? body.code : 'invalid_response',
    message: typeof body.message === 'string' ? body.message : '请求失败',
    requestId: typeof body.request_id === 'string' ? body.request_id : '',
  }
}
