import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import type { BrowserNotification } from '@baton/protocol'
import { keys } from './queries'

// 网页只依赖 preload 的公开协议，不导入桌面进程代码。
export type DesktopState = 'unbound' | 'authorizing' | 'connecting' | 'syncing' | 'online' | 'rejected' | 'stopped'

export interface DesktopLogin {
  session_id: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_at: string
  expires_in_seconds: number
}

export interface DesktopStatus {
  state: DesktopState
  registered: boolean
  pid?: number
  batond_version?: string
  protocol_version?: number
  platform?: string
  coordinator_url?: string
  node_id?: string
  employee_id?: string
  display_name?: string
  rejection?: { code: string; message: string; at: string }
  pending_login?: DesktopLogin & { status: 'pending' }
  last_error?: { code: string; message: string; at: string }
  service_installed?: boolean
}

export type StartLoginResult =
  | { status: 'pending'; login: DesktopLogin }
  | { status: 'already_bound'; device: DesktopStatus }

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
  setModelConnectionKey?(input: { nodeId: string; connectionId: string; key: string }): Promise<void>
  notificationCursor?(scope: string): Promise<string | null>
  deliverNotifications?(input: { scope: string; events: BrowserNotification[]; cursor: string | null }): Promise<void>
  viewingThread?(threadId: string | null): Promise<void>
  onOpenTarget?(callback: (target: DesktopTarget) => void): () => void
  setActivity?(activity: DesktopActivity): Promise<void>
  status(): Promise<DesktopStatus>
  onStatus(callback: (status: DesktopStatus) => void): () => void
  startLogin(input?: { displayName?: string }): Promise<StartLoginResult>
  cancelLogin(): Promise<void>
  logout(): Promise<DesktopStatus>
}

declare global {
  interface Window {
    batonDesktop?: DesktopBridge
  }
}

export const desktopBridge = () => (window.batonDesktop?.protocol === 1 ? window.batonDesktop : null)
type DesktopCapability =
  | 'notifications'
  | 'tray-status'
  | 'open-local'
  | 'pick-directory'
  | 'diagnostics'
  | 'model-connection-key'
  | 'device-login'

export function desktopCapability(name: DesktopCapability) {
  const bridge = desktopBridge()
  return bridge?.capabilities?.some((capability) => capability.name === name && capability.version === 1)
    ? bridge
    : null
}

const statusSubscriptions = new WeakMap<
  QueryClient,
  WeakMap<DesktopBridge, { subscribers: number; unsubscribe: () => void }>
>()

function updateDesktopStatus(cache: QueryClient, status: DesktopStatus) {
  void cache.cancelQueries({ queryKey: keys.desktopStatus })
  cache.setQueryData(keys.desktopStatus, status)
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
    queryKey: keys.desktopStatus,
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

export function desktopStatusLabel(status: DesktopStatus) {
  const labels: Record<DesktopState, string> = {
    unbound: '未连接',
    authorizing: '等待确认…',
    connecting: '正在连接…',
    syncing: '正在同步…',
    online: '在线',
    rejected: '连接被拒绝',
    stopped: '已停止',
  }
  return labels[status.state]
}

export function desktopErrorMessage(error: unknown, secret = '') {
  const raw = typeof error === 'string' ? error : error instanceof Error ? error.message : '无法连接此电脑，请重试。'
  const message = raw.replace(/^Error invoking remote method 'baton:[^']+': (?:Error: )?/, '')
  const messages: Record<string, string> = {
    请先打开中心的接入链接: '请从中心重新打开接入链接。',
    设备名称无效: '设备名称无效，请重试。',
    '请先连接此电脑。': '此电脑还没有连接，请重试。',
    '本机设备属于其他中心。': '此电脑已连接到其他中心。',
    '无法打开此文件夹。': '无法打开此文件夹。',
    '无法打开日志文件夹。': '无法打开日志文件夹。',
    '当前无法重启设备服务。': '当前无法重启设备服务。',
    '本机未能开始设备登录，请重试。': '无法开始设备登录，请重试。',
  }
  const translated = messages[message] ?? message
  return secret ? translated.replaceAll(secret, '[hidden]') : translated
}

export function desktopStatusReason(status: DesktopStatus) {
  if (status.rejection) return desktopErrorMessage(status.rejection.message)
  return status.last_error ? desktopErrorMessage(status.last_error.message) : null
}
