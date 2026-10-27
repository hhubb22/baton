import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { sameOrigin } from './bridge.ts'

export function openExternal(url: string) {
  try {
    if (['https:', 'http:'].includes(new URL(url).protocol)) void shell.openExternal(url).catch(() => {})
  } catch {
    /* 无效地址不交给系统。 */
  }
}

export function createWindow(directory: string, origin: string | undefined, version: string, quitting: () => boolean) {
  const window = new BrowserWindow({
    title: 'Baton',
    width: 1120,
    height: 780,
    minWidth: 680,
    minHeight: 480,
    show: false,
    webPreferences: {
      preload: join(directory, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      nodeIntegration: false,
      webviewTag: false,
      additionalArguments: [`--baton-origin=${origin ?? ''}`, `--baton-version=${version}`],
    },
  })
  window.on('close', (event) => {
    if (!quitting()) {
      event.preventDefault()
      window.hide()
    }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (!sameOrigin(url, origin)) {
      event.preventDefault()
      openExternal(url)
    }
  })
  window.webContents.on('will-redirect', (event, url) => {
    if (!sameOrigin(url, origin)) {
      event.preventDefault()
      openExternal(url)
    }
  })
  window.webContents.on('will-frame-navigate', (event) => {
    if (!sameOrigin(event.url, origin)) event.preventDefault()
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  return window
}
