// 由多个查询组合出的界面状态。设备、Thread、Project 各自只存原始状态，
// 页面显示时在这里合并，所以设备状态一变，所有用到它的页面一起更新。
import type { Tone } from '../ui/Status'
import type {
  ActivitySummary,
  AgentKind,
  Device,
  DeviceAgent,
  FilePreview,
  ID,
  InboxItem,
  Message,
  Operation,
  Project,
  Subscription,
  Thread,
} from './types'

export interface StatusView {
  tone: Tone
  label: string
}

// 列表分组，按需要处理的先后排列。
// stopping 是设备在线、正在等它确认停止；stopRequested 是设备不在线，停止请求还没发出。
export type ThreadGroup = 'attention' | 'running' | 'stopping' | 'stopRequested' | 'waiting' | 'idle' | 'archived'

export const threadGroups: { id: ThreadGroup; label: string }[] = [
  { id: 'attention', label: 'Needs attention' },
  { id: 'running', label: 'Running' },
  { id: 'stopping', label: 'Stopping' },
  { id: 'stopRequested', label: 'Stop requested' },
  { id: 'waiting', label: 'Waiting for device' },
  { id: 'idle', label: 'Idle' },
  { id: 'archived', label: 'Archived' },
]

// 卡片上的恢复办法。newChat 用同一设备和目录新建对话，chooseFolder 先选目录再新建。
export type ThreadAction = 'resume' | 'newChat' | 'chooseFolder' | 'viewDevices' | 'viewActivity'

export interface ThreadNotice {
  tone: 'neutral' | 'danger' | 'attention'
  title: string
  detail: string
  action: ThreadAction | null
}

export interface ThreadView {
  status: StatusView
  group: ThreadGroup
  // 时间线末尾说明当前状态和恢复办法；状态正常时为 null。
  notice: ThreadNotice | null
  // 已归档、不能恢复、启动失败或等待设备确认停止时不显示输入区。
  composer: boolean
  // 设备在线、正在执行时显示计时。设备离线时只保留最后报告的状态，不计时。
  live: boolean
}

function notice(
  title: string,
  detail: string,
  action: ThreadAction | null = null,
  tone: ThreadNotice['tone'] = 'neutral',
) {
  return { tone, title, detail, action }
}

export function threadMessageNotice(message: Message, agent: Thread['agent']): ThreadNotice | null {
  if (message.role !== 'failure') return null
  return notice(
    agent ? `${agentNames[agent]} could not finish this reply` : 'Command could not finish',
    message.body.trim() || 'No further details are available.',
  )
}

function canceledNote(count: number) {
  if (count === 0) return ''
  return count === 1 ? ' 1 waiting message was canceled.' : ` ${count} waiting messages were canceled.`
}

