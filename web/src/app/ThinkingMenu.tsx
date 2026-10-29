import type { ThinkingCapability, ThinkingSelection } from '@baton/protocol'
import type { DeviceAgent } from '../data/types'
import { Chip } from '../ui/Chip'
import { Menu, MenuHeading, MenuOption } from '../ui/Menu'

const labels: Record<string, string> = {
  off: '关闭',
  none: '关闭',
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
}

export function modelThinking(agent: DeviceAgent | undefined, model: string) {
  const catalog = agent?.modelThinking
  return catalog && Object.hasOwn(catalog, model) ? catalog[model] : undefined
}

function optionLabel(option: { id: string; label: string }) {
  return Object.hasOwn(labels, option.id) ? labels[option.id]! : option.label
}

export function ThinkingMenu({
  capability,
  selection,
  onSelect,
  side = 'bottom',
  lockedReason,
}: {
  capability?: ThinkingCapability
  selection?: ThinkingSelection | null
  onSelect: (value: ThinkingSelection | null) => void
  side?: 'top' | 'bottom'
  lockedReason?: string
}) {
  const selected =
    capability && selection && capability.id === selection.id
      ? capability.options.find((item) => item.id === selection.value)
      : undefined
  const label = lockedReason ? '当前回复' : selected ? optionLabel(selected) : '默认'
  return (
    <Menu
      side={side}
      narrow
      trigger={
        <Chip icon="reasoning" composer aria-label={`思考强度：${label}`}>
          {label}
        </Chip>
      }
    >
      <MenuHeading>思考强度</MenuHeading>
      {lockedReason ? (
        <MenuOption>{lockedReason}</MenuOption>
      ) : capability ? (
        <>
          <MenuOption selected={!selected} onSelect={() => onSelect(null)}>
            默认
          </MenuOption>
          {capability.options.map((option) => (
            <MenuOption
              key={option.id}
              selected={selected?.id === option.id}
              note={option.is_default || option.id === capability.current_value ? '默认' : undefined}
              onSelect={() => onSelect({ id: capability.id, value: option.id })}
            >
              {optionLabel(option)}
            </MenuOption>
          ))}
        </>
      ) : (
        <MenuOption>此模型未提供思考强度选项</MenuOption>
      )}
    </Menu>
  )
}
