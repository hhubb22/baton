import { createContext, useContext } from 'react'
import type { ID, Reference } from '../data/types'

// 工作区布局提供给侧栏和页面标题栏的状态。
export interface Workspace {
  collapsed: boolean
  toggleSidebar(): void
  signingOut: boolean
  signOut(): void
  // 打开新建 Project 弹窗。
  newProject(): void
  // 选中内容后准备发给 Project 助手的引用，按 Project 保存，发送或移除后清空。
  references: Record<ID, Reference>
  // 把引用放进 Project 输入区并打开这个 Project；已经在这个 Project 页时不跳转。
  askProject(projectId: ID, reference: Reference): void
  clearReference(projectId: ID): void
}

export const WorkspaceContext = createContext<Workspace | null>(null)

export function useWorkspace() {
  const workspace = useContext(WorkspaceContext)
  if (!workspace) throw new Error('useWorkspace must be used inside WorkspaceLayout')
  return workspace
}