// unknownDelivery：Thread 里有一条不确定是否送达的消息。
export function threadView(
  thread: Thread,
  device: Device | undefined,
  options: { resume?: boolean; unknownDelivery?: boolean } = {},
): ThreadView {
  const name = device?.name ?? 'This device'
  const agent = thread.agent ? agentNames[thread.agent] : 'Command'
  const reachable = device?.connection === 'online'
  const away = device?.connection === 'syncing' ? 'syncing' : 'offline'
  const view = (
    status: StatusView,
    group: ThreadGroup,
    note: ThreadNotice | null = null,
    composer = true,
    live = false,
  ): ThreadView => ({
    status,
    group,
    notice:
      thread.agent === null && note?.action && ['resume', 'newChat', 'chooseFolder'].includes(note.action)
        ? { ...note, action: null }
        : note,
    composer: composer && thread.agent !== null,
    live,
  })

  if (thread.status === 'archived') {
    return view(
      { tone: 'hollow', label: 'Archived' },
      'archived',
      notice('Archived', 'This thread is closed to new messages. Past replies and attachment links are kept.'),
      false,
    )
  }
  if (thread.pending === 'archive') {
    if (reachable) {
      return view(
        { tone: 'info', label: 'Archiving…' },
        'stopping',
        notice('Stopping before archiving…', `Waiting for ${name} to confirm ${agent} has stopped.`),
        false,
        true,
      )
    }
    return view(
      { tone: 'neutral', label: 'Waiting to archive' },
      'stopRequested',
      notice(
        `Waiting for ${name}`,
        `${name} is ${away} and may still be running ${agent}. Reconnect it to confirm stopping and finish archiving.`,
        'viewDevices',
      ),
      false,
    )
  }
  if (thread.pending === 'stop') {
    if (reachable) return view({ tone: 'info', label: 'Stopping…' }, 'stopping', null, true, true)
    return view(
      { tone: 'neutral', label: 'Waiting to stop' },
      'stopRequested',
      notice(
        `Stop is waiting for ${name}`,
        `The stop request is saved.${canceledNote(thread.stopCanceled)} Reconnect ${name} to send it and confirm stopping. ${agent} may still be running.`,
        'viewDevices',
      ),
      false,
    )
  }
  if (thread.resumePending) {
    return view(
      { tone: 'info', label: 'Resuming…' },
      'waiting',
      notice(`Resuming ${agent}…`, `Waiting for ${name} to confirm this thread has resumed.`),
      false,
    )
  }
  if (thread.starting) {
    return reachable
      ? view(
          { tone: 'info', label: 'Starting…' },
          'waiting',
          notice(`Starting ${agent}…`, `Your message is saved. Waiting for ${agent} to open on ${name}.`),
        )
      : view(
          { tone: 'neutral', label: 'Waiting for device' },
          'waiting',
          notice(
            `Waiting for ${name}`,
            `Your message is saved. ${agent} has not opened this thread yet.`,
            'viewDevices',
          ),
        )
  }
  switch (thread.status) {
    case 'stopped':
      return view({ tone: 'danger', label: 'Stopped' }, 'attention', ...stoppedNotice(thread, name, agent, options))
    case 'unknown':
      return view(
        { tone: 'attention', label: 'Status unknown' },
        'attention',
        options.unknownDelivery
          ? notice(
              `Not sure if ${agent} received your message`,
              `${agent} restarted while sending. Check the activity before sending your message again. Baton will not resend it automatically.`,
              'viewActivity',
              'attention',
            )
          : notice(
              'Status unknown',
              `${name} has not reported this thread since it reconnected. Check the activity before sending more messages.`,
              'viewActivity',
              'attention',
            ),
      )
    case 'running':
      if (!reachable) {
        return view(
          { tone: 'hollow', label: 'Last seen running' },
          'running',
          notice(
            `${name} is ${away}`,
            'The reply may still be running on the device. Updates appear after it reconnects.',
            'viewDevices',
          ),
        )
      }
      return view({ tone: 'info', label: 'Running' }, 'running', null, true, true)
    case 'waiting':
      return view(
        { tone: 'neutral', label: 'Waiting for device' },
        'waiting',
        notice(
          `Waiting for ${name} to come online`,
          `Your message is saved and will send when ${name} is online. This thread stays on ${name}.`,
          'viewDevices',
        ),
      )
    case 'idle':
      return view(
        { tone: 'neutral', label: 'Idle' },
        'idle',
        reachable ? null : notice(`${name} is ${away}`, 'New messages wait until it connects.'),
      )
  }
}

function stoppedNotice(
  thread: Thread,
  name: string,
  agent: string,
  options: { resume?: boolean },
): [ThreadNotice, boolean] {
  const stop = thread.stop ?? { kind: 'byYou', detail: null }
  const keep = 'File changes are kept. Send a message below to continue.'
  switch (stop.kind) {
    case 'byYou':
      return [notice('Stopped by you', `${name} confirmed stopping.${canceledNote(thread.stopCanceled)} ${keep}`), true]
    case 'forced':
      return [
        notice(
          'Stopped by you',
          `${agent} did not stop within 1 minute, so ${name} ended it.${canceledNote(thread.stopCanceled)} ${keep}`,
        ),
        true,
      ]
    case 'interrupted':
      if (options.resume) {
        return [
          notice(
            `${agent} stopped before finishing`,
            `${agent} on ${name} was interrupted, for example by a restart. Resume the thread to continue where it left off.`,
            'resume',
            'danger',
          ),
          true,
        ]
      }
      return [
        notice(
          'This agent cannot resume past threads',
          `The agent on ${name} does not support resuming. Start a new thread in this folder to continue.`,
          'newChat',
          'danger',
        ),
        false,
      ]
    case 'historyLost':
      return [
        notice(
          'Thread history not found',
          `${name} no longer has the history of this thread, so ${agent} cannot resume it. Start a new thread in this folder to continue.`,
          'newChat',
          'danger',
        ),
        false,
      ]
    case 'folderMissing':
      return [
        notice(
          'Folder not found',
          `${stop.detail ?? thread.folder} no longer exists on ${name}. Choose a folder to start a new thread.`,
          'chooseFolder',
          'danger',
        ),
        false,
      ]
    case 'startFailed':
      if (thread.retryOpenAllowed)
        return [
          notice(
            `${agent} could not start`,
            `Fix the reported issue on ${name}, then retry opening this thread. Your saved message is kept for you to send again.`,
            'resume',
            'danger',
          ),
          false,
        ]
      return [
        notice(
          `${agent} could not start`,
          `${stop.detail ?? `${agent} exited during startup`}. Fix it on ${name}, then start a new thread in this folder.`,
          'newChat',
          'danger',
        ),
        false,
      ]
  }
}

