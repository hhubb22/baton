import type { Device, EnrollmentState, ID, InboxItem, Message, Operation, Project, Session, Thread } from '../types'

// 模拟后端的完整状态。场景只负责生成初始 World，状态变化规则都在 store.ts。
export interface World {
  session: Session
  devices: Device[]
  projects: Project[]
  threads: Thread[]
  messages: Message[]
  inbox: InboxItem[]
  operations: Operation[]
  // 设备上可预览的文件，键为 `设备 ID:路径`。
  files: Record<string, string>
  // 已在其他页面或设备上处理过的事项，下一次回答时返回冲突。
  answeredElsewhere: Record<ID, string>
  enrollments: EnrollmentRecord[]
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
