import type {
  AgentKind,
  Device,
  Enrollment,
  FilePreview,
  FolderListing,
  ID,
  InboxItem,
  IssuedEnrollment,
  Message,
  Operation,
  Project,
  SendMode,
  Session,
  Thread,
} from './types'

// 数据变化按主题通知，页面据此刷新对应的查询。
export type Topic = 'session' | 'devices' | 'projects' | 'threads' | 'messages' | 'inbox' | 'files' | 'operations'

export interface ChangeEvent {
  topics: Topic[]
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
  getSession(): Promise<Session>
  signIn(username: string, password: string): Promise<Session>
  signOut(): Promise<void>

  listDevices(): Promise<Device[]>
  listProjects(): Promise<Project[]>
  listThreads(): Promise<Thread[]>
  listMessages(threadId: ID): Promise<Message[]>
  listInbox(): Promise<InboxItem[]>
  readFile(deviceId: ID, path: string): Promise<FilePreview>
  listFolders(deviceId: ID, path: string | null): Promise<FolderListing>
  getOperation(id: ID): Promise<Operation>

  // 网页上新建的对话不属于任何 Project。返回的操作 targetId 是新 Thread 的 ID。
  createThread(input: {
    deviceId: ID
    folder: string
    agent: AgentKind
    model: string
    body: string
    clientId: string
  }): Promise<Operation>
  sendMessage(input: { threadId: ID; body: string; clientId: string; mode?: SendMode }): Promise<Operation>
  // 撤回还没发给 Agent 的消息；已经发出时返回 conflict。
  cancelMessage(messageId: ID): Promise<Message>
  // 换模型从下一轮开始生效，Agent 不支持换模型时返回 invalid。
  setThreadModel(input: { threadId: ID; model: string }): Promise<Thread>
  stopThread(threadId: ID): Promise<Operation>
  // 执行中的 Thread 先停止，设备确认后才归档。
  archiveThread(threadId: ID): Promise<Operation>
  resumeThread(threadId: ID): Promise<Operation>
  answerItem(input: { itemId: ID; answer: string; revision: number }): Promise<Operation>

  setDefaultDevice(deviceId: ID): Promise<Session>
  setCommandAccess(input: { deviceId: ID; enabled: boolean }): Promise<Device>
  // 返回时中心已经拒绝这台设备的新连接并关闭了当前连接。
  removeDevice(deviceId: ID): Promise<void>
  createEnrollment(): Promise<IssuedEnrollment>
  getEnrollment(id: ID): Promise<Enrollment>

  subscribe(listener: (event: ChangeEvent) => void): () => void
}