export function projectAgentStatus(project: Project, devices: Device[]): StatusView {
  if (project.status === 'paused') return { tone: 'neutral', label: 'Paused' }
  if (project.status === 'archived') return { tone: 'hollow', label: 'Archived' }
  const device = devices.find((item) => item.id === project.agent.deviceId)
  switch (project.agent.state) {
    case 'blocked':
      return { tone: 'attention', label: 'Needs attention' }
    case 'notStarted':
      return { tone: 'neutral', label: 'Not started yet' }
    case 'running':
      return { tone: 'agent', label: device ? `Running on ${device.name}` : 'Running' }
    case 'stopping':
      return { tone: 'agent', label: device ? `Stopping on ${device.name}…` : 'Stopping…' }
    case 'waitingDevice':
      return { tone: 'neutral', label: 'Waiting for device' }
    case 'stopped':
      // 你停止的运行没有原因，之后发消息就会重新运行，和空闲一样显示。
      return project.agent.reason ? { tone: 'danger', label: 'Stopped' } : { tone: 'neutral', label: 'Idle' }
    case 'idle':
      return { tone: 'neutral', label: 'Idle' }
  }
}

// Project 助手可选的订阅和模型。
export const assistantModels: Record<string, string[]> = {
  ChatGPT: ['gpt-6.1-sol', 'gpt-6.1-mini'],
  Claude: ['claude-opus-5-5', 'claude-sonnet-5-5'],
}

// 设备不能运行 Project 助手的原因，按处理顺序：先装 Runtime，再连上设备，最后登录订阅。
export type AssistantBlock = 'noRuntime' | 'offline' | 'syncing' | 'signedOut'

export function assistantBlock(device: Device, subscription: string): AssistantBlock | null {
  if (!device.hasRuntime) return 'noRuntime'
  if (device.connection !== 'online') return device.connection
  if (!device.subscriptions.some((item) => item.provider === subscription && canTrySubscription(item)))
    return 'signedOut'
  return null
}

// 切换设备说明里的原因，例如 `MacBook Pro is offline`。
export function blockReason(device: Device, block: AssistantBlock, subscription: string) {
  switch (block) {
    case 'noRuntime':
      return `the project assistant is not installed on ${device.name}`
    case 'offline':
      return `${device.name} is offline`
    case 'syncing':
      return `${device.name} is syncing`
    case 'signedOut':
      return `${subscription} is not signed in on ${device.name}`
  }
}

function blockStep(device: Device, block: AssistantBlock, subscription: string) {
  switch (block) {
    case 'noRuntime':
      return `The project assistant is not installed on ${device.name}.`
    case 'offline':
      return `${device.name} is offline.`
    case 'syncing':
      return `${device.name} is syncing.`
    case 'signedOut':
      return `Sign in to ${subscription} on ${device.name}.`
  }
}

// 当前可尝试运行所选订阅的设备数，用于新建 Project 提示。
export function subscriptionReach(devices: Device[], subscription: string) {
  return devices.filter((item) => assistantBlock(item, subscription) === null).length
}

export interface AssistantWait {
  title: string
  detail: string
  // 概览里助手卡片的说明。
  overview: string
}

