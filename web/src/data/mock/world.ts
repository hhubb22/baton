import type {
  Device,
  EnrollmentState,
  ID,
  InboxItem,
  MemoryNote,
  Message,
  Operation,
  Project,
  ProjectEntry,
  Session,
  Thread,
} from '../types'

// 模拟后端的完整状态。场景只负责生成初始 World，状态变化规则都在 store.ts。
export interface World {
  session: Session
  devices: Device[]
  projects: Project[]
  projectEntries: ProjectEntry[]
  memory: MemoryNote[]
  threads: Thread[]
  messages: Message[]
  inbox: InboxItem[]
  operations: Operation[]
  // 设备上可预览的文件，键为 `设备 ID:路径`。
  files: Record<string, string>
  // 已在其他页面或设备上处理过的事项，下一次回答时返回冲突。
  answeredElsewhere: Record<ID, string>
  enrollments: EnrollmentRecord[]
  // 设备上实际存在的目录（完整路径），用来列出子目录和发现找不到的目录。
  directories: Record<ID, string[]>
  // Agent 收到停止请求后不会自己停下的 Thread，设备一分钟后结束进程。
  stubbornStops: ID[]
  // 设备上已经找不到对话记录的 Thread，恢复时失败。
  lostHistory: ID[]
  // 接下来这么多次新建 Project 会保存失败，用来演示失败后重试。
  failProjectSaves: number
}

export interface EnrollmentRecord {
  id: ID
  code: string
  state: EnrollmentState
  expiresAt: number
  deviceId: ID | null
}

export function fileKey(deviceId: ID, path: string) {
  return `${deviceId}:${path}`
}
