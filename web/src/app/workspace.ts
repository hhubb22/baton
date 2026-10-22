import { createContext, useContext } from 'react'

// 工作区布局提供给侧栏和页面标题栏的状态。
export interface Workspace {
  collapsed: boolean
  toggleSidebar(): void
  signingOut: boolean
  signOut(): void
  // 打开新建 Project 弹窗。
  newProject(): void
}

export const WorkspaceContext = createContext<Workspace | null>(null)

export function useWorkspace() {
  const workspace = useContext(WorkspaceContext)
  if (!workspace) throw new Error('useWorkspace must be used inside WorkspaceLayout')
  return workspace
}