// 没有设备能运行 Project 助手时，主对话上方的说明。
export function assistantWait(project: Project, devices: Device[]): AssistantWait {
  const subscription = project.subscription
  const count = `${devices.length} ${devices.length === 1 ? 'device' : 'devices'}`
  if (devices.length > 0 && devices.every((item) => item.connection !== 'online')) {
    return {
      title: 'Waiting for a device to come online',
      detail: `${devices.length === 1 ? 'Your device is' : `All ${count} are`} offline. Your messages are saved and will send when a device with ${subscription} signed in is available.`,
      overview: `${devices.length === 1 ? 'Your device is' : `All ${count} are`} offline. Waiting for a computer with ${subscription} signed in.`,
    }
  }
  const steps = devices.flatMap((device) => {
    const block = assistantBlock(device, subscription)
    return block ? [blockStep(device, block, subscription)] : []
  })
  return {
    title: 'No device is ready for this model',
    detail: [...(devices.length === 0 ? ['Connect a device first.'] : steps), 'Your message stays saved.'].join(' '),
    overview: `${subscription} is unavailable on ${devices.length === 1 ? 'your device' : `all ${count}`}. Messages stay saved.`,
  }
}

// 主对话 Thread 卡片右侧的进度。
export function threadCardStatus(threads: Thread[]) {
  const running = threads.filter((item) => item.status === 'running' || item.pending === 'stop').length
  const waiting = threads.filter((item) => item.status === 'waiting').length
  if (running > 0) return { tone: 'info' as const, label: `${running} running` }
  if (waiting > 0) return { tone: 'neutral' as const, label: `${waiting} waiting for device` }
  if (threads.some((item) => item.status === 'stopped')) return { tone: 'neutral' as const, label: 'Finished' }
  return { tone: 'success' as const, label: 'All replied' }
}

export interface PreviewView {
  title: string
  detail: string
  // retry：设备或读取的问题，重读一次可能成功；back：这个文件读不了，回到目录选别的文件。
  action: 'retry' | 'back'
}

export function baseName(path: string) {
  return path.split(/[\\/]/).pop() || path
}

// 文件预览只显示从设备实时读到的内容，读不到时只给原因。
export function previewProblem(preview: FilePreview, device: Device | undefined): PreviewView | null {
  if (preview.state === 'ready') return null
  const name = device?.name ?? 'This device'
  const file = baseName(preview.path)
  switch (preview.reason) {
    case 'offline':
      return {
        title: `${name} is offline`,
        detail: `Reconnect ${name}, then retry to view this file.`,
        action: 'retry',
      }
    case 'syncing':
      return { title: `${name} is syncing`, detail: 'Retry when it finishes syncing.', action: 'retry' }
    case 'outsideFolders':
      return {
        title: 'Folder is outside allowed paths',
        detail: `This link points to ${preview.path}, which is not shared with Baton on ${name}.`,
        action: 'back',
      }
    case 'missing':
      return {
        title: `File not found on ${name}`,
        detail: `${file} was moved or deleted. Go back to the folder and choose another file.`,
        action: 'back',
      }
    case 'binary':
      return {
        title: 'Binary file cannot be previewed',
        detail: `Baton only reads limited text previews. Open ${file} on ${name}, or choose a text file.`,
        action: 'back',
      }
  }
}

// 读取失败（设备没有返回）时的说明。
export function readFailure(path: string, device: Device | undefined): PreviewView {
  const name = device?.name ?? 'This device'
  return {
    title: 'Could not read this file',
    detail: `${name} did not return ${baseName(path)}. Retry to read it again, or choose another file.`,
    action: 'retry',
  }
}

export function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024
    return `${kb < 10 ? kb.toFixed(1).replace(/\.0$/, '') : Math.round(kb)} KB`
  }
  return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`
}

function counted(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`
}

// 回复过程折叠时的一句话，例如「Ran 1 command, wrote 1 file」。
export function activityLine(activity: ActivitySummary) {
  const parts = [
    activity.commands > 0 && `ran ${counted(activity.commands, 'command', 'commands')}`,
    activity.tools > 0 && `used ${counted(activity.tools, 'tool', 'tools')}`,
    activity.files > 0 && `wrote ${counted(activity.files, 'file', 'files')}`,
  ].filter((item): item is string => Boolean(item))
  const line = parts.join(', ')
  return line.charAt(0).toUpperCase() + line.slice(1)
}

// 引用最多带 8 KiB。按 UTF-8 字节截断，不切开多字节字符。
export const referenceLimit = 8 * 1024

export function shortenExcerpt(selected: string) {
  const bytes = new TextEncoder().encode(selected)
  if (bytes.length <= referenceLimit) return { excerpt: selected, bytes: bytes.length }
  const excerpt = new TextDecoder().decode(bytes.slice(0, referenceLimit)).replace(/\uFFFD$/, '')
  return { excerpt, bytes: bytes.length }
}

