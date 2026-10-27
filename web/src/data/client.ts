import type { ActivitySnapshot, BrowserEvent, BrowserNotification, MemoryWorkStatus } from '@baton/protocol'
import type { DownloadsResponse } from '@baton/protocol/http-api'
import type {
  AgentKind,
  Device,
  Enrollment,
  FilePreview,
  FileReadOptions,
  FolderListing,
  ID,
  InboxItem,
  ItemDecision,
  IssuedEnrollment,
  LiveOutput,
  MemoryNote,
  MemorySave,
  SaveMemoryInput,
  ChangeMemoryInput,
  MemorySourceView,
  ProjectPatch,
  Message,
  Operation,
  Project,
  ProjectEntry,
  Reference,
  SendMode,
  Session,
  SubscriptionLoginChallenge,
  Thread,
  ThreadAnswerInput,
  Trace,
} from './types'

// 数据变化按主题通知；带对象的通知只刷新该对象及共享列表。
export type Topic = 'session' | 'devices' | 'projects' | 'threads' | 'messages' | 'inbox' | 'files' | 'operations'

export interface ChangeEvent {
  topics: Topic[]
  target?: { type: 'thread' | 'project'; id: ID }
  browserEvent?: BrowserEvent
}

export interface NotificationReplay {
  events: BrowserNotification[]
  cursor: string
  has_more: boolean
}

export class ClientError extends Error {
  // unavailable 表示没有连上 Baton，请求结果未知，可以原样重试。
  readonly code: 'unauthorized' | 'notFound' | 'conflict' | 'invalid' | 'unavailable'

  constructor(code: ClientError['code'], message: string) {
    super(message)
    this.code = code
  }
}

// 页面只通过这个接口读写数据。模拟实现见 mock/，接入后端时换成真实实现。
export interface BatonClient {
  readonly mode?: 'http' | 'mock'
  getDownloads(): Promise<DownloadsResponse>
  replayNotifications?(after?: string): Promise<NotificationReplay>
  getActivity?(): Promise<ActivitySnapshot>
  getSession(): Promise<Session>
  signIn(username: string, password: string): Promise<Session>
  signOut(): Promise<void>
  changePassword(currentPassword: string, newPassword: string): Promise<Session>

  listDevices(): Promise<Device[]>
  listDeviceFolders(deviceId: ID): Promise<string[]>
  listProjects(): Promise<Project[]>
  getProject(projectId: ID): Promise<Project>
  // Project 主对话：你的消息、助手的回复和系统说明，按时间排列。
  listProjectEntries(projectId: ID): Promise<ProjectEntry[]>
  listProjectMemory(projectId: ID): Promise<MemoryNote[]>
  getMemoryStatus(projectId: ID): Promise<MemoryWorkStatus>
  listThreads(): Promise<Thread[]>
  getThread(threadId: ID): Promise<Thread>
  listMessages(threadId: ID): Promise<Message[]>
  listInbox(): Promise<InboxItem[]>
  readFile(deviceId: ID, path: string, continuation?: FileReadOptions): Promise<FilePreview>
  // 按中心返回的游标读取过程，设备离线时仍可读取。
  readTrace(messageId: ID, cursor?: string): Promise<Trace>
  // 执行中的一轮的实时输出，这一轮结束后为空。
  readOutput(threadId: ID): Promise<LiveOutput>
  // 推送输出快照；null 表示连接或读取状态变化，需要重读。返回函数取消订阅。
  subscribeOutput?(threadId: ID, listener: (output: LiveOutput | null) => void): () => void
  listFolders(deviceId: ID, path: string | null): Promise<FolderListing>
  getOperation(id: ID): Promise<Operation>

  // 网页上新建的对话不属于任何 Project。返回的操作 targetId 是新 Thread 的 ID。
  createThread(input: {
    deviceId: ID
    folder: string
    agent: AgentKind
    model: string
    executionTimeoutSeconds?: number
    body: string
    clientId: string
  }): Promise<Operation>
  sendMessage(input: { threadId: ID; body: string; clientId: string; mode?: SendMode }): Promise<Operation>
  // 撤回还没发给 Agent 的消息；已经发出时返回 conflict。
  cancelMessage(messageId: ID): Promise<Message>
  // 换模型从下一轮开始生效，Agent 不支持换模型时返回 invalid。
  setThreadExecutionLimit(input: { threadId: ID; executionTimeoutSeconds: number }): Promise<Thread>
  setThreadModel(input: { threadId: ID; model: string }): Promise<Thread>
  answerThreadQuestion(input: { threadId: ID; answer: ThreadAnswerInput }): Promise<Thread>
  stopThread(threadId: ID): Promise<Operation>
  // 执行中的 Thread 先停止，设备确认后才归档。
  archiveThread(threadId: ID): Promise<Operation>
  resumeThread(threadId: ID): Promise<Operation>
  // 同一个 clientId 重试时返回第一次新建的 Project。
  createProject(input: {
    name: string
    goal: string
    subscription: string
    model: string
    clientId: string
  }): Promise<Project>
  // 消息先保存；没有设备能运行助手时一直等待，不会过期。
  // reference 是从回复、文件或事项里选中的一段，作为普通消息的一部分发给助手。
  sendProjectMessage(input: {
    projectId: ID
    body: string
    clientId: string
    reference?: Reference | null
  }): Promise<ProjectEntry>
  updateProject(input: { projectId: ID; patch: ProjectPatch }): Promise<Project>
  setProjectStatus(input: { projectId: ID; status: 'active' | 'paused' | 'archived' }): Promise<Project>
  saveMemory(input: SaveMemoryInput): Promise<MemorySave>
  changeMemory(input: ChangeMemoryInput): Promise<MemorySave>
  memorySources(projectId: ID, note: MemoryNote): Promise<MemorySourceView[]>
  // 只停止助手这一次运行，它开的 Thread 继续执行。
  stopProjectRun(projectId: ID): Promise<Project>
  handleItem(input: { itemId: ID; decision: ItemDecision; revision: number }): Promise<Operation>
  // 重试解除系统阻塞，同时解决尚未关闭的系统通知，不产生事项回答。
  retryProject(projectId: ID): Promise<Project>

  setDefaultDevice(deviceId: ID): Promise<Session>
  addDeviceFolder(input: { deviceId: ID; path: string }): Promise<Device>
  removeDeviceFolder(input: { deviceId: ID; path: string }): Promise<Device>
  startSubscriptionLogin(input: { deviceId: ID; provider: string }): Promise<SubscriptionLoginChallenge>
  setCommandAccess(input: { deviceId: ID; enabled: boolean }): Promise<Device>
  // 返回时中心已经拒绝这台设备的新连接并关闭了当前连接。
  removeDevice(deviceId: ID): Promise<void>
  createEnrollment(nodeId?: ID): Promise<IssuedEnrollment>
  getEnrollment(id: ID): Promise<Enrollment>

  subscribe(listener: (event: ChangeEvent) => void): () => void
}
