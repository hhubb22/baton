import type {
  Device,
  FilePreview,
  ID,
  InboxItem,
  Message,
  Operation,
  Project,
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
  getOperation(id: ID): Promise<Operation>

  sendMessage(input: { threadId: ID; body: string; clientId: string }): Promise<Operation>
  stopThread(threadId: ID): Promise<Operation>
  answerItem(input: { itemId: ID; answer: string; revision: number }): Promise<Operation>

  subscribe(listener: (event: ChangeEvent) => void): () => void
}