export function pendingInbox(items: InboxItem[], projectId?: ID) {
  return items
    .filter((item) => item.status === 'pending' && (!projectId || item.projectId === projectId))
    .sort((a, b) => b.createdAt - a.createdAt)
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

export const agentNames: Record<AgentKind, string> = { codex: 'Codex', kiro: 'Kiro', pi: 'Pi', cursor: 'Cursor' }

const clock = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const day = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' })

// 24 小时制的时刻，例如 14:32。
export function clockTime(at: number) {
  return clock.format(at)
}

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
      return running
        ? { tone: 'agent', label: `Online · running ${running.name}` }
        : { tone: 'success', label: 'Online' }
    }
  }
}

// 已声明但认证检查未知的订阅可尝试运行，明确缺少登录时等待登录。
export function canTrySubscription(subscription: Subscription) {
  if (subscription.status) return subscription.status !== 'login_required'
  return subscription.signedIn
}

export function subscriptionCredentialIssue(subscription: Subscription): string | null {
  switch (subscription.reason) {
    case 'credential_permissions_invalid':
      return 'Credential file permissions are unsafe. Allow access only for the device user.'
    case 'credential_owner_invalid':
      return 'The credential file belongs to another user. Restore ownership to the device user.'
    case 'credential_path_invalid':
      return 'The credential path is invalid. Use a regular file without symbolic links.'
    case 'credential_private_file_failed':
      return 'The credential file could not be opened securely. Check its path, ownership and permissions.'
    default:
      return null
  }
}

function subscriptionCanRun(device: Device) {
  return device.subscriptions.some(canTrySubscription)
}

// 设备上需要处理才能用的 Agent 和 Project 助手。
export function setupNeeded(device: Device) {
  return (
    device.agents.some((agent) => !canCreateAgent(agent)) ||
    !device.hasRuntime ||
    !subscriptionCanRun(device) ||
    device.subscriptions.some((item) => subscriptionCredentialIssue(item) !== null)
  )
}

export interface CapabilityLine {
  name: string
  ok: boolean
  detail: string
}

function abilityNotes(agent: DeviceAgent) {
  const notes: string[] = []
  if (agent.abilities.steer) notes.push('send now')
  if (agent.abilities.resume) notes.push('resume thread')
  return notes
}

// 「Agents & subscriptions」里每行的状态：可用时写登录状态和支持的操作，不可用时写缺什么。
export function capabilityLines(device: Device): CapabilityLine[] {
  const lines = device.agents.map((agent): CapabilityLine => {
    const name = agentNames[agent.kind]
    if (!canCreateAgent(agent)) return { name, ok: false, detail: agentUnavailableReason(agent) }
    return { name, ok: true, detail: [agent.account ? 'Signed in' : 'Installed', ...abilityNotes(agent)].join(' · ') }
  })
  const subscriptions = device.subscriptions.filter((item) => item.signedIn).map((item) => item.provider)
  const diagnostics = device.subscriptions.flatMap((item) => {
    const issue = subscriptionCredentialIssue(item)
    if (issue) return [`${item.provider}: ${issue}`]
    return item.status === 'unknown' ? [`${item.provider} sign-in check unavailable · can try`] : []
  })
  let runtime: CapabilityLine = {
    name: 'Project assistant',
    ok: !device.subscriptions.some((item) => subscriptionCredentialIssue(item) !== null),
    detail: [...(subscriptions.length ? [`${sentenceList(subscriptions)} signed in`] : []), ...diagnostics].join(' · '),
  }
  if (!device.hasRuntime) runtime = { name: 'Project assistant', ok: false, detail: 'Not installed' }
  else if (!subscriptionCanRun(device))
    runtime = {
      name: 'Project assistant',
      ok: false,
      detail: device.subscriptions.some((item) => item.status)
        ? 'Subscription sign-in needed'
        : 'ChatGPT sign-in expired',
    }
  return [...lines, runtime]
}

// Agent 版本和模型；不可用的 Agent 说明什么时候能用。
export function modelLines(device: Device) {
  return device.agents.flatMap((agent) => {
    const name = agentNames[agent.kind]
    if (!canCreateAgent(agent)) return [`${name} · ${agentUnavailableReason(agent)}`]
    const models = agent.models.map((model) => (model === agent.defaultModel ? `${model} (default)` : model))
    const line = [`${name} ${agent.version ?? ''}`.trim(), models.join(', ')].filter(Boolean).join(' · ')
    return [line]
  })
}

