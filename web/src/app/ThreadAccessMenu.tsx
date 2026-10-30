import type { RuntimeMode } from '@baton/protocol'
import type { DeviceAgent } from '../data/types'
import { Chip } from '../ui/Chip'
import { Menu, MenuOption } from '../ui/Menu'

const modes: Record<RuntimeMode, { label: string; detail: string }> = {
  'approval-required': { label: 'Supervised', detail: '需要时等待批准操作。' },
  'auto-accept-edits': { label: 'Auto-accept edits', detail: '自动接受编辑，其他操作可能需要批准。' },
  auto: { label: 'Auto', detail: '支持的助手自动审查常规操作，其他助手可能仍需要批准。' },
  'full-access': {
    label: 'Full access',
    detail: '可以按设备用户权限访问目录外文件和网络，实际能力受原生程序和操作系统限制。',
  },
}

export function ThreadAccessMenu({
  mode,
  agent,
  onSelect,
  side = 'bottom',
}: {
  mode: RuntimeMode
  agent?: DeviceAgent
  onSelect?: (mode: RuntimeMode) => void
  side?: 'top' | 'bottom'
}) {
  const reported = agent?.runtimeModes ?? []
  const options = onSelect
    ? reported.some((option) => option.id === mode)
      ? reported
      : [{ id: mode, available: false, reason: '设备未报告此模式。' }, ...reported]
    : [{ id: mode, available: true }]
  const noSandbox = agent && (agent.kind === 'pi' || agent.kind === 'kiro')
  return (
    <Menu
      side={side}
      trigger={
        <Chip icon="shield" composer>
          {modes[mode].label}
        </Chip>
      }
    >
      {options.length === 0 && <MenuOption detail="设备尚未报告执行权限。">执行权限不可用</MenuOption>}
      {options.map((option) => (
        <MenuOption
          key={option.id}
          selected={mode === option.id}
          detail={
            option.available
              ? `${modes[option.id].detail}${noSandbox && option.id !== 'full-access' ? ' 此助手不提供系统沙箱。' : ''}`
              : (option.reason ?? '此模式不可用。')
          }
          onSelect={onSelect && option.available ? () => onSelect(option.id) : undefined}
        >
          {modes[option.id].label}
        </MenuOption>
      ))}
    </Menu>
  )
}
