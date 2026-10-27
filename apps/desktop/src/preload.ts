import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopStatus } from './status.ts'

const originArgument = process.argv.find((argument) => argument.startsWith('--baton-origin='))
const origin = originArgument?.slice('--baton-origin='.length)
if (process.isMainFrame && origin && location.origin === origin) {
  contextBridge.exposeInMainWorld(
    'batonDesktop',
    Object.freeze({
      protocol: 1,
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
      enroll: (input: { code: string; displayName?: string }): Promise<DesktopStatus> =>
        ipcRenderer.invoke('baton:enroll', input),
      reauth: (input: { code: string }): Promise<DesktopStatus> => ipcRenderer.invoke('baton:reauth', input),
    }),
  )
}
