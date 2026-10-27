import type { DesktopStatus } from './status.ts'
import type { Activity } from './notifications.ts'

export const trayLabels: Record<DesktopStatus['state'], string> = {
  unregistered: 'Not connected',
  connecting: 'Connecting…',
  online: '',
  rejected: 'Rejected',
  external: 'Managed by an external service',
  restarting: 'Reconnecting…',
  stopping: 'Stopping…',
  stopped: 'Stopped',
}

export function traySummary(activity: Activity) {
  return `${activity.running} running · ${activity.waiting} waiting for you`
}

export function trayPixels(waiting: boolean) {
  const pixels = Buffer.alloc(16 * 16 * 4)
  for (let y = 2; y < 14; y++)
    for (let x = 4; x < 12; x++) {
      if (x < 6 || ([2, 7, 13].includes(y) && x < 10) || (x >= 10 && ![2, 7, 13].includes(y)))
        pixels[(y * 16 + x) * 4 + 3] = 255
    }
  if (waiting)
    for (let y = 0; y < 5; y++)
      for (let x = 11; x < 16; x++) if ((x - 13) ** 2 + (y - 2) ** 2 <= 5) pixels[(y * 16 + x) * 4 + 3] = 255
  return pixels
}
