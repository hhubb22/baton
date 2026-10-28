// 界面使用的业务对象。字段按 specs/baton、specs/project-agent、specs/agent-inbox 的行为规格取名，
// 对象之间只用稳定 ID 关联，派生状态见 derive.ts。

import type { MemoryEmbeddingConfig, MemoryEmbeddingConfigInput, ThreadTraceStep } from '@baton/protocol'

export type ID = string

export type AgentKind = 'codex' | 'kiro' | 'pi' | 'cursor'

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
  mustChangePassword?: boolean
}

// 连接成功、状态同步完成和 Thread 执行状态分开表示。
export type DeviceConnection = 'online' | 'syncing' | 'offline'

export interface AgentAbilities {
  create: boolean
  queue: boolean
  steer: boolean
  stop: boolean
  resume: boolean
  switchModel: boolean
}

export interface DeviceAgent {
  kind: AgentKind
  status: string
  reason: string | null
  version: string | null
  models: string[]
  defaultModel: string | null
  abilities: AgentAbilities
  // 登录 Agent 使用的订阅，例如 Codex 用 ChatGPT；不需要登录的 Agent 为 null。
  account: string | null
  // 程序没装或订阅登录过期时新对话不可用，要在设备上处理。
  problem: 'notInstalled' | 'signedOut' | 'unavailable' | null
}

export interface Subscription {
  provider: string
  providerId?: string
  loginMethods?: ('oauth' | 'api_key' | 'device_code')[]
  signedIn: boolean
  status?: 'available' | 'login_required' | 'unknown'
  reason?: string | null
  models?: string[]
}

export interface ModelConnection {
  id: string
  name: string
  protocol: 'openai-responses' | 'openai-completions' | 'anthropic-messages'
  base_url: string
  models: string[]
  keyNeeded: boolean
  modelsTruncated?: boolean
}

export interface SubscriptionLoginChallenge {
  provider: string
  verificationUri: string
  userCode: string
  expiresInSeconds: number
}

