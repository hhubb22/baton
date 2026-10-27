import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'

const execute = promisify(execFile)

export function windowsNotificationsDisabled(output: string) {
  return /\b(?:Enabled|ToastEnabled)\s+REG_DWORD\s+0x0\b/i.test(output)
}

export async function notificationsDisabled(
  platform = process.platform,
  resources = process.resourcesPath,
): Promise<boolean | null> {
  try {
    if (platform === 'darwin') {
      const native = createRequire(__filename)(join(resources, 'notification-permission.node')) as {
        getStatus(): string
      }
      const status = native.getStatus()
      return status === 'unknown' ? null : status === 'denied'
    }
    if (platform === 'win32') {
      const keys = [
        ['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications', 'ToastEnabled'],
        ['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\dev.baton.desktop', 'Enabled'],
      ]
      const values = await Promise.all(
        keys.map(async ([key, value]) => {
          try {
            const { stdout } = await execute('reg.exe', ['query', key!, '/v', value!], { timeout: 5000 })
            return windowsNotificationsDisabled(stdout)
          } catch (error) {
            // 尚未设置的注册表项使用系统默认通知权限。
            if (error instanceof Error && 'code' in error && error.code === 1) return false
            throw error
          }
        }),
      )
      return values.some(Boolean)
    }
    return null
  } catch {
    return null
  }
}

export const notificationSettingsURL = (platform = process.platform) =>
  platform === 'darwin'
    ? 'x-apple.systempreferences:com.apple.Notifications-Settings.extension'
    : 'ms-settings:notifications'
