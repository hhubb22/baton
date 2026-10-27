import { vi } from 'vite-plus/test'
import type { DesktopBridge, DesktopStatus } from '../data/desktop'

export function createDesktopBridge(initial: DesktopStatus = { registered: false, state: 'unregistered' }) {
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
    enroll: vi.fn<DesktopBridge['enroll']>(async () => current),
    reauth: vi.fn<DesktopBridge['reauth']>(async () => current),
  }
  return {
    bridge,
    listeners,
    publish(status: DesktopStatus) {
      current = status
      for (const listener of listeners) listener(status)
    },
  }
}

export const registeredDesktop: DesktopStatus = {
  registered: true,
  coordinator_url: window.location.origin,
  node_id: 'dev-mac',
  display_name: 'Local computer',
  system: 'macos',
  state: 'online',
}
