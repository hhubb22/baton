// 由多个查询组合出的界面状态。设备、Thread、Project 各自只存原始状态，
// 页面显示时在这里合并，所以设备状态一变，所有用到它的页面一起更新。
import type { Tone } from '../ui/Status'
import type { Device, FilePreview, ID, InboxItem, Operation, Project, Thread } from './types'

export interface StatusView {
  tone: Tone
  label: string
}

export interface ThreadView {
  status: StatusView
  // 设备不可用时输入区上方的横幅；设备正常时为 null。
  notice: { title: string; detail: string } | null
}

export function deviceStatus(device: Device | undefined): StatusView {
  if (!device) return { tone: 'neutral', label: 'Device removed' }
  switch (device.connection) {
    case 'online':
      return { tone: 'success', label: 'Online' }
    case 'syncing':
      return { tone: 'neutral', label: 'Syncing' }
    case 'offline':
      return { tone: 'neutral', label: 'Offline' }
  }
}

export function threadView(thread: Thread, device: Device | undefined): ThreadView {
  const name = device?.name ?? 'This device'
  const reachable = device?.connection === 'online'
  switch (thread.status) {
    case 'archived':
      return { status: { tone: 'hollow', label: 'Archived' }, notice: null }
    case 'stopped':
      return {
        status: { tone: 'danger', label: 'Stopped' },
        notice: { title: 'Stopped', detail: thread.stopReason ?? 'This thread stopped.' },
      }
    case 'unknown':
      return {
        status: { tone: 'attention', label: 'Status unknown' },
        notice: { title: 'Status unknown', detail: `${name} has not reported this thread since it reconnected.` },
      }
    case 'running':
      if (!reachable) {
        return {
          status: { tone: 'info', label: 'Running' },
          notice: {
            title: `${name} is ${device?.connection === 'syncing' ? 'syncing' : 'offline'}`,
            detail: 'The task keeps running on the device. Updates appear after it reconnects.',
          },
        }
      }
      return { status: { tone: 'info', label: 'Running' }, notice: null }
    case 'waiting':
      return {
        status: { tone: 'neutral', label: 'Waiting for device' },
        notice: { title: `Waiting for ${name}`, detail: 'Your message is saved and will be sent when it connects.' },
      }
    case 'idle':
      if (!reachable) {
        return {
          status: { tone: 'neutral', label: 'Idle' },
          notice: { title: `${name} is offline`, detail: 'New messages wait until it connects.' },
        }
      }
      return { status: { tone: 'neutral', label: 'Idle' }, notice: null }
  }
}

export function projectAgentStatus(project: Project, devices: Device[]): StatusView {
  if (project.status === 'paused') return { tone: 'neutral', label: 'Paused' }
  if (project.status === 'archived') return { tone: 'hollow', label: 'Archived' }
  const device = devices.find((item) => item.id === project.agent.deviceId)
  switch (project.agent.state) {
    case 'running':
      return { tone: 'agent', label: device ? `Running on ${device.name}` : 'Running' }
    case 'waitingDevice':
      return { tone: 'neutral', label: 'Waiting for a device to come online' }
    case 'stopped':
      return { tone: 'danger', label: 'Stopped' }
    case 'idle':
      return { tone: 'neutral', label: 'Idle' }
  }
}

export interface PreviewView {
  title: string
  detail: string
}

// 文件预览只显示从设备实时读到的内容，读不到时只给原因。
export function previewProblem(preview: FilePreview, device: Device | undefined): PreviewView | null {
  if (preview.state === 'ready') return null
  const name = device?.name ?? 'This device'
  const file = preview.path.split(/[\\/]/).pop() ?? preview.path
  switch (preview.reason) {
    case 'offline':
      return { title: `${name} is offline`, detail: `Reconnect ${name}, then retry to view this file.` }
    case 'syncing':
      return { title: `${name} is syncing`, detail: 'Retry when it finishes syncing.' }
    case 'outsideFolders':
      return {
        title: 'Folder is outside allowed paths',
        detail: `${preview.path} is not shared with Baton on ${name}.`,
      }
    case 'missing':
      return { title: `File not found on ${name}`, detail: `${file} may have been moved or deleted.` }
  }
}

export function pendingInbox(items: InboxItem[], projectId?: ID) {
  return items.filter((item) => item.status === 'pending' && (!projectId || item.projectId === projectId))
}

export function onlineSummary(devices: Device[]) {
  if (devices.length === 0) return '0 devices'
  const online = devices.filter((item) => item.connection === 'online').length
  return `${online}/${devices.length} online`
}

export function liveThreads(threads: Thread[]) {
  return threads.filter((item) => item.status !== 'archived')
}

// 操作的确认阶段。已提交和已保存分开显示，设备确认前不显示最终结果。
export function operationLabel(operation: Operation, device: Device | undefined): string | null {
  const name = device?.name ?? 'the device'
  switch (operation.phase) {
    case 'submitted':
      return 'Sending…'
    case 'saved':
      return 'Saved'
    case 'waitingDevice':
      return operation.kind === 'stopThread' ? `Waiting for ${name} to confirm the stop` : `Saved · waiting for ${name}`
    case 'queued':
      return 'Sending next'
    case 'running':
      return null
    case 'stopping':
      return `Waiting for ${name} to confirm the assistant has stopped…`
    case 'stopped':
      return operation.kind === 'stopThread' ? 'Stopped by you' : 'Not sent'
    case 'done':
      return null
    case 'conflict':
      return operation.detail ?? 'Already handled'
    case 'failed':
      return operation.detail ?? 'Could not save'
  }
}
