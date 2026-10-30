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
  { id: 'attention', label: '待处理' },
  { id: 'running', label: '运行中' },
  { id: 'stopping', label: '正在停止' },
  { id: 'stopRequested', label: '已请求停止' },
  { id: 'waiting', label: '等待设备' },
  { id: 'idle', label: '空闲' },
  { id: 'archived', label: '已归档' },
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
  return notice(agent ? `${agentNames[agent]} 未能完成此回复` : '命令未能完成', message.body.trim() || '暂无更多详情。')
}

// 带尾随空格，直接拼在下一句前面。
function canceledNote(count: number) {
  if (count === 0) return ''
  return count === 1 ? '已取消 1 条等待中的消息。' : `已取消 ${count} 条等待中的消息。`
}

// unknownDelivery：Thread 里有一条不确定是否送达的消息。
export function threadView(
  thread: Thread,
  device: Device | undefined,
  options: { resume?: boolean; unknownDelivery?: boolean } = {},
): ThreadView {
  const name = device?.name ?? '此设备'
  const agent = thread.agent ? agentNames[thread.agent] : '命令'
  const reachable = device?.connection === 'online'
  const away = device?.connection === 'syncing' ? '正在同步' : '已离线'
  const view = (
    status: StatusView,
    group: ThreadGroup,
    note: ThreadNotice | null = null,
    composer = true,
    live = false,
  ): ThreadView => ({
    status,
    group,
    notice: note,
    composer,
    live,
  })

  if (thread.status === 'archived') {
    return view({ tone: 'hollow', label: '已归档' }, 'archived', notice('已归档', ''), false)
  }
  if (thread.stopFailed && thread.status === 'running') {
    return view(
      { tone: 'attention', label: '停止失败' },
      'attention',
      notice(`无法停止 ${agent}`, `${agent} 可能仍在运行。`, null, 'attention'),
      true,
      reachable,
    )
  }
  if (thread.pending === 'archive') {
    if (reachable) {
      return view(
        { tone: 'info', label: '正在归档…' },
        'stopping',
        notice('正在停止后归档…', canceledNote(thread.stopCanceled).trim()),
        false,
        true,
      )
    }
    return view(
      { tone: 'neutral', label: '等待归档' },
      'stopRequested',
      notice(`等待 ${name}`, `${canceledNote(thread.stopCanceled)}${agent} may still be running.`, 'viewDevices'),
      false,
    )
  }
  if (thread.pending === 'stop') {
    if (reachable) return view({ tone: 'info', label: '正在停止…' }, 'stopping', null, true, true)
    return view(
      { tone: 'neutral', label: '等待停止' },
      'stopRequested',
      notice(`等待 ${name} 停止`, `${canceledNote(thread.stopCanceled)}${agent} may still be running.`, 'viewDevices'),
      false,
    )
  }
  if (thread.resumePending) {
    return view(
      { tone: 'info', label: '正在恢复…' },
      'waiting',
      notice(`正在恢复 ${agent}…`, `等待 ${name} 确认对话已恢复。`),
      false,
    )
  }
  if (thread.starting) {
    return reachable
      ? view(
          { tone: 'info', label: '正在启动…' },
          'waiting',
          notice(`正在启动 ${agent}…`, `消息已保存，正在等待 ${agent} 在 ${name} 上启动。`),
        )
      : view(
          { tone: 'neutral', label: '等待设备' },
          'waiting',
          notice(`等待 ${name}`, `消息已保存，${agent} 尚未打开此对话。`, 'viewDevices'),
        )
  }
  switch (thread.status) {
    case 'stopped':
      return view({ tone: 'danger', label: '已停止' }, 'attention', ...stoppedNotice(thread, name, agent, options))
    case 'unknown':
      return view(
        { tone: 'attention', label: '状态未知' },
        'attention',
        options.unknownDelivery
          ? notice(`${agent} 可能未收到上一条消息`, '', 'viewActivity', 'attention')
          : notice(
              '状态未知',
              `${name} 重新连接后尚未报告此对话的状态。请先查看活动记录，再发送消息。`,
              'viewActivity',
              'attention',
            ),
      )
    case 'running':
      if (!reachable) {
        return view(
          { tone: 'hollow', label: '上次运行中' },
          'running',
          notice(`${name} ${away}`, `${agent} 可能仍在运行。`, 'viewDevices'),
        )
      }
      return view({ tone: 'info', label: '运行中' }, 'running', null, true, true)
    case 'waiting':
      return view({ tone: 'neutral', label: '等待设备' }, 'waiting', notice(`${name} ${away}`, '', 'viewDevices'))
    case 'idle':
      return view(
        { tone: 'neutral', label: '空闲' },
        'idle',
        reachable ? null : notice(`${name} ${away}`, '新消息将在设备连接后发送。'),
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
  const keep = `${canceledNote(thread.stopCanceled)}已更改的文件已保留。`
  switch (stop.kind) {
    case 'byYou':
      return [notice('已由你停止', keep), true]
    case 'forced':
      return [notice('已由你停止', `${agent} 在 1 分钟内未停止，${name} 已将其结束。${keep}`), true]
    case 'interrupted':
      if (options.resume) {
        return [
          notice(
            `${agent} 未完成即停止`,
            `${name} 上的 ${agent} 已中断，可能是由于重启。恢复对话后可继续执行。`,
            'resume',
            'danger',
          ),
          true,
        ]
      }
      return [notice(`${agent} 无法恢复此对话`, '', 'newChat', 'danger'), false]
    case 'historyLost':
      return [notice(`${name} 上的对话记录已删除`, '', 'newChat', 'danger'), false]
    case 'folderMissing':
      return [notice(`${stop.detail ?? thread.folder} 不存在`, '', 'chooseFolder', 'danger'), false]
    case 'startFailed':
      if (thread.retryOpenAllowed)
        return [
          notice(
            `${agent} 无法启动`,
            `请先解决 ${name} 上报告的问题，再重试打开对话。已保存的消息可重新发送。`,
            'resume',
            'danger',
          ),
          false,
        ]
      return [
        notice(
          `${agent} 无法启动`,
          `${stop.detail ?? `${agent} 在启动时退出`}。请在 ${name} 上解决问题，再在此文件夹中开始新对话。`,
          'newChat',
          'danger',
        ),
        false,
      ]
  }
}

export function projectAgentStatus(project: Project, devices: Device[]): StatusView {
  if (project.status === 'paused') return { tone: 'neutral', label: '已暂停' }
  if (project.status === 'archived') return { tone: 'hollow', label: '已归档' }
  const device = devices.find((item) => item.id === project.agent.deviceId)
  switch (project.agent.state) {
    case 'blocked':
      return { tone: 'attention', label: '待处理' }
    case 'notStarted':
      return { tone: 'neutral', label: '尚未开始' }
    case 'running':
      return { tone: 'agent', label: device ? `在 ${device.name} 上运行` : '运行中' }
    case 'stopping':
      return { tone: 'agent', label: device ? `正在 ${device.name} 上停止…` : '正在停止…' }
    case 'waitingDevice':
      return { tone: 'neutral', label: '等待设备' }
    case 'stopped':
      // 你停止的运行没有原因，之后发消息就会重新运行，和空闲一样显示。
      return project.agent.reason ? { tone: 'danger', label: '已停止' } : { tone: 'neutral', label: '空闲' }
    case 'idle':
      return { tone: 'neutral', label: '空闲' }
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

// 切换设备说明里的原因，例如 `MacBook Pro offline`。
export function blockReason(device: Device, block: AssistantBlock, subscription: string) {
  switch (block) {
    case 'noRuntime':
      return `${device.name} 未安装项目助手`
    case 'offline':
      return `${device.name} 已离线`
    case 'syncing':
      return `${device.name} 正在同步`
    case 'signedOut':
      return `${device.name} 未登录 ${subscription}`
  }
}

function blockStep(device: Device, block: AssistantBlock, subscription: string) {
  switch (block) {
    case 'noRuntime':
      return `${device.name} 未安装项目助手。`
    case 'offline':
      return `${device.name} 已离线。`
    case 'syncing':
      return `${device.name} 正在同步。`
    case 'signedOut':
      return `请在 ${device.name} 上登录 ${subscription}。`
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
  if (project.sourceNodeId) {
    const device = devices.find((item) => item.id === project.sourceNodeId)
    const connection = device?.modelConnections?.find((item) => `api-${item.id}` === project.subscription)
    const name = connection?.name ?? '所选 API 连接'
    const detail = !device
      ? '请在项目设置中选择其他模型来源。'
      : device.connection !== 'online'
        ? `请重新连接 ${device.name} 后继续。`
        : !connection
          ? `请在项目设置中选择其他模型来源。`
          : connection.keyNeeded
            ? `请在 ${device.name} 上添加 API 密钥。`
            : `等待 ${device.name} 运行项目助手。`
    return { title: `${name} 不可用`, detail, overview: `等待 ${name}` }
  }
  const subscription = project.subscription
  if (devices.length > 0 && devices.every((item) => item.connection !== 'online')) {
    return {
      title: devices.length === 1 ? '设备已离线' : '所有设备已离线',
      detail: '设备上线后会发送消息。',
      overview: '等待设备',
    }
  }
  const steps = devices.flatMap((device) => {
    const block = assistantBlock(device, subscription)
    return block ? [blockStep(device, block, subscription)] : []
  })
  return {
    title: devices.length === 0 ? '暂无设备' : `没有设备登录 ${subscription}`,
    detail: (devices.length === 0 ? ['请先连接设备。'] : steps).join(' '),
    overview: `${subscription} 在${devices.length === 1 ? '此设备' : `全部 ${devices.length} 台设备`}上不可用。`,
  }
}

// 主对话 Thread 卡片右侧的进度。
export function threadCardStatus(threads: Thread[]) {
  const running = threads.filter((item) => item.status === 'running' || item.pending === 'stop').length
  const waiting = threads.filter((item) => item.status === 'waiting').length
  if (running > 0) return { tone: 'info' as const, label: `${running} 个运行中` }
  if (waiting > 0) return { tone: 'neutral' as const, label: `${waiting} 个等待设备` }
  if (threads.some((item) => item.status === 'stopped')) return { tone: 'neutral' as const, label: '已完成' }
  return { tone: 'success' as const, label: '已全部回复' }
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
  const name = device?.name ?? '此设备'
  const file = baseName(preview.path)
  switch (preview.reason) {
    case 'offline':
      return { title: `${name} 已离线`, detail: '', action: 'retry' }
    case 'syncing':
      return { title: `${name} 正在同步`, detail: '', action: 'retry' }
    case 'outsideFolders':
      return { title: '链接指向设备允许的文件夹之外', detail: preview.path, action: 'back' }
    case 'missing':
      return { title: `${file} 已移动或删除`, detail: '', action: 'back' }
    case 'binary':
      return { title: '无法预览二进制文件', detail: '', action: 'back' }
  }
}

// 读取失败（设备没有返回）时的说明。
export function readFailure(): PreviewView {
  return { title: '无法读取文件', detail: '', action: 'retry' }
}

export function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024
    return `${kb < 10 ? kb.toFixed(1).replace(/\.0$/, '') : Math.round(kb)} KB`
  }
  return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`
}

// 回复过程折叠时的一句话。
export function activityLine(activity: ActivitySummary) {
  return [
    activity.commands > 0 && `运行 ${activity.commands} 条命令`,
    activity.tools > 0 && `使用 ${activity.tools} 个工具`,
    activity.files > 0 && `写入 ${activity.files} 个文件`,
  ]
    .filter(Boolean)
    .join('，')
}

// 引用最多带 8 KiB。按 UTF-8 字节截断，不切开多字节字符。
export const referenceLimit = 8 * 1024

export function shortenExcerpt(selected: string) {
  const bytes = new TextEncoder().encode(selected)
  if (bytes.length <= referenceLimit) return { excerpt: selected, bytes: bytes.length }
  const excerpt = new TextDecoder().decode(bytes.slice(0, referenceLimit)).replace(/\uFFFD$/, '')
  return { excerpt, bytes: bytes.length }
}

function connectionCounts(devices: Device[]) {
  return {
    online: devices.filter((item) => item.connection === 'online').length,
    syncing: devices.filter((item) => item.connection === 'syncing').length,
  }
}

// 侧栏 Devices 右侧的数量。
export function onlineSummary(devices: Device[]) {
  if (devices.length === 0) return '0 台设备'
  const { online, syncing } = connectionCounts(devices)
  if (syncing > 0) return `${online} 台在线 · ${syncing} 台同步中`
  return `${online}/${devices.length} 台在线`
}

// 设备页标题。
export function devicesHeading(devices: Device[]) {
  if (devices.length === 0) return '你的设备'
  const { online, syncing } = connectionCounts(devices)
  const count = `${devices.length} 台设备`
  if (syncing > 0) return `${count}，${online} 台在线，${syncing} 台同步中`
  return `${count}，${online} 台在线`
}

export const agentNames: Record<AgentKind, string> = { codex: 'Codex', kiro: 'Kiro', pi: 'Pi', cursor: 'Cursor' }

const clock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const day = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' })

// 24 小时制的时刻，例如 14:32。
export function clockTime(at: number) {
  return clock.format(at)
}

// 当天只显示时刻，更早的加上日期；一分钟内显示 now。
export function lastSeen(at: number, now: number) {
  if (now - at < 60_000) return '刚刚'
  const time = clock.format(at)
  return new Date(at).toDateString() === new Date(now).toDateString() ? time : `${day.format(at)}, ${time}`
}

// 设备行优先显示升级暂停；普通连接状态与 Project 助手运行信息随后显示。
export function deviceConnectionView(device: Device, projects: Project[], now: number): StatusView {
  switch (device.upgradeState?.phase) {
    case 'draining':
    case 'ready':
      return { tone: 'neutral', label: '等待升级' }
    case 'migrating':
    case 'syncing':
      return { tone: 'neutral', label: '正在升级' }
    case 'failed':
      return { tone: 'attention', label: '升级已暂停' }
  }
  if (device.credentialState === 'idle_expired') return { tone: 'attention', label: '需要登录' }
  switch (device.connection) {
    case 'offline':
      return { tone: 'neutral', label: `离线 · 最后在线 ${lastSeen(device.lastSeenAt, now)}` }
    case 'syncing':
      return { tone: 'hollow', label: '正在同步…' }
    case 'online': {
      const running = projects.find(
        (item) => item.status === 'active' && item.agent.state === 'running' && item.agent.deviceId === device.id,
      )
      return running ? { tone: 'agent', label: `正在运行 ${running.name}` } : { tone: 'success', label: '在线' }
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
      return '凭据文件权限不安全，请仅允许设备用户访问。'
    case 'credential_owner_invalid':
      return '凭据文件属于其他用户，请将所有者改回设备用户。'
    case 'credential_path_invalid':
      return '凭据路径无效，请使用不含符号链接的普通文件。'
    case 'credential_private_file_failed':
      return '无法安全地打开凭据文件，请检查路径、所有者和权限。'
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
  if (agent.abilities.steer) notes.push('立即插话')
  if (agent.abilities.resume) notes.push('恢复对话')
  return notes
}

// 「Agents & subscriptions」里每行的状态：可用时写登录状态和支持的操作，不可用时写缺什么。
export function capabilityLines(device: Device): CapabilityLine[] {
  const lines = device.agents.map((agent): CapabilityLine => {
    const name = agentNames[agent.kind]
    if (!canCreateAgent(agent)) return { name, ok: false, detail: agentUnavailableReason(agent) }
    return { name, ok: true, detail: [agent.account ? '已登录' : '已安装', ...abilityNotes(agent)].join(' · ') }
  })
  const subscriptions = device.subscriptions.filter((item) => item.signedIn).map((item) => item.provider)
  const diagnostics = device.subscriptions.flatMap((item) => {
    const issue = subscriptionCredentialIssue(item)
    if (issue) return [`${item.provider}: ${issue}`]
    return item.status === 'unknown' ? [`${item.provider} 无法检查登录状态 · 可以尝试`] : []
  })
  let runtime: CapabilityLine = {
    name: '项目助手',
    ok: !device.subscriptions.some((item) => subscriptionCredentialIssue(item) !== null),
    detail: [...(subscriptions.length ? [`${subscriptions.join('、')} 已登录`] : []), ...diagnostics].join(' · '),
  }
  if (!device.hasRuntime) runtime = { name: '项目助手', ok: false, detail: '未安装' }
  else if (!subscriptionCanRun(device))
    runtime = {
      name: '项目助手',
      ok: false,
      detail: device.subscriptions.some((item) => item.status) ? '需要登录订阅账号' : 'ChatGPT 登录已过期',
    }
  return [...lines, runtime]
}

// 设备行只写系统名，去掉版本号，例如 `macOS 15.0.1` 显示为 `macOS`，`Windows 11 24H2` 显示为 `Windows 11`。
export function systemName(system: string) {
  const windows = /^Windows \d+/.exec(system)
  if (windows) return windows[0]
  const parts = system.split(' ')
  const version = parts.findIndex((part) => /^\d/.test(part))
  return version > 0 ? parts.slice(0, version).join(' ') : system
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
    if (agent.problem === 'signedOut') return [`为 ${name} 登录 ${agent.account}`]
    if (agent.problem === 'notInstalled') return [`安装 ${name}`]
    return []
  })
  if (!device.hasRuntime) steps.push('更新 Baton 以使用项目助手')
  else if (
    !subscriptionCanRun(device) &&
    !device.agents.some((agent) => agent.account === 'ChatGPT' && agent.problem)
  ) {
    const providers = device.subscriptions.map((item) => item.provider).join(' 或 ') || '受支持的订阅账号'
    steps.push(`为项目助手登录 ${providers}`)
  }
  for (const subscription of device.subscriptions) {
    const issue = subscriptionCredentialIssue(subscription)
    if (issue) steps.push(`${subscription.provider}: ${issue}`)
  }
  return steps.join('；')
}

// 设备行的 Agent 列。
export function agentSummary(device: Device) {
  if (device.connection === 'syncing') return { label: '正在检查可用性…', attention: false }
  if (setupNeeded(device)) return { label: '需要设置', attention: true }
  return { label: device.agents.map((agent) => agentNames[agent.kind]).join(' · '), attention: false }
}

export function liveThreads(threads: Thread[]) {
  return threads.filter((item) => item.status !== 'archived')
}

// 列表右侧的更新时间。
export function relativeTime(at: number, now: number) {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000)
  return days <= 1 ? '昨天' : `${days} 天前`
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
  if (agent.problem === 'notInstalled') return '程序未安装'
  if (agent.problem === 'signedOut') return `${agent.account ?? agentNames[agent.kind]} 登录已过期`
  if (agent.status === 'unverified') return '此设备上的助手尚未验证。'
  if (agent.status === 'available' && !agent.problem) return '此助手不支持新建对话。'
  return '此设备上的助手不可用'
}

// 新对话同时要求可用状态和明确的创建能力。
export function usableAgents(device: Device | undefined) {
  return (device?.agents ?? []).filter(canCreateAgent)
}

// 操作的确认阶段。已提交和已保存分开显示，设备确认前不显示最终结果。
export function operationLabel(operation: Operation, device: Device | undefined): string | null {
  const name = device?.name ?? '设备'
  switch (operation.phase) {
    case 'submitted':
      return '正在发送…'
    case 'saved':
      return '已保存'
    case 'waitingDevice':
      return operation.kind === 'stopThread' ? `等待 ${name} 确认停止` : `已保存 · 等待 ${name}`
    case 'queued':
      return '下一条发送'
    case 'running':
      return null
    case 'stopping':
      return `等待 ${name} 确认助手已停止…`
    case 'stopped':
      return operation.kind === 'stopThread' ? '已由你停止' : '未发送'
    case 'done':
      return null
    case 'conflict':
      return operation.detail ?? '已处理'
    case 'failed':
      return operation.detail ?? '无法保存'
  }
}
