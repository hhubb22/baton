// 界面使用的业务对象。字段按 specs/baton、specs/project-agent、specs/agent-inbox 的行为规格取名，
// 对象之间只用稳定 ID 关联，派生状态见 derive.ts。

export type ID = string

export type AgentKind = 'codex' | 'kiro' | 'pi'

export interface Account {
  id: ID
  name: string
  username: string
}

// 会话结束的原因。登录过期和管理员重置口令时登录页给出不同提示，主动退出或从未登录时为 null。
export type SessionEnd = 'expired' | 'passwordReset'

export interface Session {
  account: Account | null
  defaultDeviceId: ID | null
  ended: SessionEnd | null
}

// 连接成功、状态同步完成和 Thread 执行状态分开表示。
export type DeviceConnection = 'online' | 'syncing' | 'offline'

export interface AgentAbilities {
  queue: boolean
  steer: boolean
  stop: boolean
  resume: boolean
  switchModel: boolean
}

export interface DeviceAgent {
  kind: AgentKind
  version: string | null
  models: string[]
  defaultModel: string | null
  abilities: AgentAbilities
  // 登录 Agent 使用的订阅，例如 Codex 用 ChatGPT；不需要登录的 Agent 为 null。
  account: string | null
  // 程序没装或订阅登录过期时新对话不可用，要在设备上处理。
  problem: 'notInstalled' | 'signedOut' | null
}

export interface Subscription {
  provider: string
  signedIn: boolean
}

export interface Device {
  id: ID
  name: string
  os: DeviceOS
  // 系统版本，例如 `macOS 15.0.1`、`Ubuntu 24.04`。
  system: string
  batondVersion: string
  connection: DeviceConnection
  lastSeenAt: number
  registeredAt: number
  agents: DeviceAgent[]
  subscriptions: Subscription[]
  // 设备上装了 Project Agent Runtime，Project 助手才能在这台设备上运行。
  hasRuntime: boolean
  // 允许 Agent 访问的目录，在设备的 batond 配置里修改。
  folders: string[]
  repos: string[]
  // Project 助手能否在允许的目录里直接运行命令，以哪个系统用户和 shell 运行。
  commandAccess: { enabled: boolean; user: string; shell: string }
}

export type DeviceOS = 'macOS' | 'Windows' | 'Linux'

// 接入设备用的一次性设置码。凭据只在创建时返回一次，查询时不再带回。
export type EnrollmentState = 'pending' | 'connected' | 'expired' | 'used'

export interface Enrollment {
  id: ID
  state: EnrollmentState
  coordinatorUrl: string
  // 返回时距离过期还剩多少毫秒，页面按收到的时间倒计时，不依赖两边时钟一致。
  expiresIn: number
  // 连接成功后的设备。
  deviceId: ID | null
}

export interface IssuedEnrollment extends Enrollment {
  code: string
}

export type ThreadStatus = 'waiting' | 'running' | 'idle' | 'stopped' | 'unknown' | 'archived'

// Thread 停止的原因，决定页面给出的恢复办法。
// byYou：你停止，设备已确认；forced：Agent 一分钟内没有停下，设备结束了进程；
// interrupted：设备重启等原因中断，Agent 支持时可以恢复；historyLost：恢复时设备上找不到对话记录；
// folderMissing：设备上找不到目录；startFailed：Agent 没能启动。
export type StopKind = 'byYou' | 'forced' | 'interrupted' | 'historyLost' | 'folderMissing' | 'startFailed'

export interface ThreadStop {
  kind: StopKind
  // 设备报告的说明，例如找不到的目录或 Agent 的错误信息。
  detail: string | null
}

export interface Thread {
  id: ID
  title: string
  deviceId: ID
  folder: string
  agent: AgentKind
  model: string
  projectId: ID | null
  status: ThreadStatus
  stop: ThreadStop | null
  // 已提交、还在等设备确认的停止或归档。设备确认前 status 保持原样。
  pending: 'stop' | 'archive' | null
  // 最近一次停止或归档撤回的排队消息条数。
  stopCanceled: number
  createdAt: number
  updatedAt: number
  runStartedAt: number | null
  unread: boolean
}

// 一条消息从提交到被 Agent 读到的过程。unknown 表示设备在发送途中重启，不确定 Agent 是否收到，Baton 不会自动重发。
export type Delivery = 'submitted' | 'saved' | 'waitingDevice' | 'queued' | 'delivered' | 'withdrawn' | 'unknown'

// next 等当前回复结束后发送；now 在 Agent 支持时插入当前回复。
export type SendMode = 'next' | 'now'

export interface Message {
  id: ID
  threadId: ID
  role: 'user' | 'agent'
  // 发给 Agent 的消息可能来自你，也可能来自 Project Agent。
  sender: 'you' | 'projectAgent' | 'agent'
  body: string
  createdAt: number
  delivery: Delivery
}

export type ProjectStatus = 'active' | 'paused' | 'archived'

export type ProjectAgentState = 'idle' | 'running' | 'waitingDevice' | 'stopped'

export interface Project {
  id: ID
  name: string
  hue: 'slate' | 'amber' | 'violet' | 'green' | 'blue' | 'rose'
  status: ProjectStatus
  agent: {
    state: ProjectAgentState
    deviceId: ID | null
    // 等待设备或停止时，说明缺什么，例如 `An online device with ChatGPT signed in`。
    reason: string | null
  }
  createdAt: number
}

export type InboxStatus = 'pending' | 'answered' | 'closed' | 'withdrawn' | 'resolved'

export interface InboxItem {
  id: ID
  projectId: ID
  threadId: ID | null
  kind: 'question' | 'system'
  title: string
  body: string
  options: string[]
  status: InboxStatus
  answer: string | null
  // 每次处理都会递增，用来发现其他页面或设备已经处理过。
  revision: number
  createdAt: number
}

export type OperationKind =
  'createThread' | 'sendMessage' | 'stopThread' | 'archiveThread' | 'resumeThread' | 'answerItem'

// 操作确认的各个阶段，界面据此区分已提交、已保存、等待设备、执行中和已停止。
export type OperationPhase =
  | 'submitted'
  | 'saved'
  | 'waitingDevice'
  | 'queued'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'done'
  | 'conflict'
  | 'failed'

export interface Operation {
  id: ID
  kind: OperationKind
  targetId: ID
  phase: OperationPhase
  detail: string | null
  updatedAt: number
}

export type FilePreview =
  | { state: 'ready'; deviceId: ID; path: string; content: string }
  | { state: 'unavailable'; deviceId: ID; path: string; reason: 'offline' | 'syncing' | 'outsideFolders' | 'missing' }

// 设备上某个目录的子目录。path 为 null 时列出允许 Agent 访问的目录。
export type FolderListing =
  | { state: 'ready'; deviceId: ID; path: string | null; folders: string[] }
  | {
      state: 'unavailable'
      deviceId: ID
      path: string | null
      reason: 'offline' | 'syncing' | 'outsideFolders' | 'missing'
    }
