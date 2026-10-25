import type {
  Device,
  EnrollmentState,
  ID,
  InboxItem,
  MemoryNote,
  Message,
  Operation,
  OutputChunk,
  Project,
  ProjectEntry,
  ProjectPatch,
  Session,
  Thread,
  TraceStep,
} from '../types'

export type PassiveInput = { projectId: ID; updatedAt: number } & (
  | { kind: 'settings'; patch: Pick<ProjectPatch, 'name' | 'goal'> }
  | { kind: 'memory'; noteId: ID; version: number; body: string }
)

export interface AssistantContext {
  subscription: string
  model: string
  passiveInputs: PassiveInput[]
}

// 模拟后端的完整状态。场景只负责生成初始 World，状态变化规则都在 store.ts。
export interface World {
  session: Session
  devices: Device[]
  projects: Project[]
  projectEntries: ProjectEntry[]
  memory: MemoryNote[]
  // 等下一次主动输入一起交给助手的修改；同一记忆只保留最新版本。
  passiveInputs: PassiveInput[]
  // 各项目最近一次启动时读取的配置和被动输入。
  assistantContexts: Record<ID, AssistantContext>
  threads: Thread[]
  messages: Message[]
  inbox: InboxItem[]
  operations: Operation[]
  // 设备上的文件，键为 `设备 ID:路径`。text 为 null 表示二进制文件，文本文件保存完整内容。
  files: Record<string, DeviceFile>
  // 设备上保存的每轮回复过程，键为回复的消息 ID。
  traces: Record<ID, TraceStep[]>
  // 执行中的一轮的实时输出，键为 Thread ID。中心只为传输暂存，这一轮结束后清掉。
  outputs: Record<ID, OutputChunk[]>
  // 重连后补不齐输出的 Thread：设备回来时在输出里标出缺口。
  outputLoss: ID[]
  // 下一次读取会失败一次的内容，键为 `trace:消息 ID` 或 `file:设备 ID:路径`。
  failingReads: string[]
  // 已在其他页面或设备上处理过的事项，下一次回答时返回冲突。
  answeredElsewhere: Record<ID, string>
  withdrawnElsewhere: Record<ID, string>
  failItemSaves: number
  enrollments: EnrollmentRecord[]
  // 设备上实际存在的目录（完整路径），用来列出子目录和发现找不到的目录。
  directories: Record<ID, string[]>
  // Agent 收到停止请求后不会自己停下的 Thread，设备一分钟后结束进程。
  stubbornStops: ID[]
  // 设备上已经找不到对话记录的 Thread，恢复时失败。
  lostHistory: ID[]
  // 接下来这么多次新建 Project 会保存失败，用来演示失败后重试。
  failProjectSaves: number
  failSettingsSaves: number
  failMemorySaves: number
  failStatusSaves: number
  // 首次编辑这些记忆时，助手先保存一个新版本。
  memoryElsewhere: Record<ID, string>
}

export interface EnrollmentRecord {
  id: ID
  code: string
  state: EnrollmentState
  expiresAt: number
  deviceId: ID | null
}

export interface DeviceFile {
  size: number
  text: string | null
}

export function fileKey(deviceId: ID, path: string) {
  return `${deviceId}:${path}`
}
