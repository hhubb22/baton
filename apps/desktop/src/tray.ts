import { Menu, Tray, nativeImage } from 'electron'
import type { DesktopStatus } from './status.ts'
import { emptyActivity, type Activity } from './notifications.ts'
import { trayLabels, trayPixels, traySummary } from './tray-model.ts'

export function createTray(actions: {
  open: () => void
  restart: () => void
  restartAvailable: () => boolean
  update: () => void
  updateLabel: () => string
  logs: () => void
  quit: () => void
  loginEnabled: () => boolean
  setLogin: (enabled: boolean) => void
  notificationsEnabled: () => boolean
  setNotifications: (enabled: boolean) => void
  notificationSettings: () => void
  settings: () => void
  openThread: (id: string) => void
}) {
  const image = (waiting: boolean) => {
    const result = nativeImage.createFromBitmap(trayPixels(waiting), { width: 16, height: 16, scaleFactor: 1 })
    result.setTemplateImage(true)
    return result
  }
  const dotPixels = Buffer.alloc(8 * 8 * 4)
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      if ((x - 3.5) ** 2 + (y - 3.5) ** 2 <= 10) {
        const offset = (y * 8 + x) * 4
        dotPixels[offset + 1] = 150
        dotPixels[offset + 3] = 255
      }
    }
  const onlineIcon = nativeImage.createFromBitmap(dotPixels, { width: 8, height: 8 })
  const tray = new Tray(image(false))
  tray.on('click', actions.open)
  return {
    update(status: DesktopStatus, activity: Activity = emptyActivity, notificationsDisabled: boolean | null = null) {
      const label = trayLabels[status.state]
      const reason = status.message ?? status.code
      const name = status.registered ? status.display_name : 'Baton'
      const summary = traySummary(activity)
      tray.setImage(image(activity.waiting > 0))
      tray.setToolTip(`${name}${label ? ` · ${label}` : ''} · ${summary}${reason ? ` · ${reason}` : ''}`)
      tray.setContextMenu(
        Menu.buildFromTemplate([
          {
            label: `${name}${label ? ` · ${label}` : ''}`,
            enabled: false,
            ...(status.state === 'online' ? { icon: onlineIcon } : {}),
          },
          ...(reason ? [{ label: reason.slice(0, 160), enabled: false }] : []),
          { type: 'separator' },
          { label: summary, enabled: false },
          ...activity.threads.slice(0, 5).map((thread) => ({
            label: thread.title.replaceAll('&', '&&'),
            click: () => actions.openThread(thread.id),
          })),
          { type: 'separator' },
          {
            label: '通知',
            type: 'checkbox',
            checked: actions.notificationsEnabled(),
            click: (item) => actions.setNotifications(item.checked),
          },
          ...(notificationsDisabled === true
            ? [
                { label: '已在系统设置中关闭', enabled: false },
                { label: '打开通知设置', click: actions.notificationSettings },
              ]
            : []),
          {
            label: '登录时启动',
            type: 'checkbox',
            checked: actions.loginEnabled(),
            click: (item) => actions.setLogin(item.checked),
          },
          { label: '设置…', click: actions.settings },
          { type: 'separator' },
          { label: '打开 Baton', click: actions.open },
          { label: actions.updateLabel(), click: actions.update },
          ...(status.state === 'external' || !actions.restartAvailable()
            ? []
            : [{ label: '重启设备服务', click: actions.restart }]),
          { label: '打开日志文件夹', click: actions.logs },
          { label: '退出 Baton', click: actions.quit },
        ]),
      )
    },
    destroy() {
      tray.destroy()
    },
  }
}
