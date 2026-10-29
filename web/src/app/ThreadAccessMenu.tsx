import { agentNames } from '../data/derive'
import type { AgentKind } from '../data/types'
import { Chip } from '../ui/Chip'
import { Menu, MenuOption } from '../ui/Menu'

interface ThreadAccess {
  label: string
  detail: string
}

// 每个 Agent 目前只有一种执行权限，跟随设备上的 driver：Codex 在 workspaceWrite 沙箱里且不能联网，
// Cursor 用 SDK 自带沙箱，Pi 和 Kiro 不带沙箱，以设备用户身份运行。
export function threadAccess(agent: AgentKind, user: string): ThreadAccess {
  switch (agent) {
    case 'codex':
      return { label: '沙箱', detail: '可以修改此文件夹内的文件，不能联网。' }
    case 'cursor':
      return { label: '沙箱', detail: '在 Cursor 沙箱中运行命令。' }
    case 'pi':
    case 'kiro':
      return {
        label: '无沙箱',
        detail: `${agentNames[agent]} 以${user ? ` ${user} ` : '当前用户'}身份运行命令，可以访问此文件夹以外的文件。`,
      }
  }
}

// 权限选择片：新建时和 Thread 输入区都显示当前模式，菜单只列这个 Agent 支持的模式。
export function ThreadAccessMenu({
  agent,
  user,
  side = 'bottom',
}: {
  agent: AgentKind
  user: string
  side?: 'top' | 'bottom'
}) {
  const access = threadAccess(agent, user)
  return (
    <Menu
      side={side}
      trigger={
        <Chip icon="shield" composer>
          {access.label}
        </Chip>
      }
    >
      <MenuOption selected detail={access.detail}>
        {access.label}
      </MenuOption>
    </Menu>
  )
}