// 英文并列：a and b；a, b, and c。
export function sentenceList(items: string[]) {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')}${items.length > 2 ? ',' : ''} and ${items[items.length - 1]}`
}

// 设备需要补齐时的提示，逐项列出安装和登录要求。
export function setupSteps(device: Device) {
  const steps = device.agents.flatMap((agent) => {
    const name = agentNames[agent.kind]
    if (agent.problem === 'signedOut') return [`sign in to ${agent.account} for ${name}`]
    if (agent.problem === 'notInstalled') return [`install ${name}`]
    return []
  })
  if (!device.hasRuntime) steps.push('update Baton for the project assistant')
  else if (
    !subscriptionCanRun(device) &&
    !device.agents.some((agent) => agent.account === 'ChatGPT' && agent.problem)
  ) {
    const providers = device.subscriptions.map((item) => item.provider).join(' or ') || 'a supported subscription'
    steps.push(`sign in to ${providers} for the project assistant`)
  }
  for (const subscription of device.subscriptions) {
    const issue = subscriptionCredentialIssue(subscription)
    if (issue) steps.push(`${subscription.provider}: ${issue}`)
  }
  const list = sentenceList(steps)
  return `${list.charAt(0).toUpperCase()}${list.slice(1)}${list.endsWith('.') ? '' : '.'}`
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

// 列表右侧的更新时间。
export function relativeTime(at: number, now: number) {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000)
  return days <= 1 ? 'Yesterday' : `${days}d ago`
}

function startOfDay(at: number) {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

// 执行计时，例如 03:12；超过一小时为 1:03:12。
export function runTimer(startedAt: number, now: number) {
  const total = Math.max(0, Math.floor((now - startedAt) / 1000))
  const pad = (value: number) => String(value).padStart(2, '0')
  const hours = Math.floor(total / 3600)
  const rest = `${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
  return hours > 0 ? `${hours}:${rest}` : rest
}

// 路径的最后一段，用作目录的短名。
export function folderName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

// 上一级目录；已经是第一级时为 null。
export function parentFolder(path: string) {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index > 0 ? path.slice(0, index) : null
}

export interface Location {
  deviceId: ID
  folder: string
}

// 最近用过的设备和目录，按 Thread 更新时间从新到旧，不重复。
export function recentLocations(threads: Thread[], devices: Device[], limit = 3): Location[] {
  const seen = new Set<string>()
  const result: Location[] = []
  for (const thread of [...threads].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const key = `${thread.deviceId}:${thread.folder}`
    if (seen.has(key) || !devices.some((item) => item.id === thread.deviceId)) continue
    seen.add(key)
    result.push({ deviceId: thread.deviceId, folder: thread.folder })
    if (result.length === limit) break
  }
  return result
}

// 新对话默认用默认设备上最近用过的目录，没有时用它的第一个仓库或允许的目录。
export function defaultLocation(threads: Thread[], devices: Device[], defaultDeviceId: ID | null): Location | null {
  const device = devices.find((item) => item.id === defaultDeviceId) ?? devices[0]
  if (!device) return null
  const recent = recentLocations(
    threads.filter((item) => item.deviceId === device.id),
    devices,
    1,
  )[0]
  return recent ?? { deviceId: device.id, folder: device.repos[0] ?? device.folders[0] ?? '' }
}

export function canCreateAgent(agent: DeviceAgent) {
  return agent.status === 'available' && agent.abilities.create === true && !agent.problem
}

export function agentUnavailableReason(agent: DeviceAgent) {
  if (agent.reason) return agent.reason
  if (agent.problem === 'notInstalled') return 'Program not installed'
  if (agent.problem === 'signedOut') return `${agent.account ?? agentNames[agent.kind]} sign-in expired`
  if (agent.status === 'unverified') return 'This agent has not been verified on this device.'
  if (agent.status === 'available' && !agent.problem) return 'This agent does not support starting new threads.'
  return 'Agent unavailable on this device'
}

// 新对话同时要求可用状态和明确的创建能力。
export function usableAgents(device: Device | undefined) {
  return (device?.agents ?? []).filter(canCreateAgent)
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
