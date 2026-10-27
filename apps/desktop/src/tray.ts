import { Menu, Tray, nativeImage } from 'electron'
import type { DesktopStatus } from './status.ts'

const labels: Record<DesktopStatus['state'], string> = {
  unregistered: '未接入',
  connecting: '连接中',
  online: '在线',
  rejected: '已拒绝',
  external: '由外部服务运行',
  restarting: '等待重启',
  stopping: '正在停止',
  stopped: '已停止',
}

export function createTray(actions: {
  open: () => void
  restart: () => void
  logs: () => void
  quit: () => void
  loginEnabled: () => boolean
  setLogin: (enabled: boolean) => void
}) {
  const pixels = Buffer.alloc(16 * 16 * 4)
  for (let y = 2; y < 14; y++)
    for (let x = 4; x < 12; x++) {
      if (x < 6 || ([2, 7, 13].includes(y) && x < 10) || (x >= 10 && ![2, 7, 13].includes(y)))
        pixels[(y * 16 + x) * 4 + 3] = 255
    }
  const image = nativeImage.createFromBitmap(pixels, { width: 16, height: 16, scaleFactor: 1 })
  image.setTemplateImage(true)
  const tray = new Tray(image)
  tray.on('click', actions.open)
  return {
    update(status: DesktopStatus) {
      const label = labels[status.state]
      const reason = status.code ? `${status.code}：${status.message ?? ''}` : status.message
      tray.setToolTip(`Baton · ${label}${reason ? ` · ${reason}` : ''}`)
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label, enabled: false },
          ...(reason ? [{ label: reason.slice(0, 160), enabled: false }] : []),
          { type: 'separator' },
          { label: '打开窗口', click: actions.open },
          { label: '重启 batond', click: actions.restart },
          { label: '打开日志目录', click: actions.logs },
          {
            label: '登录时启动',
            type: 'checkbox',
            checked: actions.loginEnabled(),
            click: (item) => actions.setLogin(item.checked),
          },
          { type: 'separator' },
          { label: '退出', click: actions.quit },
        ]),
      )
    },
    destroy() {
      tray.destroy()
    },
  }
}
