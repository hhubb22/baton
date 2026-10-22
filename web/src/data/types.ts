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
  // 缺少程序、认证或配置时的具体缺项，例如 `codex not found`。
  missing: string | null
}

export interface Subscription {
  provider: string
  signedIn: boolean
}

export interface Device {
  id: ID
  name: string
  os: 'macOS' | 'Windows' | 'Linux'
  connection: DeviceConnection
  lastSeenAt: number
  registeredAt: number
  agents: DeviceAgent[]
  subscriptions: Subscription[]
  hasRuntime: boolean
  folders: string[]
  repos: string[]
  commandAccess: { enabled: boolean; user: string; shell: string }
}

export type ThreadStatus = 'waiting' | 'running' | 'idle' | 'stopped' | 'unknown' | 'archived'

export interface Thread {
  id: ID
  title: string
  deviceId: ID
  folder: string
  agent: AgentKind
  model: string
  projectId: ID | null
  status: ThreadStatus
  stopReason: string | null
  createdAt: number
  updatedAt: number
  runStartedAt: number | null
  unread: boolean
}

// 一条消息从提交到被 Agent 读到的过程。
export type Delivery = 'submitted' | 'saved' | 'waitingDevice' | 'queued' | 'delivered' | 'withdrawn'

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

export type OperationKind = 'sendMessage' | 'stopThread' | 'answerItem'

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
