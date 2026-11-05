import { vi } from 'vite-plus/test'
import type { DesktopBridge, DesktopStatus, StartLoginResult } from '../data/desktop'

export function createDesktopBridge(initial: DesktopStatus = { registered: false, state: 'unbound' }) {
  let current = initial
  const listeners = new Set<(status: DesktopStatus) => void>()
  const bridge = {
    protocol: 1 as const,
    status: vi.fn(async () => current),
    onStatus: vi.fn((listener: (status: DesktopStatus) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }),
    startLogin: vi.fn<DesktopBridge['startLogin']>(async () => ({
      status: 'pending',
      login: {
        session_id: 'device-login-session',
        user_code: 'ABCD-EFGH',
        verification_uri: `${window.location.origin}/device-login`,
        verification_uri_complete: `${window.location.origin}/device-login?code=ABCD-EFGH`,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        expires_in_seconds: 600,
      },
    })),
    cancelLogin: vi.fn<DesktopBridge['cancelLogin']>(async () => {}),
    logout: vi.fn<DesktopBridge['logout']>(async () => current),
  } satisfies DesktopBridge
  return {
    bridge,
    listeners,
    publish(status: DesktopStatus) {
      current = status
      for (const listener of listeners) listener(status)
    },
    resolve(result: StartLoginResult) {
      bridge.startLogin.mockResolvedValueOnce(result)
    },
  }
}

export const registeredDesktop: DesktopStatus = {
  registered: true,
  coordinator_url: window.location.origin,
  node_id: 'dev-mac',
  display_name: 'Local computer',
  state: 'online',
}
