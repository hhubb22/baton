import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopStatus, StartLoginResult } from './status.ts'
import type { Activity, NativeNotice, NotificationTarget } from './notifications.ts'
import { desktopCapabilities } from './capabilities.ts'
import { canExposeBridge } from './bridge.ts'
import type { DesktopDiagnostics } from './diagnostics.ts'

const originArgument = process.argv.find((argument) => argument.startsWith('--baton-origin='))
const origin = originArgument?.slice('--baton-origin='.length)
if (canExposeBridge(process.isMainFrame, location.origin, origin)) {
  contextBridge.exposeInMainWorld(
    'batonDesktop',
    Object.freeze({
      protocol: 1,
      capabilities: desktopCapabilities,
      openLocal: (input: { threadId: string; action: 'reveal' | 'editor' }): Promise<void> =>
        ipcRenderer.invoke('baton:open-local', input),
      pickDirectory: (input: { nodeId: string }): Promise<string | null> =>
        ipcRenderer.invoke('baton:pick-directory', input),
      diagnostics: (input: { nodeId: string }): Promise<DesktopDiagnostics> =>
        ipcRenderer.invoke('baton:diagnostics', input),
      restartDaemon: (input: { nodeId: string }): Promise<void> => ipcRenderer.invoke('baton:restart-daemon', input),
      openLogs: (input: { nodeId: string }): Promise<void> => ipcRenderer.invoke('baton:open-logs', input),
      copyDiagnostics: (input: { nodeId: string }): Promise<void> =>
        ipcRenderer.invoke('baton:copy-diagnostics', input),
      setModelConnectionKey: (input: { nodeId: string; connectionId: string; key: string }): Promise<void> =>
        ipcRenderer.invoke('baton:model-connection-key', input),
      notificationCursor: (scope: string): Promise<string | null> =>
        ipcRenderer.invoke('baton:notification-cursor', scope),
      deliverNotifications: (input: { scope: string; events: NativeNotice[]; cursor: string | null }): Promise<void> =>
        ipcRenderer.invoke('baton:notifications', input),
      setActivity: (activity: Activity): Promise<void> => ipcRenderer.invoke('baton:activity', activity),
      viewingThread: (threadId: string | null): Promise<void> => ipcRenderer.invoke('baton:viewing-thread', threadId),
      onOpenTarget(callback: (target: NotificationTarget) => void) {
        if (typeof callback !== 'function') throw new Error('导航订阅需要回调函数')
        const listener = (_event: Electron.IpcRendererEvent, target: NotificationTarget) => callback(target)
        ipcRenderer.on('baton:open-target', listener)
        void ipcRenderer.invoke('baton:target-ready').catch(() => {})
        return () => {
          ipcRenderer.removeListener('baton:open-target', listener)
          void ipcRenderer.invoke('baton:target-unready').catch(() => {})
        }
      },
      version: process.argv
        .find((argument) => argument.startsWith('--baton-version='))
        ?.slice('--baton-version='.length),
      status: (): Promise<DesktopStatus> => ipcRenderer.invoke('baton:status'),
      onStatus(callback: (status: DesktopStatus) => void) {
        if (typeof callback !== 'function') throw new Error('状态订阅需要回调函数')
        const listener = (_event: Electron.IpcRendererEvent, status: DesktopStatus) => callback(status)
        ipcRenderer.on('baton:status-changed', listener)
        return () => {
          ipcRenderer.removeListener('baton:status-changed', listener)
        }
      },
      startLogin: (input: { displayName?: string } = {}): Promise<StartLoginResult> =>
        ipcRenderer.invoke('baton:start-login', input),
      cancelLogin: (): Promise<void> => ipcRenderer.invoke('baton:cancel-login'),
      logout: (): Promise<DesktopStatus> => ipcRenderer.invoke('baton:logout'),
    }),
  )
}
