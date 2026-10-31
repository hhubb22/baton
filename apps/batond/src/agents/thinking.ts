import { Option, Schema } from 'effect'
import type { ModelCapabilities } from '@t3tools/contracts'
import { ThinkingCapability } from '@baton/protocol'

/** Preserve the thinking choices advertised by the provider for this model. */
export function thinkingCapability(capabilities: ModelCapabilities | null | undefined) {
  const descriptor = capabilities?.optionDescriptors?.find(
    (option) =>
      option.type === 'select' &&
      (option.id === 'thinking' || option.id === 'reasoningEffort' || option.id === 'effortLevel'),
  )
  if (!descriptor || descriptor.type !== 'select' || descriptor.options.length === 0) return undefined
  const decoded = Schema.decodeUnknownOption(ThinkingCapability)({
    id: descriptor.id,
    options: descriptor.options.map((option) => ({
      id: option.id,
      label: option.label,
      ...(option.isDefault === undefined ? {} : { is_default: option.isDefault }),
    })),
    ...(descriptor.currentValue === undefined ? {} : { current_value: descriptor.currentValue }),
  })
  return Option.getOrUndefined(decoded)
}
