import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import type { BrowserNotification } from '@baton/protocol'
import type { Device } from './types'

// 网页只依赖 preload 的公开协议，不导入桌面进程代码。
export type DesktopStatus = (
  | { registered: false }
  | { registered: true; coordinator_url: string; node_id: string; display_name: string; system: string }
) & {
  state: 'stopped' | 'connecting' | 'restarting' | 'rejected' | 'external' | 'stopping' | 'unregistered' | 'online'
  connection_state?: 'connecting' | 'online' | 'rejected' | 'stopping'
  code?: string
  message?: string
}

export interface DesktopTarget {
  thread_id?: string
  project_id?: string
  node_id?: string
}

export interface DesktopActivity {
  running: number
  waiting: number
  threads: { id: string; title: string }[]
}

export interface DesktopDiagnostics {
  clientVersion: string
  batondVersion: string
  platform: string
  processState: string
  lastExit: { at: string; reason: string } | null
  upgradePhase: string | null
  canRestart: boolean
}

export interface DesktopBridge {
  protocol: 1
  version?: string
  capabilities?: readonly { name: string; version: number }[]
  openLocal?(input: { threadId: string; action: 'reveal' | 'editor' }): Promise<void>
  pickDirectory?(input: { nodeId: string }): Promise<string | null>
  diagnostics?(input: { nodeId: string }): Promise<DesktopDiagnostics>
  restartDaemon?(input: { nodeId: string }): Promise<void>
  openLogs?(input: { nodeId: string }): Promise<void>
  copyDiagnostics?(input: { nodeId: string }): Promise<void>
  notificationCursor?(scope: string): Promise<string | null>
  deliverNotifications?(input: { scope: string; events: BrowserNotification[]; cursor: string | null }): Promise<void>
  viewingThread?(threadId: string | null): Promise<void>
  onOpenTarget?(callback: (target: DesktopTarget) => void): () => void
  setActivity?(activity: DesktopActivity): Promise<void>
  status(): Promise<DesktopStatus>
  onStatus(callback: (status: DesktopStatus) => void): () => void
  enroll(input: { code: string; displayName?: string }): Promise<DesktopStatus>
  reauth(input: { code: string }): Promise<DesktopStatus>
}

declare global {
  interface Window {
    batonDesktop?: DesktopBridge
  }
}

export const desktopBridge = () => (window.batonDesktop?.protocol === 1 ? window.batonDesktop : null)
type DesktopCapability = 'notifications' | 'tray-status' | 'open-local' | 'pick-directory' | 'diagnostics'

export function desktopCapability(name: DesktopCapability) {
  const bridge = desktopBridge()
  return bridge?.capabilities?.some((capability) => capability.name === name && capability.version === 1)
    ? bridge
    : null
}

const statusKey = ['desktop', 'status'] as const
const statusSubscriptions = new WeakMap<
  QueryClient,
  WeakMap<DesktopBridge, { subscribers: number; unsubscribe: () => void }>
>()

function updateDesktopStatus(cache: QueryClient, status: DesktopStatus) {
  void cache.cancelQueries({ queryKey: statusKey })
  cache.setQueryData(statusKey, status)
}

function subscribeDesktopStatus(cache: QueryClient, bridge: DesktopBridge) {
  let bridges = statusSubscriptions.get(cache)
  if (!bridges) {
    bridges = new WeakMap()
    statusSubscriptions.set(cache, bridges)
  }
  let subscription = bridges.get(bridge)
  if (!subscription) {
    subscription = {
      subscribers: 0,
      unsubscribe: bridge.onStatus((status) => updateDesktopStatus(cache, status)),
    }
    bridges.set(bridge, subscription)
  }
  subscription.subscribers++
  return () => {
    subscription.subscribers--
    if (subscription.subscribers === 0) {
      subscription.unsubscribe()
      bridges.delete(bridge)
    }
  }
}

export function useDesktopStatus() {
  const bridge = desktopBridge()
  const cache = useQueryClient()
  const query = useQuery({
    queryKey: statusKey,
    queryFn: () => bridge!.status(),
    enabled: bridge !== null,
    refetchOnMount: 'always',
  })
  const update = (status: DesktopStatus) => updateDesktopStatus(cache, status)
  useEffect(() => {
    if (!bridge) return
    return subscribeDesktopStatus(cache, bridge)
  }, [bridge, cache])
  return { ...query, bridge, update }
}

export function useLocalDesktop(nodeId: string | null, capability: DesktopCapability) {
  const desktop = useDesktopStatus()
  const status = desktop.data
  const bridge = desktopCapability(capability)
  const local = status?.registered && status.node_id === nodeId
  return { bridge: local ? bridge : null, status }
}

export function needsDesktopReauth(status: DesktopStatus, devices: Device[]) {
  return (
    status.registered &&
    (status.code === 'needs_reauth' ||
      devices.some((device) => device.id === status.node_id && device.credentialState === 'idle_expired'))
  )
}

export function desktopStatusLabel(status: DesktopStatus) {
  const labels: Record<DesktopStatus['state'], string> = {
    unregistered: 'Not connected',
    stopped: 'Stopped',
    connecting: 'Connecting…',
    restarting: 'Reconnecting…',
    rejected: 'Connection refused',
    external: 'Managed by external service',
    stopping: 'Stopping…',
    online: 'Online',
  }
  return labels[status.state]
}

export function desktopErrorMessage(error: unknown, secret = '') {
  const raw =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : 'Could not connect this computer. Try again.'
  const message = raw.replace(
    /^Error invoking remote method 'baton:(?:enroll|reauth|status|open-local|pick-directory|diagnostics|restart-daemon|open-logs|copy-diagnostics)': (?:Error: )?/,
    '',
  )
  const messages: Record<string, string> = {
    '接入凭据已过期，请在中心重新领取': 'Setup code expired. Try again.',
    '接入参数无效，请重新领取接入凭据': 'Could not use this setup code. Try again.',
    'batond 操作失败，请检查设备状态或重新领取接入凭据':
      'Could not connect this computer. Check its status and try again.',
    '请先停止外部 batond 服务，再重新认证': 'Stop the external device service before reconnecting.',
    '本机已接入，请使用已有身份或重新认证': 'This computer is already connected. Check its status.',
    'batond 命令超时，请检查本机设备状态后重试': 'This computer did not respond. Check its status and try again.',
    '无法运行内置 batond，请重新安装客户端': 'Reinstall the desktop app to connect this computer.',
    '无法启动内置 batond': 'Could not start this computer. Reinstall the desktop app.',
    '无法读取本机设备状态，请检查日志': "Couldn't read this computer's status. Check its logs.",
    'batond 在 60 秒内连续失败 5 次，请检查日志后重启':
      'This computer stopped after repeated failures. Check its logs and restart the desktop app.',
  }
  const translated = messages[message] ?? message
  return secret ? translated.replaceAll(secret, '[hidden]') : translated
}

export function desktopStatusReason(status: DesktopStatus) {
  if (status.code === 'needs_reauth') return 'Sign-in expired on this computer.'
  if (status.code === 'node_version_incompatible') return 'Download the latest desktop app from Baton.'
  return status.message ? desktopErrorMessage(status.message) : null
}