export interface Device {
  id: ID
  name: string
  os: DeviceOS
  // 系统版本，例如 `macOS 15.0.1`、`Ubuntu 24.04`。
  system: string
  batondVersion: string
  connection: DeviceConnection
  upgradeState?: {
    operationId: string
    sourceVersion: string
    targetVersion: string
    phase: 'draining' | 'ready' | 'migrating' | 'syncing' | 'completed' | 'cancelled' | 'failed'
  } | null
  credentialState?: 'active' | 'idle_expired' | 'revoked'
  idleExpiresAt?: number
  lastSeenAt: number
  registeredAt: number
  agents: DeviceAgent[]
  subscriptions: Subscription[]
  modelConnections?: ModelConnection[]
  // 设备上装了 Project Agent Runtime，Project 助手才能在这台设备上运行。
  hasRuntime: boolean
  // 允许 Agent 访问的目录，可在网页或设备本机管理。
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

export type { ThreadQuestion, ThreadAnswerInput } from '@baton/protocol'

export interface Thread {
  pendingQuestions?: import('@baton/protocol').ThreadQuestion[]
  questionAnswers?: import('@baton/protocol').ThreadQuestionAnswer[]
  id: ID
  title: string
  deviceId: ID
  folder: string
  agent: AgentKind | null
  model: string
  executionTimeoutSeconds?: number
  projectId: ID | null
  status: ThreadStatus
  stop: ThreadStop | null
  // 已提交、还在等设备确认的停止或归档。设备确认前 status 保持原样。
  pending: 'stop' | 'archive' | null
  // 最近一次停止设备没有执行（拒绝了命令，或命令在恢复备份后不再发送），可以再停一次。此时 pending 为 null。
  stopFailed?: boolean
  // 尚未收到实际打开或恢复完成的执行结果。
  starting?: boolean
  resumePending?: boolean
  retryOpenAllowed?: boolean
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

export interface FullOutputReference {
  id: string
  storage_generation: string
  total_bytes: number
  expires_at: string
}

export interface Message {
  id: ID
  threadId: ID
  role: 'user' | 'agent' | 'failure' | 'activity'
  // 发给 Agent 的消息可能来自你，也可能来自 Project Agent。
  sender: 'you' | 'projectAgent' | 'agent'
  body: string
  createdAt: number
  delivery: Delivery
  // 一轮实际做过的事的摘要；过程从中心读取。
  activity: ActivitySummary | null
  // 结束记录的步骤数。0 表示此消息不承载过程入口，同轮只在一条消息上展示。
  traceItemCount?: number
  fullOutput?: FullOutputReference | null
  attachments: Attachment[]
}

export interface ActivitySummary {
  commands: number
  tools: number
  files: number
}

// 回复附带的文件或代码提交。文件写明所在设备，能否打开由设备状态决定；提交写明仓库和完整 SHA，之后工作区变化不影响它。
export type Attachment =
  | { kind: 'file'; deviceId: ID; path: string; size: number }
  | { kind: 'commit'; repo: string; sha: string; subject: string }

// 中心保存的上游步骤，截断内容的全文引用指向设备。
export type TraceStep = ThreadTraceStep

export type Trace =
  | { state: 'ready'; messageId: ID; steps: TraceStep[]; nextCursor?: string }
  | { state: 'unavailable'; messageId: ID; reason: 'missing' }

// 执行中的一轮的实时输出。gap 表示设备已经丢掉、补不回来的一段。
export type OutputChunk = { kind: 'text'; text: string } | { kind: 'gap' }

export interface LiveOutput {
  threadId: ID
  chunks: OutputChunk[]
}

// 选中一段内容去问 Project 助手时带上的来源。Thread 回复写 Thread 和第几条回复；文件再写设备、路径和行号；事项写事项 ID。
export interface Reference {
  kind: 'thread' | 'file' | 'item'
  // 来源的名字：Thread 标题、文件名或事项标题。
  title: string
  threadId: ID | null
  // 第几条 Agent 回复，从 1 开始。
  reply: number | null
  deviceId: ID | null
  path: string | null
  lines: { from: number; to: number } | null
  itemId: ID | null
  // 选中的文字。超过 8 KiB 时只保留开头。
  excerpt: string
  // 选中文字原来的 UTF-8 字节数。
  bytes: number
}

export type ProjectStatus = 'active' | 'paused' | 'archived'

// notStarted：新建后还没收到第一条消息；stopping：已请求停止，等设备确认。
export type ProjectAgentState = 'notStarted' | 'idle' | 'running' | 'waitingDevice' | 'stopping' | 'stopped' | 'blocked'

export interface Project {
  id: ID
  name: string
  hue: 'slate' | 'amber' | 'violet' | 'green' | 'blue' | 'rose'
  status: ProjectStatus
  archivedAt: number | null
  goal: string
  // Project 助手使用的订阅和模型，修改后从下一次运行开始生效。
  subscription: string
  sourceNodeId?: string | null
  model: string
  memoryEmbedding: MemoryEmbeddingConfig | null
  agent: {
    state: ProjectAgentState
    // 正在运行或最近一次运行所在的设备。
    deviceId: ID | null
    // 等待设备或出错停止时，说明缺什么，例如 `An online device with ChatGPT signed in`。你停止时为 null。
    reason: string | null
    // 运行中正在做的事，例如 `Reading your message…`，显示在主对话末尾。
    activity: string | null
  }
  createdAt: number
}

export type ProjectPatch = Partial<Pick<Project, 'name' | 'goal' | 'subscription' | 'model' | 'sourceNodeId'>> & {
  memoryEmbedding?: MemoryEmbeddingConfigInput | null
}

// 助手一次运行中做过的事，折叠在回复上方。
export type ProcessStep =
  | { kind: 'command'; deviceId: ID; command: string; exitCode: number; output: string; durationMs: number }
  | { kind: 'note'; body: string }

// 回复里提到的 Thread：本次新开的、发了消息的，或汇报回复的。
export interface EntryThreads {
  action: 'opened' | 'messaged' | 'replies'
  threadIds: ID[]
}

interface EntryBase {
  id: ID
  projectId: ID
  createdAt: number
}

// 主对话的一条记录：你的消息、助手的一轮回复，或系统说明（切换设备、停止等）。
export type ProjectEntry =
  | (EntryBase & { kind: 'user'; body: string; delivery: Delivery; reference: Reference | null })
  | (EntryBase & { kind: 'assistant'; process: ProcessStep[]; threads: EntryThreads | null; body: string })
  | (EntryBase & { kind: 'note'; body: string })

export interface MemoryVersion {
  details?: {
    action: string
    reason: string
    validFrom: string | null
    validUntil: string | null
    retracted: boolean
    evidence: readonly { source_id: string; start_byte: number; end_byte: number; source_hash: string }[]
  }
  version: number
  body: string
  source: 'you' | 'assistant'
  updatedAt: number
}

// 记忆保留各次保存的版本；顶层字段表示最新版本。
export interface MemoryNote extends MemoryVersion {
  id: ID
  projectId: ID
  versions: MemoryVersion[]
  status: 'candidate' | 'active' | 'superseded' | 'disputed' | 'retired'
  effective: boolean
  topic: string
  suppressionId: string | null
  evidence: readonly { source_id: string; start_byte: number; end_byte: number; source_hash: string }[]
}

export interface SaveMemoryInput {
  projectId: ID
  noteId: ID | null
  body: string
  version: number | null
  clientId: string
}

export interface ChangeMemoryInput {
  projectId: ID
  noteId: ID
  version: number
  action: 'retire' | 'restore'
  clientId: string
  suppressionId: string | null
}
export interface MemorySourceView {
  id: string
  role: string
  text: string
  source_seq: number | null
  suppressed: boolean
}

export type MemorySave = { state: 'saved' | 'conflict'; note: MemoryNote }

export type InboxStatus = 'pending' | 'answered' | 'closed' | 'withdrawn' | 'resolved'

export interface InboxItem {
  id: ID
  projectId: ID
  threadId: ID | null
  kind: 'question' | 'system'
  title: string
  body: string
  options: string[]
  recommended: number | null
  allowText: boolean
  status: InboxStatus
  result: {
    option: string | null
    note: string
    actor: string
    at: number
    reason: string | null
    inputId: ID | null
  } | null
  // 每次处理都会递增，用来发现其他页面或设备已经处理过。
  revision: number
  createdAt: number
}

export type ItemDecision = { kind: 'answer'; option: string | null; note: string } | { kind: 'close' }

export type OperationKind =
  | 'createThread'
  | 'sendMessage'
  | 'stopThread'
  | 'archiveThread'
  | 'resumeThread'
  | 'answerItem'

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

// 文件预览每次最多读取的字节数。
export const previewLimit = 64 * 1024

// 续读同时携带偏移和版本，避免拼接不同版本的文件。
export interface FileReadOptions {
  offset: number
  version: string
}

// 文件的文本片段；nextOffset 表示同一版本下一片的 UTF-8 字节偏移。
export type FilePreview =
  | {
      state: 'ready'
      deviceId: ID
      path: string
      size: number
      content: string
      truncated: boolean
      offset: number
      version: string
      nextOffset?: number
    }
  | {
      state: 'unavailable'
      deviceId: ID
      path: string
      reason: 'offline' | 'syncing' | 'outsideFolders' | 'missing' | 'binary'
      size: number | null
    }

export interface FileEntry {
  path: string
  size: number
}

// 设备上某个目录的子目录和文件。path 为 null 时列出允许 Agent 访问的目录。
export type FolderListing =
  | { state: 'ready'; deviceId: ID; path: string | null; folders: string[]; files: FileEntry[]; scanLimited: boolean }
  | {
      state: 'unavailable'
      deviceId: ID
      path: string | null
      reason: 'offline' | 'syncing' | 'outsideFolders' | 'missing'
    }
