import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, getNodeFiles, login, logout, messageOf, putDefaultPC, revokeNode } from './api.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('API 客户端', () => {
  it('使用 Cookie 会话和 CSRF 头，不发送 bearer', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('Authorization')).toBeNull()
      expect(init?.credentials).toBe('same-origin')
      if (String(_input).endsWith('/login')) {
        expect(headers.get('X-CSRF-Token')).toBeNull()
        return json({
          employee: {
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            username: 'alice',
            display_name: 'Alice',
            auth_source: 'local',
            must_change_password: false,
          },
          csrf_token: 'csrf-token-value-0123456789',
          expires_at: '2026-10-18T00:00:00Z',
        })
      }
      expect(headers.get('X-CSRF-Token')).toBe('csrf-token-value-0123456789')
      return new Response(null, { status: 204 })
    })
    vi.stubGlobal('fetch', fetchMock)
    await login('alice', 'correct-horse-battery')
    await logout('csrf-token-value-0123456789')
    expect(localStorage.length).toBe(0)
  })

  it('错误文案来自服务端，且非法节点标识不会发出请求', async () => {
    const fetchMock = vi.fn(async () => json({
      code: 'invalid_credentials',
      message: '账号或口令不正确',
      request_id: 'req-9',
    }, 401))
    vi.stubGlobal('fetch', fetchMock)
    await expect(login('alice', 'wrong-password-1')).rejects.toMatchObject({
      code: 'invalid_credentials',
      message: '账号或口令不正确',
      requestId: 'req-9',
    })
    expect(messageOf(new ApiError(401, 'invalid_credentials', '账号或口令不正确', 'req-9'))).toBe('账号或口令不正确（req-9）')
    await expect(putDefaultPC('csrf-token-value-0123456789', '../other')).rejects.toMatchObject({ code: 'invalid_id' })
    await expect(revokeNode('csrf-token-value-0123456789', 'not-a-uuid')).rejects.toMatchObject({ code: 'invalid_id' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('文件浏览只提交 root_id 和相对路径', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method ?? 'GET').toBe('GET')
      expect(new Headers(init?.headers).get('X-CSRF-Token')).toBeNull()
      expect(String(input)).toBe('/api/v1/nodes/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/files?root_id=notes&path=docs%2Fhello.txt')
      expect(String(input)).not.toContain('offset')
      return json({
        operation_id: 'op-1',
        node_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        kind: 'file',
        content: 'hello',
        truncated: false,
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const view = await getNodeFiles('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { root_id: 'notes', path: 'docs/hello.txt' })
    expect(view.content).toBe('hello')
    await expect(getNodeFiles('/etc/passwd')).rejects.toMatchObject({ code: 'invalid_id' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
