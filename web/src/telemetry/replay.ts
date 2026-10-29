import { replayStyleProperties, sanitizeReplay as sanitize } from '@baton/telemetry/replay'

export function sanitizeReplay(value: unknown, lookup?: (id: number) => Node | null): unknown {
  return sanitize(value, (id) => {
    const node = lookup?.(id)
    if (!(node instanceof Element)) return undefined
    const computed = getComputedStyle(node)
    return replayStyleProperties
      .map((property) => `${property}:${computed.getPropertyValue(property).trim()}`)
      .join(';')
  })
}
