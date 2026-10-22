// 由多个查询组合出的界面状态。设备、Thread、Project 各自只存原始状态，
// 页面显示时在这里合并，所以设备状态一变，所有用到它的页面一起更新。
import type { Tone } from '../ui/Status'
import type { AgentKind, Device, DeviceAgent, FilePreview, ID, InboxItem, Operation, Project, Thread } from './types'

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

function connectionCounts(devices: Device[]) {
  return {
    online: devices.filter((item) => item.connection === 'online').length,
    syncing: devices.filter((item) => item.connection === 'syncing').length,
  }
}

// 侧栏 Devices 右侧的数量。
export function onlineSummary(devices: Device[]) {
  if (devices.length === 0) return '0 devices'
  const { online, syncing } = connectionCounts(devices)
  if (syncing > 0) return `${online} online · ${syncing} syncing`
  return `${online}/${devices.length} online`
}

// 设备页标题。
export function devicesHeading(devices: Device[]) {
  if (devices.length === 0) return 'Your devices'
  const { online, syncing } = connectionCounts(devices)
  const count = `${devices.length} ${devices.length === 1 ? 'device' : 'devices'}`
  if (syncing > 0) return `${count} · ${online} online · ${syncing} syncing`
  return `${count}, ${online} online`
}

export const agentNames: Record<AgentKind, string> = { codex: 'Codex', kiro: 'Kiro', pi: 'Pi' }

const clock = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const day = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' })

// 当天只显示时刻，更早的加上日期；一分钟内显示 now。
export function lastSeen(at: number, now: number) {
  if (now - at < 60_000) return 'now'
  const time = clock.format(at)
  return new Date(at).toDateString() === new Date(now).toDateString() ? time : `${day.format(at)}, ${time}`
}

// 设备行的状态列：离线和同步中带最后联系时间，在线且有 Project 助手运行时写出 Project 名。
export function deviceConnectionView(device: Device, projects: Project[], now: number): StatusView {
  switch (device.connection) {
    case 'offline':
      return { tone: 'neutral', label: `Offline · last seen ${lastSeen(device.lastSeenAt, now)}` }
    case 'syncing':
      return { tone: 'hollow', label: `Syncing · last seen ${lastSeen(device.lastSeenAt, now)}` }
    case 'online': {
      const running = projects.find(
        (item) => item.status === 'active' && item.agent.state === 'running' && item.agent.deviceId === device.id,
      )
      return running ? { tone: 'agent', label: `Online · running ${running.name}` } : { tone: 'success', label: 'Online' }
    }
  }
}

function chatGPTSignedIn(device: Device) {
  return device.subscriptions.some((item) => item.provider === 'ChatGPT' && item.signedIn)
}

// 设备上需要处理才能用的 Agent 和 Project 助手。
export function setupNeeded(device: Device) {
  return device.agents.some((agent) => agent.problem) || !device.hasRuntime || !chatGPTSignedIn(device)
}

export interface CapabilityLine {
  name: string
  ok: boolean
  detail: string
}

function abilityNotes(agent: DeviceAgent) {
  const notes: string[] = []
  if (agent.abilities.steer) notes.push('send now')
  if (agent.abilities.resume) notes.push('resume chat')
  return notes
}

// 「Agents & subscriptions」里每行的状态：可用时写登录状态和支持的操作，不可用时写缺什么。
export function capabilityLines(device: Device): CapabilityLine[] {
  const lines = device.agents.map((agent): CapabilityLine => {
    const name = agentNames[agent.kind]
    if (agent.problem === 'notInstalled') return { name, ok: false, detail: 'Program not installed' }
    if (agent.problem === 'signedOut') return { name, ok: false, detail: `${agent.account} sign-in expired` }
    return { name, ok: true, detail: [agent.account ? 'Signed in' : 'Installed', ...abilityNotes(agent)].join(' · ') }
  })
  let runtime: CapabilityLine = { name: 'Project assistant', ok: true, detail: 'ChatGPT signed in' }
  if (!device.hasRuntime) runtime = { name: 'Project assistant', ok: false, detail: 'Not installed' }
  else if (!chatGPTSignedIn(device)) runtime = { name: 'Project assistant', ok: false, detail: 'ChatGPT sign-in expired' }
  return [...lines, runtime]
}

// Agent 版本和模型；不可用的 Agent 说明什么时候能用。
export function modelLines(device: Device) {
  return device.agents.flatMap((agent) => {
    const name = agentNames[agent.kind]
    if (agent.problem === 'notInstalled') return [`${name} models unavailable until installed.`]
    const models = agent.models.map((model) => (model === agent.defaultModel ? `${model} (default)` : model))
    const line = [`${name} ${agent.version ?? ''}`.trim(), models.join(', ')].filter(Boolean).join(' · ')
    return agent.problem === 'signedOut' ? [line, `New ${name} chats unavailable until signed in.`] : [line]
  })
}

// 英文并列：a and b；a, b, and c。
export function sentenceList(items: string[]) {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')}${items.length > 2 ? ',' : ''} and ${items[items.length - 1]}`
}

// 设备需要补齐时的提示，逐项写出要在设备上做什么。
export function setupSteps(device: Device) {
  const steps = device.agents.flatMap((agent) => {
    const name = agentNames[agent.kind]
    if (agent.problem === 'signedOut') return [`sign in to ${agent.account} for ${name}`]
    if (agent.problem === 'notInstalled') return [`install ${name}`]
    return []
  })
  if (!device.hasRuntime) steps.push('update Baton for the project assistant')
  else if (!chatGPTSignedIn(device) && !device.agents.some((agent) => agent.account === 'ChatGPT' && agent.problem)) {
    steps.push('sign in to ChatGPT for the project assistant')
  }
  const list = sentenceList(steps)
  return `${list.charAt(0).toUpperCase()}${list.slice(1)}. Make these changes on ${device.name}.`
}

// 设备行的 Agent 列。
export function agentSummary(device: Device) {
  if (device.connection === 'syncing') return { label: 'Checking availability…', attention: false }
  if (setupNeeded(device)) return { label: 'Setup needed', attention: true }
  return { label: device.agents.map((agent) => agentNames[agent.kind]).join(' · '), attention: false }
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
